/**
 * 今日食签 v0.5 · 统一后端（Cloudflare Workers / ES Module 格式）
 * =============================================================================
 * 一个 Worker 同时负责三件事：
 *
 *   1. /api/v1/chat          问食神：DeepSeek Search 联网 → deepseek-flash 出签
 *   2. /api/v1/platform/*    聚合美团 / 淘宝闪购的附近团购商品（Key 全在服务端）
 *   3. /api/v1/health        自检：哪些平台配好了、今日还剩多少额度
 *
 * 设计约束（都是踩过坑才这么写的）：
 *   - **任何外部依赖挂掉都不能让页面白屏**：chat 失败前端降级本地食神，
 *     平台失败只影响那一个平台的区块，各自独立 allSettled。
 *   - **Key 永不进仓库**：全部走 wrangler secret。
 *   - **花钱的事必须可观测**：每次调用都按 token / 调用次数记账，
 *     超预算直接 429，并在 health 里可见。
 *   - **CORS 白名单**：只允许站点域名，避免被别人拿去白嫖额度。
 */

import {
  aiChat, aiSearch, aiConfigured, aiProviderName, aiModelName, aiMissingHint, aiSearchSupported,
  DeepSeekError, ZhipuError,
} from './src/ai.js';
import { meituanNearby, meituanTravel, meituanConfigured } from './src/providers/meituan.js';
import { shangouNearby, shangouConfigured } from './src/providers/shangou.js';
import { buildSystemPrompt, buildUserPrompt, parseRecommendation, fallbackRecommendation } from './src/prompt.js';

/* ============================== 配置 ============================== */

const DEFAULT_CONFIG = {
  // —— AI 提供商：zhipu（智谱 GLM，免费）| deepseek（按 token 计费）——
  AI_PROVIDER: 'zhipu',
  MODEL: 'glm-4.7-flash',             // 智谱默认；切 deepseek 时下面的 aiModelName 会自动改写
  // —— 预算（元）。价格按官方牌价取高峰价，宁可提前截断也不超支 ——
  INPUT_RATE_YUAN_PER_M: 2,           // 输入 2 元/百万 token（DeepSeek 缓存未命中·高峰）
  OUTPUT_RATE_YUAN_PER_M: 8,          // 输出 8 元/百万 token（高峰）
  SEARCH_RATE_YUAN_PER_CALL: 0.005,   // Search 5 元/千次
  DAILY_BUDGET_YUAN: 1.0,             // 每日总预算
  DAILY_MAX_CALLS: 300,               // 每日最多问答次数
  DAILY_MAX_SEARCH: 150,              // 每日最多联网搜索次数（0 = 关闭联网）
  // —— 交互 ——
  MAX_INPUT_CHARS: 300,
  MAX_HISTORY: 6,
  MAX_OUTPUT_TOKENS: 320,
  ALLOWED_ORIGINS: '*',
  TIMEOUT_MS: 25000,
};

/* ============================== 工具 ============================== */

const MICRO = 1e6; // 微元，避免浮点误差

function cfg(env) {
  const out = Object.assign({}, DEFAULT_CONFIG);
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (env && env[k] !== undefined && env[k] !== '') {
      out[k] = typeof DEFAULT_CONFIG[k] === 'number' ? Number(env[k]) : env[k];
    }
  }
  if (typeof out.ALLOWED_ORIGINS === 'string' && out.ALLOWED_ORIGINS !== '*') {
    out.ALLOWED_ORIGINS = out.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

function corsHeaders(request, config) {
  const origin = request.headers.get('Origin') || '';
  let allow = '';
  if (config.ALLOWED_ORIGINS === '*') allow = '*';
  else if (matchOrigin(origin, config.ALLOWED_ORIGINS)) allow = origin;

  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

/**
 * 白名单匹配，支持一条前缀通配 `https://*.pages.dev`。
 * 用来一次放行 Cloudflare Pages 的「项目名.pages.dev」以及每个部署的
 * 「哈希.项目名.pages.dev」，省得地址一变就得重新部署 Worker。
 * 只允许出现在最左一段，且必须跟一个点，避免写成 https://* 把全网放行。
 */
function matchOrigin(origin, list) {
  if (!origin) return false;
  if (!Array.isArray(list)) return false;
  return list.some((rule) => {
    if (rule === origin) return true;
    const star = rule.indexOf('*');
    if (star < 0) return false;
    if (!rule.startsWith('https://*.') || star !== 8) return false; // 只认 https://*.xxx 形式
    const suffix = rule.slice(star + 1); // ".pages.dev"
    if (!origin.startsWith('https://')) return false;
    const host = origin.slice(8);
    if (!host.endsWith(suffix)) return false;
    const label = host.slice(0, host.length - suffix.length);
    // 前缀必须是合法的单段主机名（允许 a.b 这种多段，但不得含协议/斜杠）
    return label.length > 0 && !/[/\s]/.test(label);
  });
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  });
}

function originAllowed(request, config) {
  if (config.ALLOWED_ORIGINS === '*') return true;
  const origin = request.headers.get('Origin') || '';
  // 无 Origin（curl / 服务端调用）放行；带 Origin 必须命中白名单
  return !origin || matchOrigin(origin, config.ALLOWED_ORIGINS);
}

/* ============================== 记账 ============================== */

/**
 * KV 是最终一致存储，并发下会少记。这里用「读-加-写」+ 1/20 概率补写，
 * 对个人站点足够；真要严格可换 Durable Object。
 */
function dayKey() {
  // 按北京时间分桶，跟用户作息一致（避免 UTC 0 点额度突然重置）
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

/**
 * 智谱 GLM 客户端（OpenAI 兼容协议）
 * ---------------------------------------------------------------
 *   POST https://open.bigmodel.cn/api/paas/v4/chat/completions
 *   Authorization: Bearer <ZHIPU_API_KEY>
 *
 * 默认模型 glm-4.7-flash：输入输出全免费、不限量，官方定位长期产品。
 * 免费层的限制在并发（约 1 路），所以这里不做重试风暴，失败就老实上报，
 * 由前端降级本地食神——比悄悄拖 20 秒再超时体验好得多。
 *
 * 计费：免费模型成本记 0；若把 MODEL 换成付费型号，用下面的 RATE 兜底估算，
 * 宁可高估也不让预算闸门失效。
 */

const BASE = 'https://open.bigmodel.cn/api/paas/v4';

/** 付费型号的保守估价（元 / 百万 token）。glm-4.7-flash 命中免费名单时为 0 */
const PAID_RATE = {
  inputPerM: 4,
  outputPerM: 16,
};

/** 已知免费型号（前缀匹配，型号带日期后缀也能命中） */
const FREE_PATTERNS = [/^glm-.*flash/i, /^glm-4\.5-air/i, /^glm-z1-flash/i];

export class ZhipuError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ZhipuError';
    this.status = status || 502;
    this.detail = detail;
  }
}

export const zhipuError = ZhipuError;

export function zhipuConfigured(env) {
  return !!(env && env.ZHIPU_API_KEY);
}

export function isFreeModel(model) {
  return FREE_PATTERNS.some(re => re.test(String(model || '')));
}

async function post(path, apiKey, body, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 20000) : null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const j = JSON.parse(text);
        msg = (j.error && (j.error.message || j.error.code)) || j.message || msg;
      } catch { /* 非 JSON，保留原始状态码 */ }
      throw new ZhipuError(msg, res.status, text.slice(0, 300));
    }
    try { return JSON.parse(text); }
    catch { throw new ZhipuError('上游返回的不是 JSON', 502, text.slice(0, 300)); }
  } catch (e) {
    if (e instanceof ZhipuError) throw e;
    if (e && e.name === 'AbortError') throw new ZhipuError('上游超时', 504);
    throw new ZhipuError((e && e.message) || '网络错误', 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 一轮对话。返回 { content, model, usage, costMicro } */
export async function zhipuChat({ apiKey, model, messages, maxTokens, temperature, json, timeoutMs }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens || 320,
    temperature: typeof temperature === 'number' ? temperature : 0.85,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const data = await post('/chat/completions', apiKey, body, timeoutMs);
  const choice = (data.choices || [])[0] || {};
  const content = String((choice.message && choice.message.content) || '').trim();
  if (!content) throw new ZhipuError('模型返回空内容', 502);

  const u = data.usage || {};
  const promptTokens = u.prompt_tokens || 0;
  const completionTokens = u.completion_tokens || 0;
  const costMicro = isFreeModel(data.model || model)
    ? 0
    : Math.round(promptTokens * PAID_RATE.inputPerM + completionTokens * PAID_RATE.outputPerM);

  return {
    content,
    model: data.model || model,
    usage: { promptTokens, completionTokens, totalTokens: u.total_tokens || 0 },
    costMicro,
  };
}

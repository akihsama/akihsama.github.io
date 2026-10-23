# 更新日志

## v0.5（work/v0.5 分支）

### 新增
- **问食神接入大模型 + 可切换提供商**
  默认走智谱 `glm-4.7-flash`（输入输出全免费），`AI_PROVIDER=deepseek` 可切到
  `deepseek-flash`；切家只改 `wrangler.toml` 的 `[vars]`，代码不动。
  配了 DeepSeek Key 且走 deepseek 时，会先调官方 Search API（`/v1/tools/search`）
  拿实时门店与团购信息再出签，回复底部展示参考来源。
- **AI 提供商抽象层**（`backend/src/ai.js`）：`aiChat / aiSearch / aiConfigured /
  aiModelName`，模型名与提供商不匹配时自动纠正，避免 400；智谱档自动关闭付费联网。
- **附近可下单面板**：并发拉取美团到店团购与淘宝闪购，统一结构渲染，
  单平台失败只影响自己那一块，其它照常。
- **签卡直连商品**：翻开食签卡时，自动用菜名去平台搜一次，有落地页就给「去下单」按钮。
- **平台适配器 + 规范层**（`app/js/normalizer.js`）：美团 / 闪购两套字段归一成同一结构，
  纯函数、可单测，前后端共用。
- **后端路由体系**：`/api/v1/health`、`/api/v1/chat`、`/api/v1/platform/nearby`、`/api/v1/travel`。
- **成本与防刷**：按 token + 搜索次数记账（KV），日预算 / 日次数 / 单 IP 限流三道闸。
- **CI**：`.github/workflows/backend-ci.yml`，语法检查 + 19 项单测。

### 修复
- 签卡 `overflow: hidden` 导致新增内容被裁切 → 改为自适应高度 + 内部滚动。
- 旧版 `deepseek-chat` 模型名已废弃 → 不再写死具体型号，由 `AI_PROVIDER` 决定默认值。
- 单测从 14 项增加到 19 项，新增覆盖提供商选择、Key 探测、模型名纠正、免费模型记账。
- 旧版 Worker 用 Service Worker 写法且 `env` 作用域错误 → 重写为 ES Module。

### 说明（能力边界，避免误解）
- 美团：团购搜索走官方 Agent 通道，需要用户授权 token；酒旅走个人开发者 OpenAPI。
- 淘宝闪购：开放平台是**商家维度**接口，个人应用拿不到「附近商品」，
  因此未配置门店 id 时明确显示「待配置」，不伪造数据。
- 任何平台没配好，签筒与本地食神都能正常工作。

## v0.4 及以前

- 静态站结构迁移、壁纸与首页样式修正、Pages 部署流程整理（见 main 历史提交）。

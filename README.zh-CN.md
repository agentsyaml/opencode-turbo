# opencode-turbo

让 OpenCode 安心运行。长会话可能遇到 OpenCode 默认不重试的提供方错误，
而侧边栏实时状态行让会话活动清晰可见。本插件处理明确的失败场景——零配置。

## 为什么能降低焦虑

- **明确的瞬态错误自己处理。** 会话遇到匹配的 API、SQL 或连接/传输错误时，
  插件捕获模型已产出的内容，用同一模型重新发送续写提示，从断点处继续。
- **看得见它在干活。** 侧边栏一行实时状态，告诉你 OpenCode 此刻在做什么——
  推理、撰写、跑工具——安静的屏幕不再意味着卡死。放心走开，回来是完成的
  会话，而不是死掉的会话。

## 功能

### 自动恢复

会话遇到明确的 API、SQL 或连接/传输错误时，从断点处恢复回复：

- 明确 `APIError` 的状态码：400、402、403、405、408、409、422、429
  （以及 500、502、503、504、524、529）；没有状态码时只接受少数明确的服务端
  瞬时文案，未分类错误即使文案相同也不会触发恢复
- 明确的 SQL/SQLite/Database 错误，且消息包含 `Failed to execute statement`
  或 `database is locked`；无错误名称时，仅当 `Failed query:` 后紧跟
  `insert`、`select`、`update` 等 SQL 语句关键字才会处理
- 窄范围的连接/传输错误，例如 connection reset/closed/lost、`ECONN*`、
  unable to connect、socket hang up、fetch 失败、request/connection/response/read/
  SSE 超时、`ETIMEDOUT`、broken pipe，以及 stream closed/ended 或 premature close

恢复流程（按会话）：确认失败的 assistant 消息 → 捕获部分产出 → 保留完整历史并追加续写提示。
护栏：用户主动停止、鉴权错误、永久性失败、模型/工具输出错误、TLS/证书错误、
空输出及静默卡顿永不自动恢复；每会话最多连续恢复 10 次，指数退避上限 30 分钟
（成功后计数归零）；模型/工具错误即使带有原本可重试的 API 状态码也会排除。
状态预检最多等待 3 次，只等待失败消息就绪，不会扩大错误匹配范围；绝不干涉
OpenCode 自带的重试循环。
日志：`~/.local/share/opencode/logs/auto-recover.log`。

### 实时状态行

侧边栏常驻一行，随流式输出实时刷新：

- `🔧 bash · 12.5s` — 正在运行的工具及耗时；模型显式设置了超时上限时显示
  预算：`🔧 bash · 12.5s / 30s`；内容类工具额外显示输入 token
  估算：`🔧 edit · 2.5s · 567 tokens`
- `🤔 Thinking · 12.0s · 1,234 tokens` — 耗时在前，推理 token 数（估算）
  在后
- `⠋ Working · 3.2s · 567 tokens` — 动画转圈图标，该阶段耗时在前，已累计
  token 在后
- `⏳ Waiting · 1.5s` — 等待首字节输出阶段
- `✅ Done · 1m 30s · 14:30:22` — 上一轮完成耗时与本地时间
- `❌ Failed` — 终态失败的回合明确显示，不伪装成空闲

新状态经 300ms 驻留后替换当前显示（消除快速切换闪烁），而显示中的数字——
转圈与计时——每心跳持续实时跳动，状态行永不冻结、永不像卡住。token 数为
估算（中英感知），非计费口径。

### 通知弹窗

仅限重试类事件：OpenCode 自带重试（`⚠️ Retrying · attempt 2`）与本插件
自动恢复（`🔄 Auto-recovering · 1/10`）。所有展示均为只读，绝不改动会话状态。

## 安装

```json
{
  "plugin": ["@alexsun-top/opencode-turbo"]
}
```

本地开发可直接指向源码：

```json
{
  "plugin": ["file:///path/to/opencode-turbo"]
}
```

无任何配置。修改配置后重启 OpenCode。

> TUI 状态行由 `dist/tui.js` 提供。修改 `src/tui.tsx` 后需执行
> `bun run build:tui`，否则侧边栏状态行不会加载。

## 开发

```bash
bun install
bun run check   # 类型检查 + 自检
```

## 许可证

MIT

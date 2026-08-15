# opencode-turbo

让 OpenCode 安心运行。长会话有两种死法：OpenCode 默认不重试的提供方错误，
和"屏幕安静了，是不是卡死了"的焦虑。本插件把两个都解决——零配置、零选项。

## 为什么能降低焦虑

- **错误自己处理。** 会话遇到 OpenCode 放弃的终态错误时，插件自动恢复：
  捕获模型已产出的内容，用同一模型重新发送续写提示，从断点处无缝继续。
  不用盯着、不丢产出、不用重跑一个小时的会话。
- **看得见它在干活。** 侧边栏一行实时状态，告诉你 OpenCode 此刻在做什么——
  推理、撰写、跑工具——安静的屏幕不再意味着卡死。放心走开，回来是完成的
  会话，而不是死掉的会话。

## 功能

### 自动恢复

会话遇到终态失败时，从断点处恢复回复：

- 流中断（`provider closed the stream before sending a completion marker`）
  直接进入 `session.error`、而非走 OpenCode 自带重试路径的情况——常见于
  `task` 工具 / 子代理场景
- OpenCode 视为不可重试的状态码：400、402、403、405、408、409、422、429
  （以及 500、502、503、504、524、529）
- 重试一次即可让模型自行修正的输出错误（`bad request`、
  `reasoning_opaque`、畸形工具调用）
- 并发实例导致的 SQLite 瞬态错误（`Failed to execute statement`、
  `database is locked`）

恢复流程（按会话）：中止 → 捕获部分产出 → 回退到最后一条用户消息 →
以同一模型重发续写提示。护栏：用户主动中止、鉴权错误及永久性失败永不恢复；
每会话最多连续恢复 10 次，指数退避上限 30 分钟（成功后计数归零）；
绝不干涉 OpenCode 自带的无界重试循环。
日志：`~/.local/share/opencode/logs/auto-recover.log`。

### 卡死看门狗

静默流中断（TCP 存活、SSE 无数据）**不会产生任何错误**，因此 OpenCode
既不重试也不超时——会话永远停在 thinking。看门狗把**生成期间的事件静默**
当作卡死信号：

- 任何生成进度事件（`message.part.updated`、`message.updated`、
  `session.status`）都证明流是活的；`session.idle`/`session.error` 停止监控
- 会话超过卡死阈值（默认 **30 分钟**）无任何事件 → 按失败恢复：中止 →
  卡住的消息被标记为中断消息 → 以同一模型重发续写提示
- 合法长推理不会被误判：推理流会持续产生事件，只有真正静默的会话才会触发

阈值可通过插件选项配置：

```json
{
  "plugin": [["@alexsun-top/opencode-turbo", { "stallTimeoutMs": 1800000 }]]
}
```

（设为 `0` 可关闭看门狗。）恢复护栏与自动恢复一致——最多 10 次、指数退避、
成功后计数归零。

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

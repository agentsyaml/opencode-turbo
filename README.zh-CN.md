# opencode-turbo

零配置 OpenCode 插件：自动恢复 opencode 默认不重试的提供方错误，并在 TUI
侧边栏提供实时状态面板。无需任何配置项，装上重启即可。

## 功能

**自动恢复** — 会话遇到 opencode 放弃的终态错误时，从断点处无缝续写：

- 流中断（`provider closed the stream before sending a completion marker`）
  直接进入 `session.error` 终态、而非走 opencode 自带重试路径的情况 —
  常见于 `task` 工具 / 子代理场景
- opencode 视为不可重试的状态码：400、402、403、405、408、409、422、429
  （以及 500、502、503、504、524、529）
- 重试一次即可让模型自行修正的输出错误（`bad request`、
  `reasoning_opaque`、畸形工具调用）

**实时状态面板** — 侧边栏常驻 `⚡ Status` 面板，随流式输出实时刷新：

- `🤔 Thinking · 1,234 words` — 模型推理中的实时字数
- `🔧 bash · 12.5s` — 当前运行的工具及耗时
- `✅ Done · 1m 30s · 14:30:22` — 上一轮完成耗时与本地时间

**通知弹窗** — 仅限重试类事件：opencode 自带重试
（`⚠️ Retrying · attempt 2`）与本插件自动恢复
（`🔄 Auto-recovering · 1/10`）。所有展示均为只读，绝不改动会话状态。

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

无任何配置。修改配置后重启 opencode。

> TUI 面板由 `dist/tui.js` 提供。修改 `src/tui.tsx` 后需执行
> `bun run build:tui`，否则侧边栏面板不会加载。

## 恢复原理

可重试的错误由 opencode 自行无限重试（指数退避）——插件绝不干涉该循环。
插件只作用于终态失败（`session.error` / 携带 assistant 错误的
`message.updated`），对每个会话：

1. `session.abort` — 停止正在进行的生成
2. 读取消息 — 捕获已产出的部分内容与所用模型
3. `session.revert` 回退到最后一条用户消息 — 丢弃被中断的回复
4. 以部分内容重新发送续写提示，**沿用同一模型** — 模型从断点处继续

护栏：用户主动中止、鉴权错误及永久性失败永不恢复；每会话最多连续恢复
10 次，指数退避上限 30 分钟（成功后计数归零）；恢复单飞，重复触发事件
按错误签名去重。日志位于 `~/.local/share/opencode/logs/auto-recover.log`。

## 开发

```bash
bun install
bun run check   # 类型检查 + 匹配逻辑自检
```

## 许可证

MIT

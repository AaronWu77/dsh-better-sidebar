---
kind: upgrade-guide
description: "浏览器代理终端请求必须携带所属 sessionId，远端终端使用 Session 选定的后端而不是 node-pty。"
---

# 侧栏终端归属与远端生命周期

[English](guide.md) | 中文

## 变更

Better Sidebar 0.19.2 允许浏览器仅凭 UUID 附加或关闭代理终端。`/sidebar/ws/terminal?uuid=...`、`agent-pty.close` 与 `agent-pty.skip-wait` 现在必须携带 `sessionId`。其他会话所属的 UUID 会以未找到错误拒绝。附加还会读取活动或只读持久化 Session 头；浏览器的 `cwd` 提示不能选择执行宿主。

界面标签页与模型 `terminal_*` 工具使用同一 Session 选定的远端后端。远端 shell argv 和环境由 Remote SSH 提供方管理；本地 shell 设置不会覆盖它们。缺少 node-pty 只会阻止本地分配，不会禁用远端分配或工具注册。提供方失败时绝不回退到 node-pty。会话级 `shell.get` 返回远端可执行文件；省略 `sessionId` 的调用者只获得本机元数据。异步附加期间收到的输入受 `terminalInputBufferBytes` 约束（默认 256 KiB）；溢出时以 1009 关闭视图，不会回放输入。

界面终端复用要求宿主能力对象身份一致，仅有相同 POSIX cwd 不足以复用；更换宿主会先清理旧后端，再分配新后端。远端终端在 park 帧、裸 socket 断开和重连期间保持存活，直到显式关闭、Session 释放、后端路由移除或插件释放。重连会回放有界的原始 VT 输出，包括提示符。输入至多派发一次；发送成功不等于 shell 已消费输入。派发结果不确定时显式报错，不会回放输入。远端 SIGINT 与 SIGTSTP 使用控制按键；SIGTERM、SIGKILL 与 SIGHUP 请求有确认的后端终止，而不是发送同名 POSIX 信号。

## 迁移

1. 安装配套 Better Sidebar 与 Remote SSH 联调候选包之前停止服务。仅含认证修复的 `0.19.3-auth.2` tarball 不包含远端终端联调。不要向启用实时 patch 重载的运行中 profile 安装。
2. 自定义客户端必须向代理终端 WebSocket 查询和 `agent-pty.close`、`agent-pty.skip-wait` 的 JSON 请求体添加真实所属 `sessionId`。随包浏览器客户端已携带该字段，固定标签页使用原属会话。
3. 宿主必须注册 Remote SSH 工作区提供方，并提供权威的活动或持久化 Session 头。通过提供方配置远端交互 shell，而不是侧栏的本地 `shell` 或 `shellArgs` 设置。
4. 确认切换会话或刷新后远端提示符只回放一次，没有分配第二个后端，且其他会话不能附加或关闭该 UUID。显式关闭闲置远端标签页；浏览器断开不会终止它们。

此变更不重写 Session 日志或 profile 设置。独立的[Session 工作区迁移](../sidebar-session-workspace/guide.zh.md)与[认证迁移](../sidebar-authentication/guide.zh.md)要求仍然适用。

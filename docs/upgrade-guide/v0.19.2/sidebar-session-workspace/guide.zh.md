---
kind: upgrade-guide
description: "侧栏工作区请求要求活动或持久化会话头，不再使用浏览器 cwd 或宿主进程目录兜底。"
---

# 侧栏工作区路由要求权威会话

[English](guide.md) | 中文

## 变更

Better Sidebar 0.19.2 在会话未附加时接受浏览器的 `cwd` 提示，找不到会话头时使用宿主进程目录。工作区请求现在先读取活动会话头，再以只读方式打开持久化会话头。路由不读取事件日志，并会关闭读取句柄。

浏览器的 `cwd` 字段不再选择执行根目录。会话不可用且没有持久化服务时返回 HTTP 404。活动或持久化会话头缺少有效绝对 `cwd` 时返回 HTTP 400。该要求适用于工作区 API 请求、媒体与 HTML 预览、上传和终端分配。关闭 `workspaceFence` 允许访问会话目录之外的路径，但不能补充缺失的会话或选择其他执行宿主。

宿主提供 `remoteSshManager` 时，还必须向 `ctx.sidebarWorkspaceProviders` 注册路由器。侧栏观察到 manager 或路由器后，在该侧栏实例存活期间，缺少路由器始终返回 HTTP 503，包括 manager 移除之后。只有替换路由器明确返回本地结果，才会启用本地执行。公开出口 `dsh-better-sidebar/workspace-provider` 只提供类型导入所需声明，不提供运行时模块。注册操作必须在所属 effect 中返回注销函数。停止服务后再一起安装配套联调候选包；仅含认证修复的 `0.19.3-auth.2` tarball 不包含此变更。

## 迁移

1. 自定义客户端必须发送宿主返回的真实 `sessionId`。不要用任意标识符加 `cwd` 代替已存储的会话。
2. 提供未附加会话访问的宿主必须支持 `sessionPersistence.open(id, 'read')`，句柄头中包含会话的绝对工作目录，且句柄可关闭。活动会话也必须在头中提供该目录。不要用浏览器摘要或 `process.cwd()` 替代。
3. 确认 `session.cwd` 对活动会话和未附加的持久化会话均返回权威目录，即使请求中携带了其他 `cwd`。确认未知会话被拒绝，而不是被重定向到宿主目录。

此变更不重写会话日志或 profile 设置。独立的[认证迁移](../sidebar-authentication/guide.zh.md)要求仍然适用。

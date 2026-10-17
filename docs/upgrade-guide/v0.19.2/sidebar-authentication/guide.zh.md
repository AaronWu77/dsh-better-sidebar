---
kind: upgrade-guide
description: 侧栏 HTTP 与 WebSocket 访问现在需要宿主的已认证浏览器会话。
---
# 侧栏浏览器认证

## 变更

`0.19.3-auth.2` 候选版将 Better Sidebar 仅检查请求信任的逻辑替换为宿主 `connection.requestRejection` 准入 API。侧栏 API、上传、媒体、HTML、懒加载脚本及 WebSocket 路由均需要与宿主网关相同的浏览器登录会话。未登录或登录无效返回 401；不受信任请求返回 403。拒绝发生在读取请求体、文件或分配终端之前。

自定义宿主必须提供带有 `requestRejection` 的 `connection` 服务。缺少所需 API 时插件激活失败，不会退回未认证访问。本候选版正在针对 DSH `0.2.0-rc.2` 验证，不声明兼容旧宿主。

## 迁移

1. 打开你自己的 `dsh web` 进程输出的新启动链接，建立浏览器登录 Cookie。不要把令牌放入侧栏 URL，也不要记录 Cookie。
2. 为自定义宿主提供已认证的 Connection 准入。为测试上下文提供明确的已认证准入实现，同时保留未登录与不受信任请求的独立测试。
3. 如果要求更新仅在重启后生效，先停止 Web 服务再修改 profile 依赖。使用 `patchReload: live` 的 profile 可能立即应用安装变化。保留原包引用与 profile 配置用于回滚，不要向运行中的 profile 安装本候选版。
4. 安装并重启后，确认不带 Cookie 请求 `/sidebar/api/terminal.deps` 返回 401，已登录浏览器可使用侧栏，跨站请求返回 403。

本认证专用候选版不增加远端文件系统、Git 或终端支持，也不迁移会话数据。重新安装旧候选版会移除本保护；回滚意味着恢复原有暴露面，并非安全等价的配置。

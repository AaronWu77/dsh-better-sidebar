---
kind: upgrade-guide
description: "Workspace provider 改为返回相对文件名匹配与截断状态，不再返回远端目录项数组。"
---
# 工作区文件名搜索结果

[English](guide.md) | 中文

## 变更

Better Sidebar `0.19.3-remote.5` 和 Remote SSH `0.2.4-aaron.12-sidebar.5` 使用 `SidebarWorkspaceFiles.search(query, signal?)`，返回 `{ matches: string[], truncated: boolean }`。旧远端目录项数组与此不兼容。每个匹配项都是相对于权威会话根目录的路径，使用 `/` 分隔；目录名和链接本身的名字也可能匹配。文件夹页根据权威 `session.cwd` 回复解析匹配，不以当前显示的子目录作为搜索根。

达到搜索上限时，接口返回 `truncated: true` 的部分成功结果，可以为空，不再返回 HTTP 413。这不表示所有文件都已经搜索过。传输、权限和工作区栅栏错误仍会拒绝。现有 `searchMaxRows`、`searchMaxItems` 和 `searchMaxDepth` 配置继续生效。AHP 仍会传输完整目录列表；受限的是后续检查、元数据工作、排队遍历及返回匹配数。

调用者取消后停止遍历，浏览器忽略过期回复。Provider 须接受可选取消信号，等待尚未完成的工作结束后再释放所有权。不可中断的 AHP 目录请求须先结束，取消清理才会完成。

## 迁移

1. 保留 `.3` 归档，备份 Web profile 的清单、锁文件和 patch。替换包前停止 Web 服务；其 patch watcher 可能无需重启就重载插件。
2. 一起安装 `dsh-better-sidebar-0.19.3-remote.5.tgz` 和 `dsh-remote-ssh-0.2.4-aaron.12-sidebar.5.tgz`，先安装 Sidebar。自定义 provider 须把 `SidebarWorkspaceFiles.search` 改为对象结果，并接受可选 `AbortSignal`。不要混用不同代 provider，也不要提高上限来掩盖截断。
3. 自行启动 Web 服务，再刷新现有 GUI。确认点击文件会在原生页所属会话中打开编辑器，文件名搜索可打开相对路径匹配项。受限搜索应显示部分结果提示，新查询不能被旧回复覆盖。这些正式环境检查由操作者在安装后执行。
4. 保留现有工作区映射、栅栏及会话数据，无需数据迁移。回退时先停止服务，恢复两个 `.3` 包与备份 profile 文件，再启动并刷新。

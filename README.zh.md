# dsh-default-workspace

在**运行中的** DeepSeek Harness 里查看、修复并迁移 **DSH 的默认工作区**（新会话默认打开的目录），不用重启，也不用手工改 `~/.dsh/storages/workspace.json`。

[English](README.md)

```
default_workspace {"action": "status"}
default_workspace {"action": "switch", "path": "D:\\work", "dryRun": true}
default_workspace {"action": "switch", "path": "D:\\work", "moveFiles": true}
default_workspace {"action": "repair", "dryRun": true}
```

## 为什么需要它

每个新会话都开在**默认工作区**里，而 DSH 在注册工作区的那一刻就把这个路径钉死了。
全新安装时它是 `<文档>/deepseek-harness/default-workspace`；Windows 上「文档」走的是
shell 的 `MyDocuments` 已知文件夹，默认就是 `C:\Users\<你>\Documents`——除非有东西
（OneDrive 的「备份文档」、漫游策略、手动搬迁用户配置）把它改到了别处。也就是说，
**所有会话都在往里写的那个目录，一开始就在系统盘上**，而系统盘通常是整机最小的盘。

这在三种很平常的情况下就是真问题：

- **系统盘满了。** 会话的产物（代码、数据集、截图、包缓存）都落在默认工作区，它会一直
  长，而且界面上没有任何开关。把它挪到数据盘是最自然的解法，却没有受支持的做法。
- **「文档」被重定向了。** 开了 OneDrive 的文件夹备份，或者搬了用户配置，已知文件夹
  指向就悄悄变了。工作区记录仍指向旧路径，于是默认工作区直接不存在了；已经写在旧路径下
  的会话日志也跟着打不开。
- **想把新会话统一钉在某个目录。** 比如都开到 `D:\work`，而不是随用户配置走的路径。
  这是很常见的整理诉求，但工作区 API 没有改 `path` 的方法，界面上也没有这个入口。

让它卡住的原因：

- 内置的 `initializeDefault` 会建 `<文档>/deepseek-harness/default-workspace`，它自己的
  注释写着 *"The Host never renames or relocates an existing default"*；
- 工作区 Remote API 只有 `create`、`rename`、`delete`、`insertBefore`、`archive`、
  `pin`、`follow`，**没有任何改 `path` 的方法**；
- `create` 建出来的是**普通**工作区；默认工作区是被 `defaultWorkspaceId` 指着的唯一那条
  记录，而「把它指到别处」这件事哪里都没提供；
- 手工改 `~/.dsh/storages/workspace.json` 要重启才生效，而重启后宿主会拒读所有
  「header 里的 `cwd` 与日志所在目录不一致」的会话日志——报 `corrupt session log "…":
  header id "…" and cwd identify "…"`——这些会话就从列表里消失了；
- 在资源管理器里直接拖文件夹最糟：记录还指着旧路径，日志目录名里也仍然编码着旧路径，
  新位置对宿主完全不可见。旧目录没了，新目录又不被使用。

本插件在运行中的宿主里把这套迁移完整做掉：改记录、可选搬目录内容、搬会话日志
（header 的 `cwd` **和**它所在的目录一起改），再给宿主已经静默跳过的日志做一次重帧化修复。
量级参考：它最初就是为一次真实迁移写的——446 个顶层条目 / 13,280 个文件 / 668 MB 换到另一块盘，
连带 22 个已存会话日志一起过去，全程不重启，每个重写过的日志都逐字节核对过。

## 工具

只有一个工具 `default_workspace`，三个动作：

| 动作 | 行为 |
| --- | --- |
| `status` | 默认工作区是哪个、目录在不在、挂了多少会话、几个正在跑；并体检所有已存会话日志。 |
| `switch` | 走宿主自己的存储域（`entity.mutate`）改写工作区记录，内存与落盘同步、无需重启；可选搬旧目录内容，默认把 header 仍指向旧路径的会话日志一起迁走。 |
| `repair` | 重帧化那些「首帧不是恰好一行 header」、被宿主静默跳过的日志（见下）。 |

参数：

| 参数 | 含义 |
| --- | --- |
| `action` | `status`、`switch` 或 `repair`（必填）。 |
| `path` | 仅 `switch`：要成为默认工作区的绝对路径，不存在会创建。 |
| `moveFiles` | 仅 `switch`：同时把旧目录内容搬过去，默认 `false`；旧目录里有活会话时拒绝。 |
| `migrateSessions` | 仅 `switch`：把会话 header 改到新路径并搬日志，默认 `true`。 |
| `dryRun` | `switch` 与 `repair`：只报告计划，不改任何东西，默认 `false`。 |

## 安全性

- **先预览**：两个写动作都支持 `dryRun`，`status` 只读。
- **动手前先算计划**：同名冲突、活会话、缺失日志、坏日志都先列出来。
- **改写日志只重压第一帧**，其后每一帧原样拷贝，事件内容一个字节都不重新编码。
- **新文件校验通过才顶替旧文件**：header 的 id 与 `cwd` 正确、首帧恰好一行 header、其余事件字节与源文件完全相同；任一项不过就抛错，不替换。
- **不删除任何东西**：旧会话目录 rename 进 `<sessions 根>/../backups/session-reframe-<时间戳>/`（repair）或结果里报告的本次备份目录（switch）。
- **活会话永不迁移**——它的日志句柄、租约与进行中的工具调用都钉在旧路径上；插件会把它列出来，而不是把它脚下的工作区挪走。
- 目标路径已被别的工作区占用、或两个路径互相嵌套时直接拒绝。

## 原理

### 记录

`WorkspaceEntity.mutate()` 是工作区记录唯一的写路径，它会按新路径把 `sessionIds` 剪枝。所以插件先把要迁走的会话用新路径登记进索引（`registry.host.rememberSessionPath`），再改 `path`——否则宿主会把旧工作区的会话从记录里全部丢掉。

### 日志

一份日志在磁盘上的位置是

```
<sessions 根>/<projectKey(cwd)>/<encodeSegment(会话 id)>/session.v4.jsonl.zstd
```

`projectKey` 把 `/`、`\`、`:` 折叠成单个 `-`，其余字符编成 `~XXXX`（UTF-16 码点、大写十六进制）；`encodeSegment` 另外把 `.` 编成 `~002E`、`..` 编成 `~002E~002E`。只改 header 的 `cwd` 不搬文件（或反过来）会得到

```
corrupt session log "<path>": header id "<id>" and cwd identify "<expected path>"
```

所以 `switch` 一次把两件事都做掉：先写新文件、校验、再 rename 到位。

### 为什么需要 `repair`

宿主读日志前**只解第一帧**，并要求这一帧的明文**恰好就是一行 header**：

```js
// dsh-session-persistence-jsonl/lib/index.js
function assertZstdHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1)
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line');
}
```

抛出的 `SessionPersistenceCorruptionError` 在 `listArtifacts` 里被**静默吞掉**（`metadata = undefined`）。于是一份「重压成单帧」的日志——Zstandard 层面完全合法，只是不是宿主想要的样子——会凭空消失：文件还好好躺在磁盘上，会话却列不出来、打不开。`repair` 把它重帧化：帧 0 是新压的 header 行，事件按换行对齐切成后续帧，原文件留在备份目录里。

Node 自带的 `zstdDecompressSync` 对多帧只解第一帧，`createZstdDecompress` 解到第二帧报 `ZSTD_error_prefix_unknown`，所以 `lib/zstd-multi.js` 自己遍历帧容器。

## 图形面板

插件同时带浏览器半边，三个动作都能在界面上点：侧栏左上角多一行「工作区」（与任务看板同一个座位），
点它在主区打开「默认工作区」面板。

面板显示当前默认路径、目录是否存在、已存与正在运行的会话数、日志体检结果；提供路径输入框和
「预览」（dry run）与「切换」（两段式确认：点第二次才执行）两个按钮，另有「检查日志」「修复日志」
用于重帧化。参数走查询串，请求先过平台的信任栅栏，所以这些路由只对 DSH 页面本身应答（其它来源 401）。

这半边是手写产物，适配 DSH 的懒加载 CJS 客户端加载器，**没有构建步骤**：`lib/client.js` 注册
`window.__ModuleLoader__.load({ id, factory })`，`package.json` 里以 `exports["./client"]` 与
`dsh.client: { platform: "web" }` 声明。改这个文件由客户端 HMR 轮询自动生效，但
**`dsh.client` / `exports` 元数据会缓存到宿主重启** —— 首次安装后重启一次 DSH，面板才会出现。

## 安装

```sh
dsh plugin add https://github.com/Elefseus/dsh-default-workspace
```

或手工接进 profile —— `~/.dsh/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": { "dsh-default-workspace": "github:Elefseus/dsh-default-workspace" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-default-workspace" ] } }
}
```

本地开发可以直接链目录（Windows 上用 **junction**，不需要符号链接权限）：

```sh
node -e "require('node:fs').symlinkSync('D:/code/dsh-default-workspace', process.env.USERPROFILE + '/.dsh/profiles/desktop/node_modules/dsh-default-workspace', 'junction')"
```

桌面版默认开启 HMR：往 profile 的 `cordis.patch.yml` 追加一行就能触发 recomposition，工具免重启出现。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-default-workspace
      name: dsh-default-workspace
      config:
        sessionsRoot: '' # 留空 = 用宿主 sessionPersistence 的 root（通常 ~/.dsh/sessions）
```

## 目录

```
lib/index.js       插件接线：宿主的 defineTool、ctx.get 取服务、注册工具
lib/tool.js        default_workspace 定义：参数、execute、文本渲染
lib/switch.js      status / switch / repair：改记录、搬目录、迁日志、日志体检
lib/paths.js       会话日志路径规则（projectKey、encodeSegment），镜像宿主实现
lib/zstd-multi.js  多帧 Zstandard 遍历、首帧判定、header 改写、重帧化
test/              零依赖测试，`npm test` 直接跑
```

## 测试

```sh
npm test
```

- `test/engine.test.mjs` —— 40 项断言，跑在复刻 `WorkspaceRegistry` / `WorkspaceEntity` 语义的假注册表上（`mutate` 剪枝、`candidateMatches`、`rememberSessionPath`）：状态计数、活会话拒绝搬文件、路径被占用拒绝、dry-run 不改盘、压缩与纯文本日志迁移、单帧坏日志重帧化、repair 备份与幂等，另加一个「记录里的拼写与 realpath 不同」的 junction/符号链接场景。
- `test/tool.test.mjs` —— 22 项断言，覆盖工具契约：必填参数、渲染返回内容块、结果必须是 lossless JSON，以及 status → dry-run → apply → repair 全流程。

CI 在 Linux 与 Windows、Node 22 与 24 上各跑一遍。

## 兼容性

默认工作区在桌面版宿主的存储里，所以本插件需要 `workspaceRegistry` 与（迁日志时的）`sessionPersistence`。已在 DSH `0.2.1-rc.3`（Node 24）上验证。

## 许可

MIT

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

DSH 在注册工作区时就把路径钉死了：

- 内置的 `initializeDefault` 会建 `<文档>/deepseek-harness/default-workspace`，它自己的注释写着 *"The Host never renames or relocates an existing default"*；
- 工作区 Remote API 只有 `create`、`rename`、`delete`、`insertBefore`、`archive`、`pin`、`follow`，**没有任何改 `path` 的方法**；
- 手工改注册表要重启才生效，而且 header 里还是旧 `cwd` 的会话会直接打不开——只要 header 与日志实际所在目录不一致，宿主就拒读。

本插件在运行中的宿主里把这套迁移完整做掉。

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

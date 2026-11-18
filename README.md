# dsh-aiterm · SSH / Telnet 终端（人与 AI 协同）

DeepSeek Harness（DSH）插件：把 SSH 和 Telnet 会话放进 Harness 右侧栏的终端面板，**人**和 **AI** 共用同一个真实终端，并按会话控制 AI 能做什么。

Give your agent hands on real servers. **aiterm** puts SSH and Telnet sessions in DSH's right
sidebar — one real terminal **shared by you and the AI**, not an AI-only pipe: per-session AI
permissions (read-only / write-only / read-write), a single control token, token-cheap delta
reads, searchable history, batch scripts and a full audit trail.

> **改名说明（0.5.0 起）**：包名由 `@dsh/dsh-ssh-telnet` → `@dsh/aiterm` → 公开发布名 **`dsh-aiterm`**，整套标识一起改到位：模型工具名 `aiterm_*`、HTTP 路由 `/aiterm`、数据目录 `~/.dsh/aiterm`、凭据作用域 `aiterm/`、前端存储键 `dsh.aiterm.*`、面板标签类型 `aiterm`。0.4.0 只改了包名，0.5.0 是**破坏性改名**，从 0.3.x/0.4.0 升级要迁移数据与提示词，见下方「从 ssh-telnet 升级」。

- **多会话**：同时打开多台主机，标签页切换；终端输出实时滚动，支持重连回放。
- **省 token 的读取**：默认 **增量读**（只回上次之后的新输出），另有「只看变化行」的屏幕读、带时间戳的历史搜索、以及"等到有输出/提示符/退出"的等待读，不再反复重传整屏。
- **历史可查且按 owner 隔离**：输出按会话落盘并保留（默认 24 小时，写入为 best-effort），会话关闭后仍可按时间范围或关键字检索。会话 id 通过历史目录里的原子 reservation **跨重启/跨进程续号**（不会又从 `st-1` 开始），每次打开会话仍预留**独立日志文件**并写入私有归属/关闭权限元数据；重复/历史 incarnation 会以独立 `historyId` 列出，可单独检索和导出。升级前没有归属元数据的旧日志对 AI 一律 fail closed（见「终端与 AI 会话的归属」）。
- **批量与脚本**：一次调用跑多步（发送 → 等待 → 只读新输出），支持多会话扇出；可保存脚本并在面板里一键运行。
- **SSH + Telnet**：SSH 走 `ssh2`（密码 / 私钥 / agent），Telnet 为原生实现（完整 IAC 协商、TERMINAL-TYPE、NAWS 窗口尺寸）。
- **AI 权限按会话设置**：
  - `只读(ro)`：AI 能看屏幕/输出，**不能**输入；
  - `只写(wo)`：AI 能输入，**不能**看输出；
  - `读写(rw)`：两者都可。
- **AI 操作时屏蔽人工写**：AI 一开始输入就持有「控制权」，人工键盘输入被拒绝并显示提示；AI 空闲超时自动释放，或人工点「接管」立即夺回控制。
- **双向互斥**：人工「接管」后，AI 的写入被拒绝，直到人工「交还 AI」。
- **审计**：每次读、写、拒绝、控制权变更都记录来源（human / ai），面板内可查，AI 也能用工具查。
- **凭据隔离**：保存的密码/私钥存在 Host 侧（优先 DSH 加密凭据库），不会进入模型上下文、工具结果或日志。

> 这是权限与协作层面的护栏，不是远程主机的安全沙箱。对敏感环境请给 AI 设 `只读`，或让 AI 仅通过保存的 profile 连接。

## 安装

公开发布后（npm）：

```bash
dsh plugin --profile web add dsh-aiterm
# 重启 DSH Web
```

本地开发：先打包再装**真实包**，不要用 `link:` / 软链——宿主在 profile 目录下按 importer
路径做包解析，软链会让内核包解析到 profile 之外而启动失败（`ERR_MODULE_NOT_FOUND`）。

```bash
npm install && npm run build   # 需要 esbuild / xterm 才能重建 lib/client.js
npm pack                       # → dsh-aiterm-0.5.4.tgz
# 然后 plugin_manager(action:"install_bundle", target:"<tgz 绝对路径>")
```

装好后浏览器 `Ctrl+F5` 硬刷新一次：客户端半边由宿主重打包，SPA 内切页不够。

> **不会触发 pnpm 的构建脚本门禁。** `ssh2` 本身是纯 JS，但它的两个**可选**原生加速件
> （`cpu-features` 与内建的 `sshcrypto` 绑定）带 `install` / `node-gyp rebuild` 脚本，
> pnpm 10+ 会因此挂起安装等人工批准。本包已把 ssh2 打成 `vendor/ssh2.cjs` 随包发布，
> **依赖图里没有任何安装脚本**；缺少原生件时 ssh2 自动回落纯 JS，功能不受影响。

### 从 ssh-telnet 升级（破坏性）

0.5.0 把工具名、路由、数据目录、凭据作用域和存储键全部从 `ssh-telnet` 改成 `aiterm`，**不保留旧别名**。
从 0.3.x / 0.4.0 升级时按序执行：

```bash
# 1) 停掉 DSH Web（改名期间旧进程还在往旧目录写）
# 2) 迁移数据目录（历史、脚本、导出的日志、已知主机、回退密钥都在里面）
mv ~/.dsh/ssh-telnet ~/.dsh/aiterm

# 3) 凭据库记录改作用域（先备份；这个文件写坏会让 DSH 下次起不来）
cp ~/.dsh/.credentials.yaml ~/.dsh/.credentials.yaml.bak
sed -i 's#^  ssh-telnet/#  aiterm/#' ~/.dsh/.credentials.yaml

# 4) 若用的是文件回退（没有 credentials 服务），同步 secrets.json 的键前缀
sed -i 's#"ssh-telnet/#"aiterm/#' ~/.dsh/aiterm/secrets.json
```

然后卸载旧包、安装当前版本（`dsh-aiterm@0.5.4`）并重启 DSH Web，浏览器 `Ctrl+F5`。不要新旧并存——两者注册同名工具会冲突。

升级后需要自己改的地方：

- **提示词 / 脚本 / 外部调用**里写死的 `ssh_telnet_*` 改成 `aiterm_*`（模型工具名变了）。
- **0.5.3 及更早版本**写下的历史文件没有归属元数据：为了不伪造 owner，AI 不再能检索/导出它们；
  文件原样保留，历史面板的 **[旧历史（无归属）]** 人工入口仍可读取（详见「终端与 AI 会话的归属」）。
- **反向代理 / 书签**里的 `/dsh-ssh-telnet` 路由改成 `/aiterm`。
- **前端本地偏好**（脚本面板的排序、方言选择、快捷条分组可见性）用的是新键 `dsh.aiterm.*`，旧值不迁移，重新设置一次即可。

## 使用

1. 右侧栏打开 aiterm 面板 → **新建连接**，或先保存一个主机档案（profile）。
2. 选择连接方式：SSH（密码 / 私钥 / ssh-agent）或 Telnet。
3. 连接成功后即可直接输入；顶部工具条可随时调整 AI 权限。
4. 让 AI 操作：在对话里让它「读一下 st-1 的屏幕」「在 st-2 上执行 `df -h`」。AI 开始操作时，面板顶部出现 **AI 正在操作 · 人工输入已屏蔽** 提示；点 **接管** 立刻拿回键盘，AI 的后续写入会被拒绝。

## AI 权限模型

每个会话独立维护两件事：

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| `aiAccess` | `ro` / `wo` / `rw` | AI 的读/写能力（只有人能改） |
| `lockOwner` | `null` / `ai` / `human` | 当前控制权归属 |

规则（Host 侧统一执行，AI 工具与浏览器按键走同一入口）：

- AI 读：`ro`、`rw` 允许；`wo` 拒绝 → `AI_READ_DENIED`。
- AI 写：`wo`、`rw` 允许；`ro` 拒绝；`lockOwner === 'human'` 也拒绝 → `AI_WRITE_DENIED`。
- 人工读：永远允许。
- 人工写：`lockOwner === 'ai'` 且 `blockHumanWhileAi: true` 时拒绝 → `HUMAN_WRITE_BLOCKED`。
- AI 一次成功写入即取得控制权；`aiLockIdleMs`（默认 30s）无 AI 写入后自动释放；人工点「接管」立即改为 `human`，AI 调用 `aiterm_release_control` 只能交还自己持有的控制权。

只有人能做：修改 AI 权限、接管、交还控制、保存/删除档案。这些操作不提供模型工具。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `aiterm_list` | 列出会话、状态、AI 权限、控制权 |
| `aiterm_connect` | 通过保存的 profile（推荐）或 ad-hoc agent/none 建立连接 |
| `aiterm_status` | 查看某会话的权限与控制权 |
| `aiterm_read` | **默认增量读**（`mode:"delta"`，只回新输出）；也可 `screen` / `history` / `tail` |
| `aiterm_screen` | 可见屏幕文本；`changedOnly:true` 只回变化行（带行号） |
| `aiterm_screenshot` | `aiterm_screen` 的兼容别名（已精简载荷，不再重复整屏） |
| `aiterm_wait` | 等到「输出停顿 / 出现匹配 / 会话退出」，只回这期间的新输出 |
| `aiterm_history` | 按时间范围/正则检索**本对话所属**会话的历史（含已关闭会话与重启后的历史；关闭权限同样受 AI 只读/只写限制；重复 id 用返回的 `historyId` 精确指定） |
| `aiterm_send` | 发送文本/按键（`\u0003` = Ctrl-C），可选等待并在审计中记录一次 `read:tail` 回读 |
| `aiterm_batch` | 一次调用执行多步（send → waitFor → 只读新输出），可多会话扇出 |
| `aiterm_script_list` | 列出保存的脚本（按分组） |
| `aiterm_script_run` | 运行脚本（支持延迟/变量/if/循环/断言，`{{参数}}` 替换） |
| `aiterm_script_save` | 保存/覆盖脚本（删除仍仅限人在面板操作） |
| `aiterm_resize` | 调整远端子终端尺寸 |
| `aiterm_release_control` | 主动交还控制权给人工 |
| `aiterm_audit` | 读权限审计记录 |
| `aiterm_disconnect` | 断开但保留会话（可重连） |
| `aiterm_reconnect` | 重连该会话（同一 id，历史保留） |
| `aiterm_close` | 关闭会话（终止并从列表移除） |
| `aiterm_export` | 把**本对话所属**会话输出（含已关闭会话）导出为 Host 上的文本日志文件；只写会话拒绝导出；可用 `historyId` 导出重复 id 的指定 incarnation |
| `aiterm_autolog` | 查询自动写日志文件状态；该开关是宿主级隐私设置，**仅限人工**在历史面板修改（默认关闭，开关持久化）。旧版遗留的 `enabled:true` 会先保持关闭并等待人工确认 |

AI 不能提供密码或私钥：需要密码/私钥的连接必须使用保存的 profile，由 Host 侧解析。

以上是 `toolDisclosure: full`（默认）下的完整工具面。`progressive` 会额外常驻一个发现入口
`aiterm_discover`（它不属于上面任何业务分组，也不接触终端）。其余工具的名称、参数、执行体、
owner 绑定和权限判定都不变；唯一的注册差异是它们会额外带一个**步骤级可见条件**，因此要按组
展开后才在下一步可见——见下方「工具渐进披露」。

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖本插件行。**DSH 的补丁层不是深合并**：
按 `id` 匹配的补丁会**整体替换该行的 `config` 对象**，不是只覆盖你写出的键。未写出的键由插件
默认值补齐，所以"只写要改的键"会让其余键悄悄回到默认值——例如 `aiAccessDefault` 默认是
`rw`，此前设为 `ro` 的部署会因为漏写而**放宽 AI 权限**。

因此升级或改配置时请**保留完整对象**并显式写出安全值。下面的示例是全量配置（值均为默认值，
只把 `aiAccessDefault` 显式固定为 `ro`）；请按需修改，不要删掉你依赖的键：

```yaml
- id: aiterm
  name: 'dsh-aiterm'
  config:
    enabled: true
    toolDisclosure: full            # full（默认，21 个工具全量注册）| progressive（先发现、按组展开）
    aiAccessDefault: ro             # 新会话默认 AI 权限：ro | wo | rw；显式写出，避免漏写回落到 rw
    aiAutoLock: true                # AI 写入时是否自动取得控制权
    aiLockIdleMs: 30000             # AI 控制权空闲自动释放时间
    blockHumanWhileAi: true         # 核心行为：AI 操作时屏蔽人工写
    humanCanPreempt: true           # 是否允许人工随时接管
    maxSessions: 16
    scrollback: 4000
    replayBufferBytes: 262144       # 重连回放保留的原始输出字节数
    aiReadMaxBytes: 65536
    deltaDefaultMaxBytes: 8192
    connectTimeoutMs: 20000
    keepaliveMs: 15000
    routePath: /aiterm
    knownHostsPolicy: accept-new    # accept-new | strict | insecure
    terminalType: xterm-256color
    promptPattern: '[#$%>❯»]\s*$'
    # v2 读取 / 历史 / 脚本
    historyRetentionMs: 86400000    # 24 小时
    historyMaxBytesPerSession: 8388608
    historyMaxSessions: 100
    historyFlushIntervalMs: 250
    scriptsDir: scripts
    maxDetachedSessions: 20
    autoReconnect: false
    autoReconnectAttempts: 3
    autoReconnectDelayMs: 2000
```

> 如果你原来就用默认的 `aiAccessDefault: rw`，显式写 `rw` 与不写等价；如果你曾设为 `ro` 或
> `wo`，务必保留该值，否则会被默认的 `rw` 替换。这是 DSH 补丁的替换语义，不是本插件做的
> 深合并；`aiAccessDefault` 只会影响**新会话**，不会改动已存在会话的权限。

`toolDisclosure` 只在插件加载时读取（见下方「工具渐进披露」）；切换取值会重载插件行，
**可能关闭当前终端**。其余配置项与默认值、取值范围见 `CONTRACTS.md`。

## 工具渐进披露（`toolDisclosure: progressive`）

默认的 `full` 保持历史行为：21 个 `aiterm_*` 工具对每个 Agent **无条件**注册，参数、
描述、执行体、终端 owner 和权限判定全部不变。

改成 `progressive` 后，只常驻一个发现入口 `aiterm_discover`；其余工具仍按原名注册，
但附带一个**步骤级**条件：只有当前模型步骤的 Agent 已展开对应分组时才进入该步骤的
工具快照。发现入口本身不接受任何终端操作，也不改变权限。

| 分组 | 成员 | 何时可用 |
| --- | --- | --- |
| `session` | `list` / `status` / `read` / `screen` / `screenshot` / `wait` / `send` / `release_control` | 展开 `session` 后的**下一个**模型步骤 |
| `history` | `history` / `audit` / `export` | 展开 `history` 后的下一个步骤 |
| `automation` | `batch` / `script_list` / `script_save` / `script_run` | 展开 `automation` 后的下一个步骤 |
| `management` | `connect` / `disconnect` / `reconnect` / `resize` / `close` / `autolog` | 展开 `management` 后的下一个步骤 |

> 表中的名字省略了 `aiterm_` 前缀，例如 `session.list` 即 `aiterm_list`。

用法（模型侧）：

1. 第一步调用 `aiterm_discover`（不传参数）：返回当前模式、四组名称、当前 Agent 可见的
   工具、已展开分组、组间依赖提示。
2. 调用 `aiterm_discover { "group": "session" }` 展开一组；再传其他组可继续展开。
   展开是**幂等**的，重复调用不会报错。
3. 从**下一步**开始，该组工具才可调用；同一步里先发现再调用会得到 `UNKNOWN_TOOL`。
4. 先展开 `session` 并 `aiterm_list` 拿到会话 id，history / automation / management
   里的操作才有目标可用。

### 升级注意：工具 allow-list 必须显式加入 `aiterm_discover`

如果部署、Agent preset 或子代理的 `toolFilter` 用 `tools.restrict({ allow: [...] })` 把本插件
的工具限制为一份**白名单**，这份名单通常只包含改动前的 21 个 `aiterm_*` 名字。`progressive`
的常驻发现入口 `aiterm_discover` 是**新名字**：白名单不包含它时，它会在步骤解析阶段被过滤
掉；同时 21 个业务工具又都还没有展开，于是**该 Agent 这一步一个 aiterm 工具都拿不到**。
这是既有安全限制按预期生效，不是可自动恢复的降级，也不能由模型自行绕过。

迁移方式（**不改变任何限制**）：

1. **想用 `progressive`**：在原有白名单里**追加 `aiterm_discover`**，其余 21 个名字保持原样；
   `deny` 仍然优先，白名单外的工具在展开后也不可见。
2. **不想改白名单**：保持 `toolDisclosure: full`；`full` 不注册新名字，白名单行为与升级前
   完全一致。
3. **不要把"放开限制 / 删除 deny / 清空白名单"当作迁移手段**；需要精确白名单时选 `full`。

已用真实 DSH `ToolsService` 固定这两个场景：只含 21 个旧名字的白名单得到空步骤快照；追加
`aiterm_discover` 后发现可用，展开后仍只出现白名单内工具（白名单外的 `aiterm_send` 和整个
automation 组即使展开也不可见）。见 `test/disclosure-runtime.test.mjs`。

边界与限制：

- **每次展开只属于一个 Agent 对象**：子 Agent、fork、恢复（resume）或重开后的新 Agent
  （即使复用同一个 session id）都从收起状态开始，不继承父级或旧对象的展开；`agent/disposed`
  或插件卸载也会清空该 Agent 的展开状态。
- **终端归属与展开身份是两件事**：终端按 DSH 会话 id（owner）隔离，展开按当前 Agent
  对象记忆。恢复后的新 Agent 用同一 owner id 仍能看到同一终端，但必须重新展开；换一个
  owner id 则照常 404，不会因为展开而越权。
- **发现不是授权**：只读 / 只写（`aiAccess`）、人工接管（`lockOwner === 'human'`）、
  AI 控制权、审计等判定仍在调用时由 Host 侧统一执行；展开前后拒绝码完全一致，
  详见「AI 权限模型」。被其他工具限制隐藏的工具不会出现在发现结果里，展开也不会放宽它。
- **非模型步骤不能直接执行条件工具**：条件工具只在 DSH 解析出的模型步骤快照里可用；
  绕过步骤的直接调用（例如没有 `agent` 的 `tools.executable`、旧快照、后台脚本）在
  progressive 下看不到它们，这是预期行为。需要脚本/批次能力时先展开对应分组。
- **发现/展开不重启插件、不断开终端**：它们只改内存中的展开集合，正在运行的
  `aiterm_wait` / `aiterm_batch` 等调用不会被中断。
- **progressive 依赖模型遵守提示词**：模型若不先发现就直接猜工具名，会收到
  `UNKNOWN_TOOL`；`full` 没有这个前置条件。工具多、模型上下文紧张时用 progressive。

### 切换与回滚（会重载插件）

> **重载的三项影响**：切换 `toolDisclosure`（或本插件行的任何配置）
> 会重载插件行，并同时发生：
> ① **关闭所有当前终端**（不保留连接，重开后是新的远端 shell）；
> ② **清空内存审计**（审计不落盘）；
> ③ 输出历史按保留期留在磁盘。会话 id 现在由历史目录的 `.ids/st-N` 原子 reservation 跨重启续号，
> 不再从 `st-1` 重来；每次打开会话仍预留**独立日志文件**并写入私有 `owner`/关闭权限元数据。
> 即使遇到旧的重复 incarnation，它们也会逐条列出并带独立 `historyId`，不会混用/合并权限。
> 切换前请确认没有正在跑的命令，并接受需要重开终端、重新发现工具、重新积累审计。

`toolDisclosure` 是插件行配置，**没有热切换**。修改后 DSH 会重载/重启该插件行：

- 插件持有的终端 registry 会随卸载销毁，**当前终端会被关闭**（不保留连接）；重新打开
  后远端是新 shell（屏幕重置）。
- 输出历史写入数据目录并按保留期保留（默认 24 小时；写入是 best-effort，磁盘失败只告警，
  不阻塞终端）。每个会话日志自带私有归属与关闭权限，历史面板/导出/工具都按 owner 过滤；
  插件重载后会话 id 会从已预留的高水位继续，不会复用旧 id；即便出现历史重复 id，也会以独立
  `historyId` 列出并单独导出。升级前没有归属元数据的旧日志不会被自动认领，AI 不可读
  （见「终端与 AI 会话的归属」）。
- 展开状态和**审计**都只存在内存中：审计是每会话/全局的环形缓冲，不落盘，插件重载或
  DSH 重启后清空。重载后模型需要重新 `aiterm_discover`。
- 建议在两次操作之间、没有正在跑的命令时切换；不要在长命令执行中切换。

回滚：把 `toolDisclosure` 改回 `full`（或删掉该项）并重载插件/重启 DSH Web。`full`
不注册 `aiterm_discover`，21 个工具恢复无条件注册。终端需要重新打开；脚本和 profile 是
磁盘数据，不受影响；输出历史按保留期保留（历史面板/导出可读取这些文件，但重启后的
归属与可见性见「终端与 AI 会话的归属」）；审计只在内存中，重载后已清空。无需迁移数据。

## 读取方式与 token 成本

| 场景 | 建议用法 | 典型开销 |
| --- | --- | --- |
| 追一条长时间命令的输出 | `aiterm_read`（默认 delta）+ 上次返回的 `cursor` | 只有新输出，几十到几百字符 |
| 判断命令是否跑完 | `aiterm_wait {until:"idle"}` 或 `{until:"pattern"}` | 一次调用 + 新输出 |
| 看 vim/top 之类全屏界面 | `aiterm_screen {changedOnly:true}` | 只回变化的行 |
| 排查"刚才发生了什么" | `aiterm_history {since:"10m", search:"ERROR"}` | 命中行 + 时间戳 |
| 一组固定操作 | `aiterm_batch` 或保存脚本 | 一次调用，逐步只回新输出 |

## 首次打开

没有会话时，面板**默认打开配置管理**（连接库），可在其中选择已有配置连接，或点「新建连接」。
不会再一进来就是一张空表单。

## 界面导航

所有非终端页面（新建/编辑连接、配置管理、历史、脚本）共用同一个页头：**← 返回 · 标题 · × 关闭**。

- **返回回到来处**：面板内部维护一个视图栈。配置管理 → 编辑某条配置 → 返回，回到配置管理；
  终端 → 历史 → 返回，回到终端。根视图是终端（或没有会话时的配置管理），不会被弹空。
- **Esc = 一次退一层**：整个面板只有一个 Esc 处理者；行内编辑/行内确认条会先吃掉 Esc（取消自己），
  不会一次退两层。
- **终端视图有常显入口**：标签行右侧的「配置管理」按钮带文字，不再只是一个图标。
- **按钮尺寸**：文本按钮高 32px、图标按钮 30px（会话标签行的关闭按钮 26px）、控件字号 12–13px，
  命中区域按触摸场景放宽。

### 增删改的确认方式

- **删除配置**、**关闭会话**、**删除脚本**都改成**行内确认条**（`确认删除 xxx？[确认][取消]`），
  不再用「3 秒内点两次」的定时器：既不会误触，也不会因为犹豫几秒就得重来。
- 删除配置后会清掉对应的密码/私钥/口令；关闭会话会断开连接并从列表移除（不可恢复）。
- 保存配置后自动回到列表，并**高亮刚保存的那一行**。
- 配置行操作常显：`连接`（主）/ `编辑` / `重命名` / `移动文件夹` / `删除`，不靠 hover 才出现。

## 会话中断与重连

- **中断**（`sessions.disconnect` / 工具 `aiterm_disconnect`）：断开传输但**保留会话**——同一 `id`、标题、
  AI 权限、输出历史、审计都还在，列表里标记为 `disconnected`。
- **重连**（`sessions.reconnect` / 工具 `aiterm_reconnect`）：复用同一 `id` 重新连接，`generation` +1，
  AI 权限与历史延续；远端是新的 shell，所以**屏幕会重置**（客户端清屏并提示），但历史检索仍覆盖断开前的内容。
- **掉线不再丢会话**：远端主动断开或网络中断时，会话进入 `disconnected`（记录 `closeReason`），点一下即可恢复；
  只有显式「关闭」才会移除。
- 重连的认证材料：有配置走配置（会重新读取，密码轮换也能生效）；ad-hoc 会话的凭据只留在 Host 进程内存，
  从不落盘/回传；两者都没有时返回 `RECONNECT_NO_CREDENTIALS`，请用配置重连。
- 保留上限：同时最多保留 `maxDetachedSessions`（默认 20）个断开会话，超出按最早断开修剪。

## 配置管理

面板里的 **配置管理** 支持按文件夹分组维护连接配置：

- 新建 / 编辑 / 重命名 / 删除配置；删除会同时清掉该配置的密码、私钥与口令。
- 移动到分组、取消分组；新建分组；连接表单保存时可直接选分组。
- 重命名只改显示名，**id 不变**（id 是凭据键的一部分，改了会丢密码）。
- 编辑时密码/私钥留空表示"保持原值"，只有显式清空才会删除。
- 所有配置写操作仅限人工（AI 无法读写你的凭据）。

## 终端与 AI 会话的归属

**每个 DSH（AI）会话单独维护自己的 SSH/Telnet 终端**：在对话 A 里打开的终端，切到对话 B 就看不到，
也不会被 B 的 AI 读到或操作。

- 客户端把当前 DSH 会话 id 作为 `owner` 带在每次会话相关调用上，SSE 流也按 `?owner=` 过滤
- 宿主侧按 `owner` 隔离：`sessions.list`、读写、断线重连、权限、审计、历史查询、日志导出**按 owner 过滤**；
  用别的对话的 id 访问**存活会话**一律 404，且文案与「id 不存在」完全一致（不泄露存在性）
  - 持久历史同样按 owner 隔离：每个日志文件头部保存私有 `owner`，关闭时追加私有 AI 权限；
    归属不依赖进程内记忆，也不依赖可被其他实例覆盖的 `index.json`
- `maxSessions` / `maxDetachedSessions` **按每个 AI 会话分别计数**，一个对话开满不会影响另一个
- AI 通过工具创建的终端，归属**调用它的那个 AI 会话**（工具 schema 里没有 owner 参数，模型无需关心）
  - 身份取自 DSH 的 `agent.id`（兼容 `agent.session.id`）；**子代理**开的终端归到它所属的那个对话，
  **fork** 出来的新对话则各管各的
  - 万一宿主读不出调用方身份，工具会直接报 `OWNER_UNKNOWN` 而不是造一个谁都看不见的终端
- 哪些是宿主级、不按会话隔离：连接配置（`profiles`）、保存的脚本（`scripts`）、自动写日志开关。
  自动写日志开关会写到*所有*会话，因此只允许人工在面板修改，AI 的 `aiterm_autolog` 只能查询
- **[旧历史（无归属）]** 是明确的人工入口：不向 AI 暴露，不自动给旧文件补 owner，查看/导出都不改写、不删除旧文件
- `导出全部` **不是**跨对话操作：它只导出本对话拥有的终端（含已关闭的、且 AI 可读的）；重复 id 的旧 incarnation 用 `historyId` 单独导出

> 切换 DSH 会话时面板会清空并重新拉取，这是设计行为——不会把上一个对话的终端带过来。
> **历史的安全边界**：每次打开会话都会用 `wx` 独占创建 `<sessionId>~<uuid>.ndjson`，因此两个
> 并行/重载的宿主实例、旧实例延迟的异步 flush 都不会写进同一个文件；`owner` 和关闭时的
> `aiAccess` 作为私有元数据写在该文件里。只写（wo）的 AI 不能读、检索或导出**已关闭**会话；
> 关闭权限未记录（崩溃）或缺失归属的日志对 AI 一律拒绝。升级前的旧日志没有归属，保留在磁盘
> 上但不会被自动分配给任何新 owner：**AI 完全不可读**，只有历史面板的 **[旧历史（无归属）]**
> 人工入口可读；旧文件不会被改写或删除。

## 会话与协议

- 会话标签上是**带颜色的协议徽标**：`SSH` 用强调色、`TELNET` 用告警色；徽标同样出现在侧栏 tab 标题里，
  同一条 rail 上同时挂 SSH 和 Telnet 会话时一眼可分。
- 每个会话独立：各自的标题/主机/端口、断线重连、AI 权限、审计、输出历史互不影响。

## 日志导出与自动写文件

**导出**（历史面板底部）：

| 按钮 | 作用 |
|---|---|
| 导出当前 | 把当前选中会话的输出写成一个文本文件 |
| 导出全部 | 本对话拥有的每个终端各写一个文件（含已关闭的；AI 只写会话不导出） |

- 输出目录：`~/.dsh/aiterm/exports/`，文件名 `<会话id>-<incarnation短码>-<标题>-<时间戳>.log`（旧版/无 historyId 的文件不带短码；同一 id 的多个 incarnation 不会互相覆盖）
- 内容：头注释（协议 / `user@host:port` / 标题 / 开始时间）+ 每行 `<ISO 时间戳> <输出行>`
- 文件写在**宿主机**上（不是浏览器下载），用 DSH 的文件面板取走即可；导出结果面板会列出路径、大小、行数
- 导出失败会显示原因；若提示「重启 DSH 后可用」，说明宿主代码还是旧代际

**自动写日志文件**（默认关闭）：

- 历史面板里的「自动把每个会话写进日志文件」开关，打开后每个会话实时追加写入
  `~/.dsh/aiterm/logs/`（可在 Host 侧改目录）
- 开关状态存在 `~/.dsh/aiterm/settings.json`，重启后保持；写失败只会告警一次并自动停写，
  不影响会话本身
- **该开关是宿主级的**：一开就会记录*所有*对话的终端输出，因此只有人工可以在面板修改；
  AI 工具 `aiterm_autolog` 只能查询状态，任何开启/关闭/改目录的尝试都会以 `HUMAN_ONLY` 拒绝。
  AI 仍可用 `aiterm_export` 导出**自己 owner 下、AI 可读**的历史（wo 会话拒绝）
- **从旧版本升级时的安全迁移**：旧版允许 AI 开启自动日志，升级后若读到没有人工确认标记的
  `enabled:true`，*运行时*保持关闭并显示人工确认提示；**原 `settings.json` 和目录不会被自动改写**。
  人工在面板选择「继续启用」或「保持关闭」后才会写入确认标记。若人工不操作，重启后仍保持关闭。
  这是有意的兼容性变化：升级后既有自动日志不会立即继续，需人工确认一次。

### 0.5.4 升级/回滚与历史兼容

- **升级**：不需要迁移命令，也不改写/删除现有历史或 `settings.json`。第一次启动会扫描历史头并在 `history/.ids/` 建 id reservation；旧文件保持原样。
- **会话 id**：从 0.5.4 起跨重启续号，不再回到 `st-1`；如果历史目录被清空，续号信息也一起丢失。
- **重复 id**：列表会显示全部 incarnation（各带 `historyId`）；旧客户端只按 `sessionId` 取最新一条（兼容），新客户端/工具用 `historyId` 精确访问。
- **回滚**：0.5.3 能读新日志头但仍只挑最新 incarnation；0.5.2 及更早看不到新文件名格式。回滚不会删除旧文件，但旧 incarnation 可能重新变得不可见；需要完整访问时请保留 0.5.4。自动日志若在 0.5.4 已人工确认过，`settings.json` 带 `reviewedAt`；回滚到旧版会按其旧逻辑读取 `enabled`。
- **旧历史入口**：`[旧历史（无归属）]` 只在面板提供，AI 工具没有对应参数；旧文件永远不自动补 owner。

## 脚本

脚本是**纯数据**（不执行任意代码），支持多脚本、分组与参数：

| 能力 | 写法 |
|---|---|
| 发送命令 / 等待 / 回读 | `{ send, enter, waitFor:{pattern,idleMs,timeoutMs}, read:'delta'\|'screen'\|'none' }` |
| 延迟 | `{ delay: 500 }`（毫秒） |
| 变量 | `{ set: "name", value: "{{param}}-x" }`，所有字符串支持 `{{name}}` |
| 条件分支 | `{ if: {match:"ok"\|contains:"x"\|variable:"v",equals:"y"}, then:[...], else:[...] }` |
| 循环 | `{ loop: { count: 3 }\|{ while: Cond }\|{ until: Cond, maxIterations: 20 }, steps:[...] }` |
| 断言 | `{ expect: Cond, onFail: 'stop'\|'continue' }` |
| 日志 | `{ log: "..." }` |

- 条件看的是"自上次条件判断以来的输出"，所以 `发送 → 立刻 if/expect` 能看到刚产生的输出。
- **步骤之间是严格顺序执行的，但 `send` 默认不等待**：写完就进入下一步，不会自动等远端输出。
  想"等命令跑完再发下一条"，二选一：
  - 在该步骤里写 `waitFor`：`{ send:"ls", enter:true, waitFor:{ idleMs:250, timeoutMs:5000 } }`（等输出停顿）
    或 `waitFor:{ pattern:"\\$\\s*$", timeoutMs:5000 }`（等提示符回来）；
  - 或在两条命令之间插 `{ delay: 500 }` 固定间隔。
  `delay` 会真的睡满；`expect` / `if` / `loop.while` / `loop.until` 会读取输出（有读窗口）。
  多目标时每个目标各自顺序执行；`parallel: true` 才是目标之间并发。
- 面板进度里的 `#0`、`#1` 是**步骤序号**（嵌套步骤显示成 `3.2` 这样的路径，并标注 send/delay/if/loop 类型）。
  如果进度里出现"未知"，那是事件来自 AI 工具（`aiterm_batch`）而非面板运行——工具事件只带序号，
  不带步骤类型，面板就回退显示 `#n · 未知`。
- 上限：500 步、嵌套 5 层、单循环 1000 次（默认 100）、50 个变量、单变量 8 KiB、整脚本 10 分钟。
- 每次 `send` 仍走权限闸口：AI 只读会失败，人工接管会中止。
- 其他工具：`aiterm_script_list` / `_run` / `_save`（删除仅限人在面板操作）。

## 快捷脚本条

终端底部有一条**快捷脚本**条（点「⚡ 快捷脚本」展开）：脚本按文件夹分组，点一下就用在当前会话上，
参数取脚本里声明的默认值。日常「查个负载/看个磁盘」不用再开面板。脚本在「脚本」面板里维护，
保存后展开快捷条即可看到。

## 脚本编写：逐行命令（推荐）

新建脚本默认是**逐行命令**：一行一条，直接发送；`@` 开头是控制行。

```text
# 注释
uname -a
@wait 300
df -h
@expect continue Filesystem
@python
print('hello from the remote host')
@end
```

| 写法 | 含义 |
|---|---|
| 普通行 | 发送该命令（带回车） |
| `@raw 文本` | 发送但不带回车 |
| `@wait 500` / `@wait 2s` | 暂停 |
| `@set name = value` | 定义变量（`{{name}}` 可在任意字符串里用） |
| `@log 文本` | 写进运行日志 |
| `@expect 文本` / `@expect continue 文本` | 断言输出匹配，失败时停止 / 继续 |
| `@python … @end` | 把代码发到**远端** python3 执行 |

- 命令**按行原样发送**，不会自动等待：想等命令跑完再发下一条，就在中间写 `@wait`（或在该行之后加
  `@expect` 断言）；`@wait 500` / `@wait 2s` 都可以。
- 需要 `if` / `loop` 等结构时改用 **高级脚本**（新建时选择类型）；两种类型各自独立，不互相转换。
- 编译在浏览器侧完成，存进 Host 的仍是同一份步骤数组，安全与权限规则完全不变。
- **为什么不用真正的 Python 写脚本**：那等于在 Harness 进程里执行任意代码（安全退步），
  且本镜像没有 `python3`。要用 Python，就写 `@python … @end`，让**远端服务器**的 python3 跑。

## 脚本分组与两种编写方式

**两种写法各自独立，互不转换**（按脚本创建时选择）：

| 类型 | 适合 | 编辑器 |
|---|---|---|
| 逐行命令 | 一串要按顺序发的命令 | 一行一条，`@` 开头是控制行 |
| 高级脚本 | 需要 `if` / `loop` 结构 | JSON 步骤数组 |

- 新建时选类型（**新建 · 逐行命令** / **新建 · 高级脚本**）；列表里每行带方言小标签。
- 编辑器顶部显示当前脚本的方言，不再提供互相切换的开关。
- **分组管理**：编辑器里有「名称 / 分组」（分组可内联新建）；列表的分组表头可以**重命名分组**、
  **删除分组**（删除时组内脚本移到未分组）。
- **快捷脚本条的分组可见性**：快捷条头部的「分组显示」勾选清单决定哪些分组出现在快捷条上，
  选择会记住。

### 脚本面板（主从管理）

- 顶部 `分组:` 下拉 + [添加分组][重命名分组][删除分组]
- 左栏底部「＋ 新建」——点了才弹出**类型菜单**（`逐行命令` / `JSON（高级）`），选哪个就按哪种类型创建；
  已打开脚本的类型显示在右栏的只读标签里（不做互转）
- 左栏：当前分组的脚本列表；下方 [＋新建][−删除][▲上移][▼下移][复制]
- 右栏：名称 / 分组 / 类型（只读）/ 模板 / 内容 + [保存][取消]；内容框会**撑满剩余高度**，不再固定 120px
- 运行区在下方：运行目标（当前 / 选定 / 全部）+ 参数 + 运行

> **模板下拉随类型变化**：逐行命令只列宏模板（发送命令 / @wait / @set / @log / @expect / Python），
> 高级脚本只列 JSON 骨架（send / delay / set / log / expect / if / loop）。
> ▲▼ 的排序是**本机显示顺序**（存在浏览器 localStorage），不影响脚本执行；换浏览器会回到默认顺序。

### 运行结果

运行只占一行摘要（`运行完成 · N 步 · 共 X 个会话，Y 个成功`）。点 **[查看结果]** 弹出独立窗口看完整
步骤明细：运行中会自动打开，Esc 或 × 只关这个窗口（不会把脚本面板一起关掉）。

## 数据与安全

> **凭据文档是共享的。** 本插件只通过 **records**（`aiterm/<id>`）写自己的条目，并在写入后回读校验；
> 同时把每个密钥镜像到 `~/.dsh/aiterm/secrets.json`（0600）。若凭据库无记录，读取会回落到镜像，
> 因此"保存了却显示没有密码"不会静默发生。其他插件若把 API key 填进 `apiKeyEnv` 之类的
> "环境变量名"字段，会写坏整个文档（详见 VERIFICATION §12），那不是本插件能控制的。

- 主机档案（非机密字段）：`~/.dsh/aiterm/profiles.json`（0600）。
- SSH 主机指纹：`~/.dsh/aiterm/known_hosts`，不写入用户自己的 `~/.ssh/known_hosts`。
- 密码 / 私钥 / 私钥口令：走 Host `credentials` 服务的 **records** 通道，键形如
  `aiterm/<profile>`（私钥 `-key`、口令 `-pass`）。DSH 的 `records:` 只接受
  `<scope>/<id>` 且每段匹配 `/^[a-z][a-z0-9-]*$/`，本插件只通过
  `credentialKeyFor()` 生成键并在写入前校验；不可用时回退到
  `~/.dsh/aiterm/secrets.json`（0600）并打印告警。
- ⚠️ **不要改回 `credentials.set('aiterm/…')`**：`refs:` 段只接受 POSIX 标识符
  （`/^[A-Za-z_][A-Za-z0-9_]*$/`），写入当时不报错，但会让凭据文档在**下次启动**时
  无法解析，导致 DSH 起不来（本项目曾因此事故）。`test/secrets.test.mjs` 会拦截这种回退。
- RPC 与 SSE 路由经 `connection.admit()` 认证（可信来源 + 签名 Cookie），非授权请求返回 401/403。
- 审计只记录输入预览（控制字符剔除、≤200 字符），不记录机密内容。
- 终端历史：`~/.dsh/aiterm/history/<sessionId>~<uuid>.ndjson`（0600）。每个文件第一行是私有归属元数据，关闭时追加私有 `aiAccess`；`index.json` 仅用于读取升级前的旧目录/旧日志，新日志通过扫描文件头恢复，不依赖共享索引（多个宿主实例并发时索引的最后写入者不会改变归属）。
- 会话 id 预留：`~/.dsh/aiterm/history/.ids/st-N`（0600，空文件）。首次分配用 `wx` 原子创建，跨重启/跨进程保证 `st-N` 不再复用；这些 reservation 不会被保留策略删除。
- 升级前的旧历史 `<sessionId>.ndjson` 原样保留；保留策略不会删除或改写它们，代码也不会把新会话追加进去。
- 新格式日志的每个 incarnation 都有独立 `historyId`（形如 `st-1~<uuid>`）；列表会逐条展示，工具/面板把 `historyId` 传回即可精确检索/导出，不会合并权限。关闭只写回本进程实际打开的那个 incarnation；reservation 失败时绝不回退给旧日志补权限。

## 已知限制

- AI 截屏基于 headless 终端模拟，全屏 TUI 的鼠标/图片类内容无法表达。
- Telnet 协议本身明文传输（建议只在可信网络使用）。
- 浏览器端把 RPC 前缀硬编码为默认的 `/aiterm`；若改了 `routePath`，需要同步修改 `client/api.js` 并 `npm run build`。
- 升级前的历史文件没有归属/关闭权限元数据：为了不伪造归属，它们对 AI 完全 fail closed；只有历史面板的 **[旧历史（无归属）]** 人工入口可以读取。旧文件保留、不会被自动删除（保留策略只清理新格式日志）。
- 同一 `st-N` 若因旧数据/异常出现多个 incarnation，列表会列出全部并带独立 `historyId`；只传 `sessionId` 的旧调用者仍取最新一条（兼容），新调用者应回传 `historyId` 精确访问。不会把两条的权限/owner 合并。
- 已关闭会话的历史读取/导出只在内存审计里记录**活跃**会话（关闭会话没有进程内审计归属）；如果完整审计是硬要求，需要另行设计持久审计。
- **验证范围**：披露/权限测试跑在真实 DSH `ToolsService`、真实 `SessionRegistry` 和真实权限代码上，但模型侧使用 stub LLM、传输使用内存桩；**没有使用真实 provider/模型，没有测量 token 用量、缓存命中或成本，也没有连接真实 SSH 主机**。因此真实 provider/model/token/cache/cost 与真实 SSH 行为均未验证。
- 提示符识别是正则启发式，非标准 shell 集成；可通过 `promptPattern` 按需调整。
- 面板视觉验证需要浏览器环境；本项目环境无浏览器控制能力，界面仅做了构建与注册级验证。

## 开发

```bash
npm install          # 运行时依赖 ssh2 / @xterm/headless / @xterm/addon-serialize，
                     # 以及构建用 devDeps：esbuild、@xterm/xterm、@xterm/addon-fit
npm run build        # 从 client/**.jsx 重新生成 lib/client.js（模块 id 取自 package.json 的 name）
npm run build:vendor # 重新打包 vendor/ssh2.cjs（需要 devDependency ssh2 + esbuild）
npm run lint         # node --check 全部 Host 端源码
npm test             # Host 端 node:test（权限/披露等）+ 客户端冒烟：槽位注册、locale 键、RPC 方法覆盖
```

改了 `client/` 一定要重新 `build` 并提交 `lib/client.js`：`lib/` 是仓库的一部分，
用户装包时不跑构建。

接口契约见 [CONTRACTS.md](./CONTRACTS.md)。

## License

MIT © yejianping

# CONTRACTS — @dsh/aiterm

Authoritative interface contract for all contributors. Do not change this file; if an
interface must change, report it to the Lead instead of editing.

Package root: `/root/workspace/ssh_telnet/aiterm`
Package name / bundle row id / client module id: `@dsh/aiterm` (row id `aiterm`)

Renamed from `@dsh/dsh-ssh-telnet`: 0.4.0 renamed only the package, 0.5.0 renamed the rest —
model tool names `aiterm_*`, route prefix `/aiterm`, data directory `~/.dsh/aiterm`, credential
scope `aiterm/`, localStorage keys `dsh.aiterm.*` and tab kind `aiterm`. No legacy alias is kept.
Reference implementations to read (read-only, do NOT copy blindly):
- `/tmp/tgz/dsh-live-terminal/package` — right-sidebar terminal panel, host tools, SSE routes
- `/tmp/tgz/_xgone_dsh-netshell/package` — SSH sessions, profiles, settings page
- `/tmp/tgz/dsh-plugin-ssh/package` — ssh2 usage

## 0. Ownership / write scopes

| Owner | May write |
|---|---|
| Lead | `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/**`, `README.md`, `lib/index.js`, `lib/host/{config,permission,registry,routes,tools,prompt,profiles,util}.js` |
| transport teammate | `lib/host/transports/**`, `lib/host/screen.js`, `test/transport-*.mjs` |
| client teammate | `client/**`, `scripts/**`, `lib/client.js` |
| qa teammate | `test/**` (except `test/transport-*`), `tools/**` |

Never edit another owner's file. Shared runtime deps are installed by the Lead in the
package root; client-side deps are bundled by the client build, not required at runtime.

## 1. Transport adapter interface (`lib/host/transports/{ssh,telnet}.js`)

Both modules export exactly one function:

```js
export async function connect(options, handlers) -> Promise<TransportConnection>
```

`options`:
```
{
  host: string, port: number,             // telnet: username ignored
  username?: string,                       // ssh only
  auth?: { type: 'password', password: string }
        | { type: 'privateKey', privateKey: string, passphrase?: string }
        | { type: 'agent' }
        | { type: 'none' },                // default 'none'  cols: number, rows: number,
  connectTimeoutMs?: number,               // default 15000
  keepaliveMs?: number,                    // default 15000
  readyTimeoutMs?: number,                 // default 20000
  hostKeyPolicy?: 'accept-new' | 'strict' | 'insecure', // ssh; default 'accept-new'
  knownHostsPath?: string,                 // ssh; default <dataDir>/known_hosts
  term?: string,                           // default 'xterm-256color'
}
```

`handlers` (all optional except onData):
```
{
  onData(chunk: string): void,   // ALREADY decoded UTF-8 string; telnet IAC sequences removed
  onReady(info: { hostKeyFingerprint?: string, banner?: string }): void,
  onClose(info: { code?: number|null, signal?: string, reason?: string }): void,
  onError(error: Error): void,   // connection-level failure; close is still emitted afterwards at most once
}
```

`TransportConnection`:
```js
{
  readonly kind: 'ssh' | 'telnet',
  readonly ready: Promise<{ hostKeyFingerprint?: string, banner?: string }>, // rejects on connect failure
  write(data: string | Buffer): void,     // throws only when not open
  resize(cols: number, rows: number): void,
  close(reason?: string): Promise<void>,  // idempotent, resolves after the socket/channel is gone
  readonly state: 'connecting' | 'open' | 'closed',
}
```

Rules:
- `connect()` resolves once the underlying connection is ESTABLISHED (or the telnet socket
  is connected), not before. Connection failure rejects `connect()` **and** rejects `ready`.
- `onData` must never receive telnet negotiation bytes; SSH must not receive window-change
  control data. Output must be forwarded in arrival order.
- `close()` must stop emitting events after it resolves; late events are ignored.
- No `@deepseek-ai/*` imports. Only Node builtins plus `ssh2` (already a package dependency).

## 2. Screen emulator (`lib/host/screen.js`)

```js
export class Screen {
  constructor(options: { cols: number, rows: number, scrollback?: number })
  write(text: string): void           // feed raw terminal output (ANSI allowed)
  resize(cols: number, rows: number): void
  snapshot(): { cols, rows, cursor: { x, y }, lines: string[], alt: boolean } // visible screen
  text(): string                      // visible screen, trailing blank lines trimmed, joined by '\n'
  historyText(maxLines?: number): string  // scrollback + visible, oldest first
  dispose(): void
}
```

Use `@xterm/headless` (`HeadlessTerminal`) + `@xterm/addon-serialize` when available; fall back
to a small internal ANSI-stripping line buffer if the import fails, so the plugin still works.
`screenshot`/`read` tools depend on this, so `text()` must be readable and bounded.

## 3. Session model

Host-side session record (never contains a password or private key):

```js
{
  id: 'st-1',                      // stable, monotonically increasing
  title: 'root@10.0.0.5',
  transport: 'ssh' | 'telnet',
  host, port, username,
  profileId: string | undefined,
  state: 'connecting' | 'open' | 'closed' | 'failed',
  error: string | undefined,
  cols, rows,
  createdAt: number, updatedAt: number,
  lastActivityAt: number,
  bytesIn: number, bytesOut: number,
  permission: PermissionState,
}
```

`PermissionState`:
```js
{
  aiAccess: 'ro' | 'wo' | 'rw',   // AI read/write capability
  lockOwner: 'ai' | 'human' | null, // who holds the exclusive control token
  lockExpiresAt: number | null,     // epoch ms; AI lock auto-expires, human lock does not
  humanWriteBlocked: boolean,       // derived: lockOwner === 'ai' && config.blockHumanWhileAi
  aiWriteBlocked: boolean,          // derived: aiAccess === 'wo' ... etc (see §4)
}
```

## 4. Permission semantics (authoritative)

Sources: `'human'` (browser HTTP path) and `'ai'` (model tools).

Read (screen/output/snapshot):
- human: always allowed.
- ai: allowed iff `aiAccess ∈ {ro, rw}`.

Write (input sent to the remote pty/socket):
- human: allowed unless `lockOwner === 'ai' && config.blockHumanWhileAi === true`
  → error code `HUMAN_WRITE_BLOCKED`.
- ai: requires `aiAccess ∈ {wo, rw}` (else `AI_READ_ONLY` / code `AI_WRITE_DENIED`), and
  `lockOwner !== 'human'` (else `AI_WRITE_DENIED`, "human holds control").

Lock lifecycle:
- An AI write with `config.aiAutoLock === true` (default) sets `lockOwner = 'ai'` and
  `lockExpiresAt = now + config.aiLockIdleMs` (default 30000), refreshed on each AI write.
  A timer clears the lock when it expires.
- `lock.takeOver` (human action) sets `lockOwner = 'human'` (AI writes are then denied until
  released). `lock.release` (human action) sets `lockOwner = null` and clears expiry.
- `config.blockHumanWhileAi === false` disables human-write blocking (pure coexistence mode).
- `config.aiAccessDefault` default `'rw'`; each new session starts from it.

User-only actions (never callable from a tool): `permission.set`, `lock.takeOver`,
`lock.release`, `profiles.save`, `profiles.delete`. The registry methods take an `actor`
argument and reject when `actor === 'ai'`.

Audit: every read/write/deny appends `{ at, sessionId, source, action: 'read'|'write'|'deny'|'lock', detail, byteLength }`
to a bounded per-session ring (last 200). Never log secret data; for writes log the
first 200 chars with newlines escaped.

## 5. Wire protocol (Host HTTP + SSE)

All routes under `/aiterm`. Authenticated by `ctx.connection.admit(req)`; any
non-admitted request gets 401/403. JSON only.

`POST /aiterm/rpc`
Body: `{ "method": string, "params": object }`
Response: `{ "ok": true, "result": any }` or
`{ "ok": false, "error": { "code": string, "message": string } }`.

Methods (params → result):
| method | params | result |
|---|---|---|
| `sessions.list` | `{}` | `{ sessions: SessionInfo[] }` |
| `sessions.create` | `{ transport, profileId?, host?, port?, username?, auth?, password?, privateKey?, passphrase?, title?, cols?, rows? }` | `{ session }` |
| `sessions.close` | `{ id }` | `{ ok: true }` |
| `sessions.rename` | `{ id, title }` | `{ session }` |
| `sessions.resize` | `{ id, cols, rows }` | `{ ok: true }` |
| `sessions.replay` | `{ id }` | `{ session, replay: base64 }` |
| `sessions.input` | `{ id, data }` | `{ ok: true }` (source `human`) |
| `permission.get` | `{ id }` | `{ permission }` |
| `permission.set` | `{ id, aiAccess }` | `{ permission }` (human only) |
| `lock.takeOver` | `{ id }` | `{ permission }` (human only) |
| `lock.release` | `{ id }` | `{ permission }` (human only) |
| `profiles.list` | `{}` | `{ profiles: ProfileInfo[] }` |
| `profiles.save` | `{ profile }` | `{ profile }` (human only) |
| `profiles.delete` | `{ id }` | `{ ok: true }` (human only) |
| `audit.list` | `{ id?, limit? }` | `{ entries: AuditEntry[], sessions?: SessionInfo[] }` |

`ProfileInfo`:
```js
{ id, name, transport: 'ssh'|'telnet', host, port, username, authType: 'password'|'privateKey'|'agent'|'none',
  hasPassword: boolean, hasPrivateKey: boolean, updatedAt: number }
```
Private keys may be stored in the profile; passwords are stored via `ctx.credentials`
(see §7) and are never returned.

`GET /aiterm/events` (global, no query) — SSE, `data: <json>` frames:
- `{ "type": "sessions", "sessions": SessionInfo[] }` immediately and on any list change
- `{ "type": "state", "session": SessionInfo }` on state/permission/lock changes
- `{ "type": "audit", "entry": AuditEntry }`

`GET /aiterm/events?sessionId=<id>` — SSE per session:
- `{ "type": "hello", "session": SessionInfo, "replay": base64 }`  (replay = retained raw output bytes)
- `{ "type": "data", "chunk": base64 }`  (raw pty bytes; client writes them to xterm)
- `{ "type": "state", "session": SessionInfo }`
- `{ "type": "exit", "code": number|null, "reason": string }`
- `{ "type": "audit", "entry": AuditEntry }`

Heartbeat comment line `:\n\n` every 20s. Close the SSE response when the session closes,
after sending `exit`.

## 6. Client contract

Client artifact: `lib/client.js`, CommonJS wrapper exactly like:

```js
window.__ModuleLoader__.load({
  id: '@dsh/aiterm',
  factory(require) {
    ...bundled CJS...
    return module.exports   // { inject: [...], apply(ctx) {} }
  },
})
```

`package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
"client": { "platform": "web", "immediately": true,
"inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] } }`.

Client plugin exports `inject` (at least `['slots']`) and `apply(ctx)`. Available on ctx:
`ctx.slots`, `ctx.locale`, `ctx.effect`, `ctx.sidebarRightTabs` (register tab types),
`ctx.sidebarRight` (openTab / isExpanded). Do **not** `require('@deepseek-ai/*')` except
`react` and `react/jsx-runtime`; do not import client primitives — write the controls.

Tab type registration (proven by dsh-live-terminal):
```js
const off = ctx.sidebarRightTabs.register({
  id: '@dsh/aiterm',
  kind: 'aiterm',
  multiple: false,
  priority: 'extension',
  title: () => t('title'),
  guide: [{ id: 'open', order: 30, title: () => t('title'), description: () => t('guide') }],
})
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab', key: 'aiterm', locale: 'aiterm',
  inject: (props) => ({ sessionId: props.sessionId }),
}, PanelComponent))
ctx.sidebarRight.openTab('aiterm', { revealIfOpened: true })
```

Client duties (v1):
1. Session rail: list all sessions from RPC + global SSE, state dot, title, transport icon;
   click selects; a `+` opens the connect form.
2. xterm.js terminal bound to `/aiterm/events?sessionId=`, sending keystrokes via
   `sessions.input`; resize on container resize; "reconnect" via `sessions.replay`.
3. Input is disabled (read-only + visible banner) when `permission.humanWriteBlocked` is true.
4. Control bar: AI permission segmented control `只读 / 只写 / 读写`, lock indicator,
   `接管` / `交还 AI` buttons, `审计` popover, close session.
5. Connect form (modal or inline): profile picker + transport, host, port, username,
   auth type, password (write-only field), private key (textarea), save-as-profile.
6. All visible text through `ctx.locale` (namespace `aiterm`, zh + en dictionaries).
7. Styling only with theme tokens (`var(--dsw-alias-*)`); no literal colors except terminal
   theme defaults. Query `Theme.listTokens` for real token names.

Client build: `scripts/build-client.mjs` uses esbuild (`npm i -D esbuild @xterm/xterm
@xterm/addon-fit` inside the package) with `--bundle --format=cjs --platform=browser`,
externals `react`, `react-dom`, `react/jsx-runtime`, `@deepseek-ai/*`, then wraps the output
in the ModuleLoader factory and writes `lib/client.js`. `npm run build` must reproduce it.

## 7. Storage & config

Data dir: `path.join(os.homedir(), '.dsh', 'aiterm')`.
- `profiles.json` — `{ version: 1, profiles: [...] }`, mode 0600, atomic write.
- `known_hosts` — ssh host keys (accept-new by default).

### Credentials: use the RECORDS API, never the refs API

> **Incident (2026-10-21).** v1 stored per-profile secrets as
> `ctx.credentials.set('aiterm/' + profileId, password)`. That is the *refs*
> API, whose keys are `CredentialRef` names and MUST match
> `/^[A-Za-z_][A-Za-z0-9_]*$/`. `aiterm/p-ppmxqcyt` does not, so the
> credentials document was written into an unparsable state — the write itself
> did not throw, and DSH then **refused to start on the next boot**
> (`startup failed: 1 required plugin did not activate → credentials`), taking
> 11 dependants with it.

Rules that follow, enforced by `test/secrets.test.mjs`:

- Per-profile secrets go through the **records** API only:
  `modifyRecord(key, async () => ({ kind: 'api-key', key: value }))`,
  `readRecord(key)`, `deleteRecord(key)`.
- A record key is a `CredentialKey`: exactly `<scope>/<id>`, each segment matching
  `/^[a-z][a-z0-9-]*$/`. Scope is always `aiterm`; the id comes only from
  `credentialSegmentFor(profileId)`, which lowercases, replaces illegal runs,
  prefixes `p-` when the id starts with a digit, and appends a short hash whenever
  the mapping changed the id (so distinct ids can never collapse).
- Slot suffixes: password `''`, private key `'-key'`, passphrase `'-pass'`.
- `isCredentialKey(key)` is checked before every write; an illegal key throws
  `BAD_CREDENTIAL_KEY` instead of touching the durable document.
- Never call `set`/`unset`/`resolve` with a per-profile name. The refs API is for
  environment-variable-named secrets (e.g. `UNIAPI_API_KEY`), not per-record data.
- A credentials backend failure falls back to `<dataDir>/secrets.json` (0600) and
  logs one warning; saving a profile must never fail because storage failed.

`Config` (row config in cordis.patch.yml), all optional with defaults:
```yaml
aiAccessDefault: rw          # ro | wo | rw
aiAutoLock: true             # AI write acquires the control lock
aiLockIdleMs: 30000          # AI lock auto-release after this idle time
blockHumanWhileAi: true      # the requested behavior: human typing is blocked while AI operates
humanCanPreempt: true        # UI may always take over
maxSessions: 16
scrollback: 4000
aiReadMaxBytes: 65536
replayBufferBytes: 262144
routePath: /aiterm
enabled: true
```

## 8. Agent tools (registered by Lead in `lib/host/tools.js`)

`aiterm_list`, `aiterm_connect`, `aiterm_read`, `aiterm_send`,
`aiterm_screenshot`, `aiterm_status`, `aiterm_close`, `aiterm_audit`,
`aiterm_release_control`.

Every tool routes through the same registry methods as the UI, respecting §4. Tools must
never return passwords. Descriptions must state the permission rules so the model knows
why a write may be refused.

### Result payload rule (learned from live verification)

The Host validates a tool result as **lossless JSON** and against the tool's declared
`output.schema` (`additionalProperties: false` where declared). Therefore:

- `registry.info()` omits absent optional fields (`profileId`, `error`,
  `hostKeyFingerprint`) instead of emitting `undefined`.
- Every tool's `execute` return value passes through `jsonSafe()` (drops undefined, nulls
  non-finite numbers, base64-encodes Buffers).
- A field the implementation returns must be declared in `output.schema`; `type: [...]`
  arrays are rejected — use `oneOf`. `test/tools.test.mjs` enforces both rules.

---

# v2 增补：增量读取、时间戳历史、批量与脚本

> 本节在 v1 基础上增补，v1 的既有接口保持向后兼容（`read` 的 `screen`/`history`/`tail` 继续有效，
> `screenshot` 保留但精简载荷）。所有实现必须遵守 §8 的“结果载荷规则”（lossless JSON +
> declared schema，禁止 `type: [...]`）。

## 9. 输出日志与游标（`lib/host/outputlog.js`）

```js
export class OutputLog {
  constructor(options: { maxBytes: number, maxAgeMs: number })
  /** 追加一段已解码文本；offset 以 UTF-8 字节累加。 */
  append(text: string, at?: number): void
  /** 当前输出流的总字节偏移（下一个 delta 从这开始）。 */
  get totalOffset(): number
  /** 按偏移取文本。from 缺省 0；maxBytes 缺省不限（内部仍受保留窗口限制）。 */
  slice(from?: number, maxBytes?: number): { text: string, from: number, to: number, truncated: boolean }
  /** 距离给定时间戳之后（含）的第一个字节偏移。 */
  offsetAt(timestampMs: number): number
  /** 首个/末个时间戳，供历史查询报边界。 */
  get window(): { firstAt: number, lastAt: number, firstOffset: number, lastOffset: number }
  /**
   * 在保留窗口内搜索。pattern 为正则；since/until 为 epoch ms。
   * 返回按时间升序的匹配，含上下文行；同时返回扫描字节数与是否截断。
   */
  search(query: {
    pattern: RegExp, since?: number, until?: number,
    context?: number, maxMatches?: number, maxBytes?: number,
  }): { matches: Array<{ at: number, offset: number, line: string, before: string[], after: string[] }>, scannedBytes: number, truncated: boolean }
  /** 丢弃超出 maxBytes / maxAgeMs 的旧分片。 */
  prune(now?: number): void
  dispose(): void
}
```

规则：
- 分片按到达顺序保存 `{ offset, at, text }`；`offset` 为累计 UTF-8 字节数，单调递增。
- `append` 不抛异常；同一毫秒多片允许合并。
- 内容裁剪只影响内存窗口，不影响 `totalOffset`（偏移永不回退），这样旧游标只会在 `slice` 里返回
  `truncated: true`，不会错位。

## 10. 历史落盘（`lib/host/history-store.js`）

目录：`<dataDir>/history/`，`<dataDir>` 默认 `~/.dsh/aiterm`。

> **v8 安全变更（0.5.4）**：
> 1. 会话 id（`st-N`）不再每次启动从 1 开始。历史目录的 `.ids/st-N` 用 `open(..., 'wx')`
>    原子预留，跨重启、跨并发宿主续号；分配前还会跳过已有 journal 或已有 `<id>.log` 的 id。
> 2. 每次 `openSession()` 仍用 `open(..., 'wx')` 独占创建新的 incarnation journal
>    `<sessionId>~<uuid>.ndjson`，绝不追加旧文件。owner 与关闭权限随文件私有保存，不依赖
>    `index.json`。
> 3. 每个 incarnation 有独立 `historyId`（journal 文件名去掉 `.ndjson`）。列表返回**所有**
>    incarnation；只传 `sessionId` 的旧调用者取最新（兼容），新调用者回传 `historyId` 精确
>    寻址。绝不把不同 incarnation 的 owner/权限合并。
> 4. `closeSession()` 只写回本进程实际打开的那个 incarnation（state 或显式 `historyId`）；
>    reservation 失败时没有 state 就**不做任何回退**，不会给别的 crash journal 补权限。
> 5. 旧格式文件原样保留、不删除、不改写；对 AI fail closed。正常 owner-bound 面板通过
>    独立的**人工专用** `history.legacy.*` 入口访问，AI 工具不暴露。

- 新格式：`<sessionId>~<uuid>.ndjson`
  - 第一行：`{"_aiterm":"journal","version":1,"id","owner","title","transport","host","port","username","createdAt"}`；`owner` 为 DSH 会话 id，或显式 `null`（无归属桶）。
  - 数据行：`{"t":<epoch ms>,"d":"<base64 UTF-8>"}`。
  - `closeSession()` 追加：`{"_aiterm":"close","version":1,"closedAt","bytes","lastTs","aiAccess"?}`；`aiAccess` 缺失表示关闭权限未知（AI fail closed）。
  - 文件头缺失/损坏 → unattributed：不列出、AI 不可读；文件不动。
- 会话 id 预留：`<dir>/.ids/st-N`（0600，空/小 JSON 文件）。`allocateSessionId()` 先扫描最
  大已用号，再用 `wx` 原子创建候选；`EEXIST` 就重试下一个。已有 legacy/new journal 或旧
  `<id>.log` 的 id 不会分配。reservation 永久保留（很小），不参与 retention。
- 旧格式（迁移前）：`<sessionId>.ndjson`（无文件头），仅从 `index.json` 取得公开目录信息；永不改写、永不被保留策略删除。
- `index.json`：`{ "version": 1, "sessions": [CatalogEntry] }`，**只读旧数据**；新日志通过扫描文件头恢复。索引中的 `owner` 等字段不可信、不参与鉴权。
- `CatalogEntry`：`{ id, title, transport, host, port, username, createdAt, closedAt?, bytes, lastTs, historyId? }`；私有字段 `owner`、`aiAccess`、journal path 永不出现在工具/浏览器载荷。`historyId` 是公开的 incarnation 地址（不含 owner/权限）。

```js
export class HistoryStore {
  constructor(options: {
    dir: string,
    retentionMs: number,          // 默认 24h（只作用于新格式日志）
    maxBytesPerSession: number,   // 默认 8 MiB
    maxSessions: number,          // 默认 100
    flushIntervalMs?: number,     // 默认 250
    log?: (level: string, message: string) => void,
  })
  async init(): Promise<void>
  async allocateSessionId(options?): Promise<string | undefined>   // 唯一 st-N
  async openSession(meta: { id, owner, title, transport, host, port, username, createdAt }): Promise<{ historyId, journal, fileBytes } | false>
  appendChunk(sessionId: string, text: string, at?: number, owner?: string | null): void
  async flush(sessionId?: string): Promise<void>
  async whenIdle(): Promise<void>
  async closeSession(sessionId: string, info?: { closedAt?, permission?: { aiAccess? }, owner?, historyId? }): Promise<void>
  async listRecordings(query?): Promise<Recording[]>      // 私有 owner/aiAccess/journal + historyId
  async listLegacySessions(query?): Promise<CatalogEntry[]>
  async legacyEntry(sessionId): Promise<CatalogEntry | undefined>
  async resolveForRead(sessionId, owner, actor, historyId?): Promise<{ kind: 'attributed', recording } | { kind: 'legacy', entry } | undefined>
  async resolveByHistoryId(historyId, owner, actor): Promise<{ kind: 'attributed', recording } | undefined>
  canAiRead(recording): boolean                            // 仅关闭权限为 ro/rw 才为 true
  journalForSync(sessionId, { owner, actor, historyId? }): string | undefined
  activeJournal(sessionId, owner, historyId?): string | undefined
  activeHandle(sessionId, owner, historyId?): { historyId, journal } | undefined
  async queryRecording(recording, query): Promise<QueryResult>
  async queryLegacy(entry, query): Promise<QueryResult>
  async query(query): Promise<QueryResult>                 // 便捷封装；无法判定时返回空
  async prune(now?: number): Promise<void>                 // 只清理新格式日志
  async dispose(): Promise<void>
}
```

规则：
- `appendChunk` 只写内存缓冲；`flushIntervalMs` 到点或缓冲超过 64 KiB 时追加写文件（`appendFile`）。只写自己的 incarnation。
- 任何磁盘错误只记 warn，绝不影响终端会话。**append 失败时批次放回 pending**，close 只有在
  pending 清空后才删除 writer 并追加关闭元数据；否则保留 state 供 `flush()`/`dispose()` 重试，
  且关闭权限保持未知（AI fail closed）。
- 单文件超过 `maxBytesPerSession` 时截断为尾部内容，**必须保留第一行文件头**；文件头无法确认时放弃截断（fail closed）。
- 任意 journal 缺文件头/关闭权限缺失 → AI fail closed。legacy 只允许显式 `actor:'human'` 的 `history.legacy.*`
  读取，且必须能在 `index.json` 中存在（孤儿文件不暴露）；旧文件不改不删。
- 未知 id 的查询最多每 `SCAN_COOLDOWN_MS`（1s）扫一次目录，避免被反复猜测 id 放大 I/O。
- 搜索对 live 与 closed 一致地不区分大小写；导出对单文件有 64 MiB 上限（`HISTORY_TOO_LARGE`），
  显式导出源文件消失返回 `SESSION_NOT_FOUND`，不再写空文件。
- 多个 `HistoryStore` 并发/重载/旧实例延迟 flush 时，`wx` id/journal 预留与独立文件名保证不串写；
  `index.json` 的 last-writer-wins 不影响归属判定。
- 审计：live 会话的 history slice/export 会写入该会话的审计环；已关闭会话没有进程内审计归属，
  目前不记录（如需持久审计需另行设计）。

## 11. 批量与脚本（`lib/host/batch.js`、`lib/host/scripts.js`）

### 11.1 步骤定义（BatchStep）

```js
{
  sessionId?: string,          // 省略时用 targets 当前目标
  send: string,                // 要发送的文本（可含 {{param}}）
  enter?: boolean,             // 追加 \r
  waitFor?: { pattern?: string, idleMs?: number, timeoutMs?: number },  // 等待条件
  waitMs?: number,             // 固定等待（与 waitFor 二选一，优先 waitFor）
  read?: 'delta' | 'screen' | 'none',   // 默认 'delta'
  maxLines?: number,           // read 为 screen 时保留行数
}
```

### 11.2 执行器

```js
export async function runBatch(registry, steps, options): Promise<BatchResult>
// registry 需提供（见 §13）：write(id, text, 'ai')、waitFor(id, opts)、readDelta(id, opts)、
// readScreen(id, opts)、atPrompt(id)、info(id)
// options: {
//   targets: string[],        // 必填，至少一个；扇出时按顺序逐目标执行整组步骤
//   stopOnError?: boolean,    // 默认 true
//   maxTotalMs?: number,      // 默认 120000；超时中止并在结果里标 timedOut
//   parallel?: boolean,       // 默认 false；true 时各目标并发
//   label?: string,           // 审计标签，如 'batch' 或 'script:<name>'
// }
// BatchResult: {
//   ok: boolean, timedOut: boolean, label?: string,
//   runs: Array<{
//     sessionId: string, ok: boolean,
//     steps: Array<{ index: number, ok: boolean, matched?: boolean,
//                    text?: string, cursor?: string, error?: string }>,
//     stoppedAt?: number,
//   }>,
// }
```

规则：
- 每个 `send` 仍然调用 `registry.write(..., 'ai')`，权限拒绝即该步 `ok:false` + `error`，按 `stopOnError` 决定是否继续。
- 每步文本经 `maxBytes`（默认 8192）截断；整份结果总量再受上限约束。
- 任何异常都转成步骤级 `error`，`runBatch` 本身不抛（除非 `targets` 为空）。

### 11.3 脚本存储

目录：`<dataDir>/scripts/<name>.json`（name 仅 `[A-Za-z0-9_-]{1,64}`）。

```js
export class ScriptStore {
  constructor(options: { dir: string, log?: Function })
  async init(): Promise<void>
  async list(): Promise<ScriptSummary[]>       // { name, description, params, stepCount, updatedAt }
  async get(name: string): Promise<ScriptDefinition | undefined>
  async save(input: unknown, actor: 'human' | 'ai'): Promise<ScriptSummary>
  async delete(name: string): Promise<boolean>
  /** {{param}} 替换 + 参数校验；缺参且无默认值时抛 coded('MISSING_PARAM')。 */
  render(definition: ScriptDefinition, params?: Record<string, unknown>): BatchStep[]
}
```

`ScriptDefinition`：`{ name, description, params: Record<string, { default?: string, description?: string }>, steps: BatchStep[], updatedAt }`。
`ScriptSummary`：`{ name, description, params, stepCount, updatedAt }`。

规则：脚本是纯数据，不 eval；禁含密码/私钥字段（发现即拒绝保存）。

## 12. v2 工具面与 RPC

### 12.1 模型工具（新增/变更）

| 工具 | 参数 | 说明 |
|---|---|---|
| `aiterm_read` | `{ sessionId, mode?, cursor?, maxBytes?, maxLines?, changedOnly?, reader? }` | `mode` 默认改为 **`delta`**；`screen/history/tail` 保留 |
| `aiterm_screen` | `{ sessionId, changedOnly?, maxLines?, cursor? }` | 可见屏幕文本（去空行、可只回变化行），返回 `cursor`/`atPrompt`/`unchanged` |
| `aiterm_screenshot` | `{ sessionId }` | **兼容别名**，载荷精简为 `{ text, cols, rows, cursor, atPrompt, session }`（不再重复 `screen`+`text`） |
| `aiterm_wait` | `{ sessionId, until?, pattern?, idleMs?, timeoutMs?, cursor?, includeOutput? }` | `until`: `idle`(默认)/`pattern`/`exit` |
| `aiterm_history` | `{ sessionId?, historyId?, since?, until?, search?, context?, maxMatches?, maxBytes?, limit? }` | 省略 `sessionId` 时返回会话目录（每个 incarnation 逐条，带 `historyId`）；否则返回匹配/片段 |
| `aiterm_batch` | `{ steps, targets?, stopOnError?, maxTotalMs?, parallel?, label? }` | §11.2 |
| `aiterm_script_list` | `{}` | 列出脚本 |
| `aiterm_script_run` | `{ name, params?, sessionId?, targets? }` | 执行脚本（等价 batch，label=`script:<name>`） |

时间参数 `since`/`until` 接受：epoch 毫秒数字、ISO 字符串、或相对量 `"10m"` / `"2h"` / `"90s"`。

### 12.2 读取语义

- 游标 `cursor` 是不透明字符串（实现为十进制字节偏移）。省略时使用该读者（`reader`，默认 `ai`）在 Host 侧保存的上次位置。
- `delta`：返回新输出 + 新 `cursor`；无新内容时 `text: ""`、`newBytes: 0`（约 10 token，这是核心省 token 手段）。
- `screen`：`changedOnly: true` 时只回相对该读者上次屏幕发生变化的行，前缀 `L<n>:`；完全没变化时 `unchanged: true`、`text: ""`。
- 所有读取仍受 §4 权限约束（`wo` 拒绝读）。
- 所有读取返回 `atPrompt`（基于 `config.promptPattern`）。

### 12.3 RPC（浏览器 → Host）

在 §5 基础上新增：

| method | params | result |
|---|---|---|
| `read.delta` | `{ id, cursor?, maxBytes? }` | `{ text, cursor, newBytes, atPrompt }` |
| `read.screen` | `{ id, changedOnly?, maxLines? }` | `{ text, changedLines, cursor, atPrompt, unchanged }` |
| `history.sessions` | `{ limit?, since?, until?, owner? }` | `{ sessions: CatalogEntry[] }`（按 owner 过滤；同一 id 的多个 incarnation 逐条返回，各带 `historyId`） |
| `history.query` | `{ sessionId?, historyId?, since?, until?, search?, context?, maxMatches?, maxBytes?, limit?, owner? }` | `{ sessions?: CatalogEntry[], matches?: Match[], truncated, scannedBytes }`（已关闭会话同样按 owner + 关闭权限判定；`historyId` 精确指定 incarnation） |
| `history.export` | `{ sessionId?, historyId?, all?, since?, until?, owner? }` | `{ dir, files: [{ sessionId, path, bytes, lines }] }`（`all` 只覆盖本 owner 且 AI 可读的会话；显式源文件缺失 → `SESSION_NOT_FOUND`） |
| `history.legacy.sessions` | `{ limit?, since?, until? }` | `{ sessions: CatalogEntry[] }`（**仅人工**；无归属旧数据） |
| `history.legacy.query` | `{ sessionId, since?, until?, search?, context?, maxMatches?, maxBytes? }` | history.query 同形（**仅人工**，不改写旧文件） |
| `history.legacy.export` | `{ sessionId, since?, until? }` | `{ dir, files }`（**仅人工**；旧文件不改不删） |
| `scripts.list` | `{}` | `{ scripts: ScriptSummary[] }` |
| `scripts.save` | `{ script }` | `{ script: ScriptSummary }`（human only） |
| `scripts.delete` | `{ name }` | `{ ok: boolean }`（human only） |
| `scripts.run` | `{ name, params?, sessionId?, targets? }` | `{ result: BatchResult }` |
| `batch.run` | `{ steps, targets?, stopOnError?, maxTotalMs?, parallel?, label? }` | `{ result: BatchResult }` |

SSE 新增帧（全局流）：`{ "type": "batch", "batchId": string, "label"?: string, "state": "step" | "done", "sessionId": string, "stepIndex": number, "ok": boolean, "text"?: string, "error"?: string }`。

### 12.4 Config 增补

```yaml
promptPattern: '(?:^|[\s\])~:])[#$%>❯»]\s*
historyRetentionMs: 86400000                  # 落盘历史保留 24h
historyMaxBytesPerSession: 8388608            # 单会话历史 8MiB
historyMaxSessions: 100                       # 历史会话数量上限
deltaDefaultMaxBytes: 8192                    # delta 单次上限
scriptsDir: scripts                           # <dataDir> 下脚本目录名
```
   # 提示符识别
historyRetentionMs: 86400000                  # 落盘历史保留 24h
historyMaxBytesPerSession: 8388608            # 单会话历史 8MiB
historyMaxSessions: 100                       # 历史会话数量上限
deltaDefaultMaxBytes: 8192                    # delta 单次上限
scriptsDir: scripts                           # <dataDir> 下脚本目录名
```

### 12.5 游标与等待的语义（验证后补充）

- **只有成功的等待才消耗游标**。`waitFor` 命中（`matched: true`）时把该读者的 delta 游标推进到
  当前末尾；超时（`matched: false`）时**不推进**，期间产生的输出仍可被下一次 delta 读到。
- **等待默认从该读者上次读到的位置开始扫描**（而非"从此刻起"），因此"发送 → 等待匹配回显"这种
  调用顺序不会因为输出先到而漏匹配；从未读过的读者则从最近 `aiReadMaxBytes` 的窗口开始。
- `changedOnly` 的基线来自该读者上一次 screen 读；**首次**调用时基线为空，全部行都算变化
  （`added` 也要计入），不会返回"无变化"。
- `atPrompt` = 屏幕最后一行非空内容以提示符字符结尾 **且** 光标停在该行（提示符不换行）；
  只看正则不足以区分"输出恰好以 $ 结尾"，两者组合才既覆盖 `mock$`/`bash-5.2$` 又不误判普通输出。

---

# v3 增补：配置管理与脚本语言

## 13. 配置（profile）管理

`ProfileInfo` 增加两个字段（其余不变）：

```js
{
  ...v2 字段,
  folder: string,      // 分组名，'' 表示未分组；≤64 字符，无控制字符
  order: number,       // 组内排序（升序），同组内唯一性不强制
}
```

行为：

- `profiles.save` 保持"创建或更新"语义，接受可选 `folder` / `order`（省略时保留原值）。
- 改名只改显示名，不改 `id`（`id` 是凭据键的一部分，改 id 会丢密码）：
  `profiles.rename { id, name } → { profile }`，name 1–120 字符。
- 移动分组：`profiles.setFolder { id, folder } → { profile }`。
- 删除：沿用 `profiles.delete { id } → { ok }`，同时删除该配置的三个凭据槽位。
- 列表附带分组概览：`profiles.list {} → { profiles, folders: [{ name, count }] }`
  （`folders` 由去重后的 `folder` 生成，`''` 不入列）。
- 所有配置写操作**仅限 human**（AI 不可调用，与凭据安全一致）。

## 14. 脚本语言（`lib/host/script-lang.js`）

脚本定义（脚本文件仍是 `<dataDir>/scripts/<name>.json`）：

```js
{
  name, description, folder?: string,          // folder 可空
  params: { [name]: { default?: string, description?: string } },
  steps: [Step],
}
```

### 14.1 Step

```js
// 发送并可选等待/回读（v2 的 batch step，新增 capture）
{ send: string, enter?: boolean, waitFor?: { pattern?, idleMs?, timeoutMs? },
  waitMs?: number, read?: 'delta'|'screen'|'none', maxLines?: number, capture?: string }

{ delay: number }                                  // 毫秒，>0
{ set: string, value: string }                     // 变量名, 值（支持 {{var}}）
{ log: string }                                    // 追加一段人类可读输出
{ expect: Condition, onFail?: 'stop'|'continue', capture?: string }  // 断言
{ if: Condition, then: Step[], else?: Step[] }
{ loop:
    { count?: number, while?: Condition, until?: Condition, maxIterations?: number },
  steps: Step[] }
```

条件（Condition）：

```js
{ always: true }
{ match: string }                       // 正则，匹配"自上次检查点以来的输出"
{ contains: string }                    // 纯文本包含
{ variable: string, equals?: string, notEquals?: string, contains?: string, matches?: string }
{ not: Condition }
{ all: Condition[] } | { any: Condition[] }
```

语义：

- **检查点（条件窗口）**：每个 target 维护一个"条件检查点"。条件与 `expect` 求值的文本是
  "自上次**条件求值**以来的输出"，因此：
  - `send` / `wait` / `delay` / `set` / `log` **不**推进条件检查点；
  - 只有求值 `if` / `loop.while` / `loop.until` / `expect` 才把检查点推进到当前末尾
    （同一段输出不会被连续两个条件重复匹配）；
  - 于是"发送 → 立刻 `if {match}` / `expect`"能正确看到刚产生的输出，这是最常见的写法；
  - 条件窗口取保留尾部并受读取上限约束（默认 8 KiB），不会无界增长。
- **模板**：`{{var}}` 在 `send`、`log`、`set.value`、`expect`/条件里的字符串中替换；
  未知变量保留原文（不报错），但 `set` 的变量名必须匹配 `[A-Za-z_][A-Za-z0-9_]{0,31}`。
- **loop**：`count` 固定次数；`while` 每次迭代前求值；`until` 每次迭代后求值（真则退出）；
  `maxIterations` 默认 100、上限 1000；三者至少给一个（否则 `BAD_SCRIPT`）。
- **expect** 失败：`onFail: 'stop'`（默认）中止该 target；`continue` 记一条失败步骤后继续。
- 所有 `send` 仍然走 `registry.write(..., 'ai')`，权限拒绝即该步失败。
- 进度事件：`onStep({ sessionId, stepIndex, depth, kind, ok, text?, error?, path })`，
  `path` 形如 `"3"`、`"3.2"`（嵌套块内），供面板缩进显示。

### 14.2 上限（硬约束，超出即 `BAD_SCRIPT` 或运行期截断）

| 项 | 上限 |
| --- | --- |
| 顶层 + 嵌套步骤总数 | 500 |
| 嵌套深度 | 5 |
| 单次 loop 迭代 | 1000（默认 100） |
| 变量个数 | 50 |
| 单变量值长度 | 8 KiB |
| 整个脚本时长 | 600000 ms（可由调用方调小） |
| 单步回读文本 | 8192 字节（沿用） |

### 14.3 API

```js
export function normalizeScriptProgram(steps: unknown): Step[]      // 结构校验 + 上限
export function renderTemplates(value: string, variables: Record<string,string>): string
export async function runScript(registry, definition, options): Promise<ScriptRunResult>
// options: { params?, targets: string[], stopOnError?, maxTotalMs?, parallel?, onStep?, sleep?, now? }
// ScriptRunResult:
// {
//   ok: boolean, timedOut: boolean, label?: string,
//   runs: [{ sessionId, ok, steps: StepResult[], stoppedAt? }],
//   variables: Record<string, string>,   // 结束时（各 target 合并后的最后一个）
//   logs: string[],
// }
// StepResult: { index, depth, path, kind, ok, matched?, text?, error?, code? }
```

`ScriptStore.save` 用 `normalizeScriptProgram` 校验 `steps`（不再只接受扁平 batch 步骤），
并继续拒绝 `password`/`privateKey`/`passphrase` 字段；`ScriptSummary` 增加 `folder`。

`aiterm_script_run` 改为调用 `runScript`；`aiterm_batch` 仍然只接受扁平步骤
（`normalizeSteps` 不变），两者共用 `registry` 的写入/等待/读取原语。

### 14.4 工具面增补

| 工具 | 作用 |
|---|---|
| `aiterm_script_save` | 保存/覆盖脚本（`{ script }`，AI 可用；删除仍仅限人） |
| `aiterm_script_list` | 增加 `folder` 字段展示 |

### 14.5 浏览器侧脚本 RPC

| method | params | result |
|---|---|---|
| `scripts.list` | `{}` | `{ scripts: ScriptSummary[] }`（含 `folder`、`stepCount`） |
| `scripts.get` | `{ name }` | `{ script: ScriptDefinition }`（**含 steps**，编辑器加载用；缺失 404） |
| `scripts.save` | `{ script }` | `{ script: ScriptSummary }`（human；AI 走工具） |
| `scripts.delete` | `{ name }` | `{ ok: boolean }`（human only） |
| `scripts.run` | `{ name, params?, sessionId?\|targets?, stopOnError?, maxTotalMs?, parallel? }` | `{ result: ScriptRunResult }` |

`ScriptSummary.stepCount` 统计**含嵌套**在内的步骤总数（`then`/`else`/`loop.steps` 递归计数），
用于面板显示"这个脚本有多大"。

---

# v4 增补：会话中断与重连

## 15. 会话生命周期

状态机（`SessionInfo.state`）：

```
connecting ──ok──> open ──(user disconnect / remote close / network drop)──> disconnected
     │                ▲                                                          │
     └──fail──> failed└────────────────── reconnect ─────────────────────────────┘
open/disconnected ──(user close)──> closed（从列表移除）
```

关键语义：

- **`disconnected` 是"可恢复"的终态**：会话留在列表里，`id`、`title`、`aiAccess`、历史输出、审计全部保留；
  传输已关闭，不能读写（写入返回 `NOT_CONNECTED`）。
- **远端意外断开不再删除会话**：`onClose` 只要不是用户主动 `close`、且曾经 `open` 过，就进入 `disconnected`
  并记录 `closeReason` / `disconnectedAt`。这修掉了"网络抖一下会话就没了"的行为。
- **`reconnect` 复用同一个 id**：不新建 session，历史/权限/审计继续累积；`generation` 自增。
- **重连会重建屏幕**（远端是新的 shell）：服务端重置 `Screen`，并广播
  `{ "type": "reset", "session": SessionInfo, "reason": string }`；客户端收到后清空 xterm 再继续接收 `data`。
  输出日志（`OutputLog`）与历史**不清空**，`cursor` 继续单调增长，旧游标仍然有效。
- 重连丢失控制权：`lockOwner` 清空（连接已断，锁无意义），`aiAccess` 保留。
- 权限门禁不变：`disconnected` 状态下读返回空文本、写返回 `NOT_CONNECTED`。

## 16. 认证材料与重连

重连需要认证信息，但插件**不持久化明文口令**：

- 会话来自保存的配置（`profileId`）→ 重连时通过 `ProfileStore.connectionFor(profileId)` 重新解析（推荐路径）。
- 会话是 ad-hoc 且带口令/私钥 → 这些材料**仅保留在 Host 进程内存**（`session.auth`），
  进程重启即消失；从不写入磁盘、日志、工具结果或 SSE，`SessionInfo` 也不含它。
- `agent` / `none` 认证无需材料。
- 若既无 profile 也无内存材料（例如重启后、或当初由 AI 用 agent 建立）→ 重连返回
  `coded('RECONNECT_NO_CREDENTIALS')`，提示用户用配置重连。

## 17. RPC 与工具

| method | params | result |
|---|---|---|
| `sessions.disconnect` | `{ id, reason? }` | `{ session }`（state=`disconnected`） |
| `sessions.reconnect` | `{ id, cols?, rows? }` | `{ session }`（state=`open` 或 `failed`；失败不抛，带 `error`） |

- `sessions.close` 语义不变（终止并从列表移除）。
- 两者均**人类可用**；模型也可通过工具触发（不涉及提升权限）。

工具面新增：

| 工具 | 作用 |
|---|---|
| `aiterm_disconnect` | 断开但保留会话（可重连） |
| `aiterm_reconnect` | 重连该会话（同一 id，历史保留） |

`SessionInfo` 新增字段：

```js
{
  ...既有字段,
  generation: number,        // 每次成功 (重)连 +1；客户端据此判断是否需要清屏
  disconnectedAt?: number,   // 最近一次断开时间
  closeReason?: string,      // 断开原因（'user disconnect' / 'connection closed' / 错误摘要）
  reconnecting?: boolean,    // 重连进行中
}
```

## 18. 资源上限与配置

```yaml
maxDetachedSessions: 20        # 同时保留的 disconnected 会话上限，超出按 disconnectedAt 最旧修剪
autoReconnect: false           # 意外断开时是否自动重连
autoReconnectAttempts: 3       # 自动重连次数上限（autoReconnect=true 时）
autoReconnectDelayMs: 2000     # 首次重试延迟，指数退避到 30s
```

`maxSessions` 只统计 `connecting` / `open`（断开的不占连接名额），但仍受 `maxDetachedSessions` 约束。

SSE 新增帧（全局与单会话流都发）：

```json
{ "type": "reset", "session": SessionInfo, "reason": "user disconnect" }
```

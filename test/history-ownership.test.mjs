/**
 * Security regressions for durable terminal history.
 *
 * Every scenario runs on a throwaway `mkdtemp()` directory: the real
 * `~/.dsh/aiterm/history`, settings and sessions are never read or written.
 *
 * The boundary under test:
 * - one logical session id may be reused after a plugin reload, so a journal
 *   must never be appended across two incarnations/owners;
 * - owner and closed AI permission must travel with the journal itself, not
 *   only through the shared, last-writer-wins catalog;
 * - legacy/unattributed/unknown-permission data fails closed for AI reads and
 *   exports, and is not silently reassigned to a new owner;
 * - write-only AI cannot read or export live *or* closed output.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AutoLog } from '../lib/host/autolog.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/host/config.js'
import { HistoryStore } from '../lib/host/history-store.js'
import { SessionRegistry } from '../lib/host/registry.js'
import { registerTools } from '../lib/host/tools.js'

/** Base timestamp for deterministic journals. */
const T0 = Date.now() - 60_000

/**
 * @param {(dir: string) => Promise<void>} fn scenario body.
 * @returns {Promise<void>} completion.
 */
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aiterm-history-security-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * @param {string} dir history directory.
 * @param {Record<string, unknown>} [overrides] store options.
 * @returns {HistoryStore} a store bound to `dir`.
 */
function makeStore(dir, overrides = {}) {
  return new HistoryStore({
    dir,
    retentionMs: 60 * 60 * 1000,
    maxBytesPerSession: 1_000_000,
    maxSessions: 100,
    flushIntervalMs: 5,
    log: () => {},
    ...overrides,
  })
}

/** No-op automatic logger for registry tests. */
function noopAutolog() {
  return {
    init: async () => {},
    open() {},
    append() {},
    close: async () => {},
    dispose: async () => {},
    get: () => ({ enabled: false, dir: '' }),
    set: async () => ({ enabled: false, dir: '' }),
  }
}

/**
 * @param {string} dir data directory.
 * @param {HistoryStore} historyStore durable store.
 * @param {Record<string, unknown>} [overrides] config overrides.
 * @returns {SessionRegistry} a real registry with no network.
 */
function makeRegistry(dir, historyStore, overrides = {}) {
  return new SessionRegistry({
    config: resolveConfig({
      aiAccessDefault: 'rw',
      aiAutoLock: true,
      aiLockIdleMs: 60_000,
      blockHumanWhileAi: true,
      humanCanPreempt: true,
      maxSessions: 16,
      ...overrides,
    }),
    profiles: {},
    dataDir: dir,
    log: () => {},
    historyStore,
    autolog: noopAutolog(),
  })
}

/**
 * Wait for best-effort writes (close metadata included) to settle.
 * @param {HistoryStore} store store.
 * @returns {Promise<void>} completion.
 */
async function settle(store) {
  if (typeof store.whenIdle === 'function') await store.whenIdle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (typeof store.whenIdle === 'function') await store.whenIdle()
}

/**
 * @param {() => Promise<unknown>} fn call.
 * @param {string} code expected error code.
 * @returns {Promise<void>} completion.
 */
async function rejectsWithCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`)
    return true
  })
}

/**
 * Base64 NDJSON payload used by hand-written legacy journals.
 * @param {string} text output.
 * @returns {string} base64.
 */
function payload(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

/**
 * Read every `*.ndjson` file in a history directory.
 * @param {string} dir history directory.
 * @returns {Promise<Array<{ name: string, text: string, output: string }>>} file contents.
 */
async function journals(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'))
  return Promise.all(names.map(async (name) => {
    const text = await readFile(join(dir, name), 'utf8')
    return { name, text, output: decodedOutput(text) }
  }))
}

/**
 * Concatenate the decoded output records of one raw journal.
 * @param {string} text raw NDJSON.
 * @returns {string} decoded terminal output.
 */
function decodedOutput(text) {
  let output = ''
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.d === 'string') {
        output += Buffer.from(parsed.d, 'base64').toString('utf8')
      }
    } catch {
      // corrupt/partial line: ignored like the store does
    }
  }
  return output
}

/* ------------------------------------------------------------------ *
 * 1. Incarnation uniqueness: same logical id, different owners/stores.
 * ------------------------------------------------------------------ */

test('two concurrent stores opening st-1 for different owners never share a journal', async () => {
  await withDir(async (dir) => {
    const first = makeStore(dir)
    const second = makeStore(dir)
    await Promise.all([first.init(), second.init()])

    await first.openSession({
      id: 'st-1', owner: 'owner-a', title: 'A target', transport: 'ssh', host: 'a.example', port: 22, username: 'a', createdAt: T0,
    })
    await second.openSession({
      id: 'st-1', owner: 'owner-b', title: 'B target', transport: 'telnet', host: 'b.example', port: 23, username: 'b', createdAt: T0 + 1,
    })

    first.appendChunk('st-1', 'ALPHA-ONLY\n', T0 + 10, 'owner-a')
    second.appendChunk('st-1', 'BETA-ONLY\n', T0 + 20, 'owner-b')
    await first.flush('st-1')
    await second.flush('st-1')
    await first.closeSession('st-1', { closedAt: T0 + 30, permission: { aiAccess: 'rw' } })
    await second.closeSession('st-1', { closedAt: T0 + 40, permission: { aiAccess: 'rw' } })
    await settle(first)
    await settle(second)

    const files = await journals(dir)
    assert.equal(files.length, 2, 'each incarnation must reserve its own journal file')
    assert.equal(files.filter((file) => file.output.includes('ALPHA-ONLY')).length, 1)
    assert.equal(files.filter((file) => file.output.includes('BETA-ONLY')).length, 1)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    const alpha = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'ALPHA' })
    assert.equal(alpha.matches.length, 1)
    const noBeta = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'BETA' })
    assert.equal(noBeta.matches.length, 0, 'owner A must not see owner B output')
    const beta = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-b', actor: 'ai', search: 'BETA' })
    assert.equal(beta.matches.length, 1)
    const noAlpha = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-b', actor: 'ai', search: 'ALPHA' })
    assert.equal(noAlpha.matches.length, 0, 'owner B must not see owner A output')
    await registry.dispose()
  })
})

test('a pending flush from an old store instance cannot land in a new owner journal', async () => {
  await withDir(async (dir) => {
    const oldStore = makeStore(dir, { flushIntervalMs: 60_000 })
    await oldStore.init()
    await oldStore.openSession({
      id: 'st-1', owner: 'owner-old', title: 'old', transport: 'ssh', host: 'old.example', port: 22, username: 'old', createdAt: T0,
    })
    oldStore.appendChunk('st-1', 'OLD-SECRET\n', T0 + 1, 'owner-old')
    // Deliberately no flush: the old buffered writer is still pending.

    const newStore = makeStore(dir)
    await newStore.init()
    await newStore.openSession({
      id: 'st-1', owner: 'owner-new', title: 'new', transport: 'ssh', host: 'new.example', port: 22, username: 'new', createdAt: T0 + 2,
    })
    newStore.appendChunk('st-1', 'NEW-SECRET\n', T0 + 3, 'owner-new')
    await newStore.flush('st-1')
    await newStore.closeSession('st-1', { closedAt: T0 + 4, permission: { aiAccess: 'rw' } })

    // The old instance wakes up after the reload and flushes late.
    await oldStore.flush('st-1')
    await oldStore.closeSession('st-1', { closedAt: T0 + 5, permission: { aiAccess: 'rw' } })
    await settle(oldStore)
    await settle(newStore)

    const files = await journals(dir)
    assert.equal(files.length, 2)
    const newFile = files.find((file) => file.output.includes('NEW-SECRET'))
    const oldFile = files.find((file) => file.output.includes('OLD-SECRET'))
    assert.ok(newFile, 'the new owner journal must contain its own output')
    assert.ok(oldFile, 'the old owner output must stay in the old journal')
    assert.equal(newFile.output.includes('OLD-SECRET'), false, 'a late old flush must never reach the new journal')
    assert.equal(oldFile.output.includes('NEW-SECRET'), false)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    const asNew = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-new', actor: 'ai', search: 'OLD-SECRET' })
    assert.equal(asNew.matches.length, 0, 'the new owner must not read the old incarnation')
    const own = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-old', actor: 'ai', search: 'OLD-SECRET' })
    assert.equal(own.matches.length, 1, 'the old owner can still read its own preserved journal')
    await registry.dispose()
  })
})

test('a late close for an old incarnation must not close the new one', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-old', title: 'old', transport: 'ssh', host: 'old.example', port: 22, username: 'old', createdAt: T0,
    })
    store.appendChunk('st-1', 'OLD-DATA\n', T0 + 1, 'owner-old')
    await store.flush('st-1')

    // A reloaded/replaced session reuses st-1 for another owner. The old
    // instance's close arrives later; it must only stamp its own journal.
    await store.openSession({
      id: 'st-1', owner: 'owner-new', title: 'new', transport: 'ssh', host: 'new.example', port: 22, username: 'new', createdAt: T0 + 2,
    })
    store.appendChunk('st-1', 'NEW-DATA\n', T0 + 3, 'owner-new')
    await store.flush('st-1')

    await store.closeSession('st-1', { owner: 'owner-old', closedAt: T0 + 4, permission: { aiAccess: 'wo' } })
    // The new incarnation is still active: its own close has not happened.
    store.appendChunk('st-1', 'NEW-AFTER-CLOSE\n', T0 + 5, 'owner-new')
    await store.closeSession('st-1', { owner: 'owner-new', closedAt: T0 + 6, permission: { aiAccess: 'rw' } })
    await settle(store)

    const files = await journals(dir)
    assert.equal(files.length, 2)
    const oldFile = files.find((file) => file.output.includes('OLD-DATA'))
    const newFile = files.find((file) => file.output.includes('NEW-DATA'))
    assert.ok(oldFile)
    assert.ok(newFile)
    assert.equal(oldFile.output.includes('NEW-DATA'), false)
    assert.equal(newFile.output.includes('OLD-DATA'), false)
    assert.equal(newFile.output.includes('NEW-AFTER-CLOSE'), true, 'the new incarnation must stay writable until its own close')

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-old', actor: 'ai' }),
      'AI_READ_DENIED',
      'the old close permission (wo) must apply to the old incarnation only',
    )
    const newRead = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-new', actor: 'ai', search: 'NEW-AFTER-CLOSE' })
    assert.equal(newRead.matches.length, 1, 'the new incarnation keeps its own rw permission')
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 2. Provenance survives a restart without the shared catalog.
 * ------------------------------------------------------------------ */

test('owner and closed permission are read from the journal, not the lossy index', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'kept', transport: 'ssh', host: 'a.example', port: 22, username: 'a', createdAt: T0,
    })
    store.appendChunk('st-1', 'PRIVATE-A\n', T0 + 1, 'owner-a')
    await store.closeSession('st-1', { closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(store)

    // A concurrent writer may replace (or delete) index.json; that must not
    // change who may read the journal.
    await rm(join(dir, 'index.json'), { force: true })
    await writeFile(join(dir, 'index.json'), '{"version":1,"sessions":[]}\n', { mode: 0o600 })

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    const own = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'PRIVATE-A' })
    assert.equal(own.matches.length, 1, 'attribution must come from the journal itself')
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-b', actor: 'ai' }),
      'SESSION_NOT_FOUND',
    )
    await registry.dispose()
  })
})

test('write-only AI cannot read or export a closed session, and the permission survives restart', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-wo', title: 'wo', transport: 'ssh', host: 'private.example', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'WO-SECRET\n', T0 + 1, 'owner-wo')
    await store.closeSession('st-1', { closedAt: T0 + 2, permission: { aiAccess: 'wo' } })
    await settle(store)

    // Same host process: the in-memory owner map still knows the session.
    const inProcess = makeStore(dir)
    await inProcess.init()
    const sameProcessRegistry = makeRegistry(dir, inProcess)
    sameProcessRegistry.owners.set('st-1', 'owner-wo')
    await rejectsWithCode(
      () => sameProcessRegistry.historyQuery({ sessionId: 'st-1', owner: 'owner-wo', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    const human = await sameProcessRegistry.historyQuery({ sessionId: 'st-1', owner: 'owner-wo', actor: 'human', search: 'WO-SECRET' })
    assert.equal(human.matches.length, 1, 'the human may still read the session')
    await assert.rejects(
      () => sameProcessRegistry.exportHistory({ sessionId: 'st-1', owner: 'owner-wo', actor: 'ai' }),
      (error) => {
        assert.equal(error?.code, 'AI_READ_DENIED')
        return true
      },
    )
    const humanExport = await sameProcessRegistry.exportHistory({ sessionId: 'st-1', owner: 'owner-wo', actor: 'human' })
    assert.equal(humanExport.files.length, 1)
    const exported = await readFile(humanExport.files[0].path, 'utf8')
    assert.equal(exported.includes('WO-SECRET'), true)

    // Restart: same decision, derived from the private journal metadata.
    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-wo', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    await assert.rejects(
      () => registry.exportHistory({ sessionId: 'st-1', owner: 'owner-wo', actor: 'ai' }),
      (error) => {
        assert.equal(error?.code, 'AI_READ_DENIED')
        return true
      },
    )
    await registry.dispose()
    await sameProcessRegistry.dispose()
  })
})

test('a write-only live session cannot be exported by AI', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)
    registry.openConnection = async (session) => {
      session.state = 'open'
    }
    const info = await registry.create({ transport: 'telnet', host: '10.0.0.1', port: 23 }, 'ai', 'owner-live')
    registry.handleData(registry.sessions.get(info.id), 'LIVE-SECRET\n')
    registry.setAiAccess(info.id, 'wo', 'human', 'owner-live')

    await assert.rejects(
      () => registry.exportHistory({ sessionId: info.id, owner: 'owner-live', actor: 'ai' }),
      (error) => {
        assert.equal(error?.code, 'AI_READ_DENIED')
        return true
      },
    )
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: info.id, owner: 'owner-live', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    const human = await registry.historyQuery({ sessionId: info.id, owner: 'owner-live', actor: 'human' })
    assert.equal(String(human.text).includes('LIVE-SECRET'), true)
    await registry.dispose()
  })
})

test('the registry records the owner at create and the closed permission at finalize', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)
    registry.openConnection = async (session) => {
      session.state = 'open'
    }
    const info = await registry.create({ transport: 'telnet', host: '10.0.0.2', port: 23 }, 'ai', 'owner-created')
    registry.handleData(registry.sessions.get(info.id), 'CREATED-SECRET\n')
    registry.setAiAccess(info.id, 'wo', 'human', 'owner-created')
    await registry.close(info.id, 'test close', 'human', 'owner-created')
    await settle(store)

    const fresh = makeStore(dir)
    await fresh.init()
    const restarted = makeRegistry(dir, fresh)
    await rejectsWithCode(
      () => restarted.historyQuery({ sessionId: info.id, owner: 'owner-created', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    const human = await restarted.historyQuery({ sessionId: info.id, owner: 'owner-created', actor: 'human', search: 'CREATED-SECRET' })
    assert.equal(human.matches.length, 1)
    const other = await restarted.historyQuery({ sessionId: info.id, owner: 'owner-other', actor: 'human' }).then(
      () => null,
      (error) => error,
    )
    assert.equal(other?.code, 'SESSION_NOT_FOUND')
    await restarted.dispose()
    await registry.dispose()
  })
})

test('an unknown closed permission (crash before close metadata) fails closed for AI', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'crashed', transport: 'ssh', host: 'a.example', port: 22, username: 'a', createdAt: T0,
    })
    store.appendChunk('st-1', 'CRASH-SECRET\n', T0 + 1, 'owner-a')
    await store.flush('st-1')
    // Simulate a crash: dispose flushes bytes but never appends close metadata.
    await store.dispose()

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    await assert.rejects(
      () => registry.exportHistory({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai' }),
      (error) => {
        assert.equal(error?.code, 'AI_READ_DENIED')
        return true
      },
    )
    const human = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'human', search: 'CRASH-SECRET' })
    assert.equal(human.matches.length, 1, 'the human can still recover a crashed session')
    await registry.dispose()
  })
})

test('a null-owner journal is not readable by AI even in the legacy bucket', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: null, title: 'ownerless', transport: 'ssh', host: 'x.example', port: 22, username: '', createdAt: T0,
    })
    store.appendChunk('st-1', 'NULL-OWNER-SECRET\n', T0 + 1, null)
    await store.closeSession('st-1', { closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(store)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: null, actor: 'ai' }),
      'SESSION_NOT_FOUND',
    )
    const human = await registry.historyQuery({ sessionId: 'st-1', owner: null, actor: 'human', search: 'NULL-OWNER-SECRET' })
    assert.equal(human.matches.length, 1, 'the human legacy bucket keeps explicit access')
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 3. Legacy and orphan journals.
 * ------------------------------------------------------------------ */

test('legacy and orphan journals fail closed for AI and are never silently reassigned', async () => {
  await withDir(async (dir) => {
    const legacy = `${JSON.stringify({ t: T0, d: payload('LEGACY-SECRET\n') })}\n`
    const orphan = `${JSON.stringify({ t: T0, d: payload('ORPHAN-SECRET\n') })}\n`
    await writeFile(join(dir, 'st-1.ndjson'), legacy, { mode: 0o600 })
    await writeFile(join(dir, 'st-9.ndjson'), orphan, { mode: 0o600 })
    await writeFile(
      join(dir, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: [{
          id: 'st-1', title: 'legacy target', transport: 'ssh', host: 'old.example', port: 22, username: 'old',
          createdAt: T0, bytes: 20, lastTs: T0,
          // A foreign writer might try to claim ownership here; the catalog is
          // metadata only and this field must never be trusted.
          owner: 'owner-a',
        }],
      }, null, 2)}\n`,
      { mode: 0o600 },
    )

    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)

    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: null, actor: 'ai' }),
      'SESSION_NOT_FOUND',
    )
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-9', owner: null, actor: 'ai' }),
      'SESSION_NOT_FOUND',
    )
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai' }),
      'SESSION_NOT_FOUND',
    )

    // The human legacy (no-owner) bucket keeps access to catalogued history...
    const humanLegacy = await registry.historyQuery({ sessionId: 'st-1', owner: null, actor: 'human', search: 'LEGACY' })
    assert.equal(humanLegacy.matches.length, 1)
    // ...but an orphan journal that no catalog entry vouches for is not exposed.
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-9', owner: null, actor: 'human' }),
      'SESSION_NOT_FOUND',
    )
    // A named owner cannot claim legacy data.
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'human' }),
      'SESSION_NOT_FOUND',
    )

    const humanList = await registry.historySessions({ owner: null, actor: 'human' })
    assert.deepEqual(humanList.map((entry) => entry.id), ['st-1'])
    const aiList = await registry.historySessions({ owner: null, actor: 'ai' })
    assert.deepEqual(aiList, [])
    const aiOwnedList = await registry.historySessions({ owner: 'owner-a', actor: 'ai' })
    assert.deepEqual(aiOwnedList, [])

    // Every old file is still on disk, byte for byte.
    assert.equal(await readFile(join(dir, 'st-1.ndjson'), 'utf8'), legacy)
    assert.equal(await readFile(join(dir, 'st-9.ndjson'), 'utf8'), orphan)
    await registry.dispose()
  })
})

test('a new incarnation never appends to a legacy journal and never claims it', async () => {
  await withDir(async (dir) => {
    const legacy = `${JSON.stringify({ t: T0, d: payload('LEGACY-KEEP\n') })}\n`
    await writeFile(join(dir, 'st-1.ndjson'), legacy, { mode: 0o600 })
    await writeFile(
      join(dir, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: [{ id: 'st-1', title: 'legacy', transport: 'ssh', host: 'old', port: 22, username: 'old', createdAt: T0, lastTs: T0 }],
      })}\n`,
      { mode: 0o600 },
    )

    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-new', title: 'new', transport: 'ssh', host: 'new.example', port: 22, username: 'new', createdAt: T0 + 1,
    })
    store.appendChunk('st-1', 'NEW-ONLY\n', T0 + 2, 'owner-new')
    await store.flush('st-1')
    await store.closeSession('st-1', { closedAt: T0 + 3, permission: { aiAccess: 'rw' } })
    await settle(store)

    // The old file is byte-for-byte untouched and no new incarnation contains
    // the legacy bytes.
    assert.equal(await readFile(join(dir, 'st-1.ndjson'), 'utf8'), legacy)
    const files = await journals(dir)
    assert.equal(files.length, 2)
    const incarnation = files.find((file) => file.name !== 'st-1.ndjson')
    assert.ok(incarnation)
    assert.equal(incarnation.output.includes('LEGACY-KEEP'), false)
    assert.equal(incarnation.output.includes('NEW-ONLY'), true)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    const asNew = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-new', actor: 'ai', search: 'LEGACY-KEEP' })
    assert.equal(asNew.matches.length, 0, 'the new owner must not inherit the legacy bytes')
    const legacyHuman = await registry.historyQuery({ sessionId: 'st-1', owner: null, actor: 'human', search: 'LEGACY-KEEP' })
    assert.equal(legacyHuman.matches.length, 1, 'the human legacy bucket still sees the preserved file')
    await registry.dispose()
  })
})

test('retention never deletes or rewrites legacy journals', async () => {
  await withDir(async (dir) => {
    const legacy = `${JSON.stringify({ t: 1, d: payload('VERY-OLD\n') })}\n`
    await writeFile(join(dir, 'st-1.ndjson'), legacy, { mode: 0o600 })
    await writeFile(
      join(dir, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: [{ id: 'st-1', title: 'old', transport: 'ssh', host: 'old', port: 22, username: 'old', createdAt: 1, lastTs: 1 }],
      })}\n`,
      { mode: 0o600 },
    )

    const store = makeStore(dir, { retentionMs: 1_000 })
    await store.init()
    await store.prune(Date.now() + 60_000)
    await settle(store)
    assert.equal(await readFile(join(dir, 'st-1.ndjson'), 'utf8'), legacy)
  })
})

/* ------------------------------------------------------------------ *
 * 4. Export is owner-scoped and permission-gated.
 * ------------------------------------------------------------------ */

test('export all covers only the caller owner and readable sessions', async () => {
  await withDir(async (dir) => {
    const first = makeStore(dir)
    const second = makeStore(dir)
    await Promise.all([first.init(), second.init()])
    await first.openSession({
      id: 'st-1', owner: 'owner-a', title: 'A', transport: 'ssh', host: 'a.example', port: 22, username: 'a', createdAt: T0,
    })
    first.appendChunk('st-1', 'A-EXPORT\n', T0 + 1, 'owner-a')
    await first.closeSession('st-1', { closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await second.openSession({
      id: 'st-2', owner: 'owner-b', title: 'B', transport: 'ssh', host: 'b.example', port: 22, username: 'b', createdAt: T0,
    })
    second.appendChunk('st-2', 'B-EXPORT\n', T0 + 3, 'owner-b')
    await second.closeSession('st-2', { closedAt: T0 + 4, permission: { aiAccess: 'rw' } })
    // The same owner also has a write-only closed session: `all` must omit it.
    await first.openSession({
      id: 'st-3', owner: 'owner-a', title: 'A wo', transport: 'ssh', host: 'a2.example', port: 22, username: 'a', createdAt: T0,
    })
    first.appendChunk('st-3', 'A-WO-EXPORT\n', T0 + 5, 'owner-a')
    await first.closeSession('st-3', { closedAt: T0 + 6, permission: { aiAccess: 'wo' } })
    await settle(first)
    await settle(second)

    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)
    const exported = await registry.exportHistory({ all: true, owner: 'owner-a', actor: 'ai' })
    assert.equal(exported.files.length, 1, 'only the caller owner has an AI-readable session to export')
    assert.equal(exported.files[0].sessionId, 'st-1')
    const text = await readFile(exported.files[0].path, 'utf8')
    assert.equal(text.includes('A-EXPORT'), true)
    assert.equal(text.includes('B-EXPORT'), false)
    assert.equal(text.includes('A-WO-EXPORT'), false, 'a write-only closed session must not be exported')
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 5. Concurrent stores and a lost catalog.
 * ------------------------------------------------------------------ */

test('parallel stores with a lossy catalog still attribute every journal correctly', async () => {
  await withDir(async (dir) => {
    const first = makeStore(dir)
    const second = makeStore(dir)
    await Promise.all([first.init(), second.init()])
    await first.openSession({
      id: 'st-1', owner: 'owner-a', title: 'A', transport: 'ssh', host: 'a.example', port: 22, username: 'a', createdAt: T0,
    })
    first.appendChunk('st-1', 'PARALLEL-A\n', T0 + 1, 'owner-a')
    await second.openSession({
      id: 'st-1', owner: 'owner-b', title: 'B', transport: 'ssh', host: 'b.example', port: 22, username: 'b', createdAt: T0,
    })
    second.appendChunk('st-1', 'PARALLEL-B\n', T0 + 2, 'owner-b')
    await first.flush('st-1')
    await second.flush('st-1')
    await first.closeSession('st-1', { closedAt: T0 + 3, permission: { aiAccess: 'rw' } })
    await second.closeSession('st-1', { closedAt: T0 + 4, permission: { aiAccess: 'rw' } })
    await settle(first)
    await settle(second)

    // A stale/last-writer index must not affect attribution: write one that
    // claims the shared id for owner A. The journals are the authority.
    await writeFile(
      join(dir, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: [{
          id: 'st-1', title: 'stale catalog', transport: 'ssh', host: 'stale', port: 22, username: 'stale',
          createdAt: T0, lastTs: T0, owner: 'owner-a',
        }],
      })}\n`,
      { mode: 0o600 },
    )

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    const a = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'PARALLEL-A' })
    assert.equal(a.matches.length, 1)
    const b = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-b', actor: 'ai', search: 'PARALLEL-B' })
    assert.equal(b.matches.length, 1)
    const leaked = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'PARALLEL-B' })
    assert.equal(leaked.matches.length, 0, 'owner A must not see owner B bytes through any incarnation')
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 6. Host-wide auto-log switch is human-only.
 * ------------------------------------------------------------------ */

test('the AI cannot change the host-wide automatic log setting', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)
    /** @type {Array<Record<string, unknown>>} */
    const changes = []
    registry.autolog.get = () => ({ enabled: false, dir: join(dir, 'logs') })
    registry.autolog.set = async (options) => {
      changes.push(options)
      return { enabled: options.enabled === true, dir: join(dir, 'logs') }
    }

    const definitions = new Map()
    const ctx = {
      tools: { register(definition) { definitions.set(definition.name, definition); return () => {} }, get() { return undefined } },
      effect(run) { run(); return () => {} },
      inject() {},
      on() {},
    }
    registerTools(ctx, {
      config: resolveConfig({ ...DEFAULT_CONFIG, toolDisclosure: 'full' }),
      registry,
      scripts: undefined,
      profiles: {},
    })
    const tool = definitions.get('aiterm_autolog')
    assert.ok(tool, 'aiterm_autolog must be registered')
    const exec = { agent: { id: 'owner-ai' } }

    await rejectsWithCode(() => tool.execute({ enabled: true }, exec), 'HUMAN_ONLY')
    await rejectsWithCode(() => tool.execute({ dir: '/tmp/elsewhere' }, exec), 'HUMAN_ONLY')
    assert.deepEqual(changes, [], 'the host-wide switch must not change')
    const state = await tool.execute({}, exec)
    assert.equal(state.enabled, false, 'reading the current state stays available')
    await registry.dispose()
  })
})

test('the human panel can still change automatic log settings', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const autolog = new AutoLog({ dataDir: dir, dir: join(dir, 'logs'), log: () => {} })
    await autolog.init()
    const registry = new SessionRegistry({
      config: resolveConfig({ aiAccessDefault: 'rw', blockHumanWhileAi: true }),
      profiles: {},
      dataDir: dir,
      log: () => {},
      historyStore: store,
      autolog,
    })
    const next = await registry.autolog.set({ enabled: true, dir: join(dir, 'machine-logs') })
    assert.equal(next.enabled, true)
    assert.equal(registry.autolog.get().enabled, true)
    await registry.dispose()
  })
})

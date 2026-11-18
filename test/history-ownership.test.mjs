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
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AutoLog } from '../lib/host/autolog.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/host/config.js'
import { exportSessions } from '../lib/host/exporter.js'
import { HistoryStore } from '../lib/host/history-store.js'
import { createPermission } from '../lib/host/permission.js'
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


/* ------------------------------------------------------------------ *
 * 7. Identity allocation and per-incarnation addressability.
 * ------------------------------------------------------------------ */

test('session ids stay unique across a restart and across concurrent registries', async () => {
  await withDir(async (dir) => {
    const firstStore = makeStore(dir)
    await firstStore.init()
    const first = makeRegistry(dir, firstStore)
    first.openConnection = async (session) => {
      session.state = 'open'
    }
    const firstSession = await first.create({ transport: 'telnet', host: '10.0.0.1', port: 23 }, 'ai', 'owner-a')
    await first.close(firstSession.id, 'test', 'human', 'owner-a')
    await settle(firstStore)
    await first.dispose()

    // Restart: the persisted allocation must not hand out st-1 again.
    const secondStore = makeStore(dir)
    await secondStore.init()
    const second = makeRegistry(dir, secondStore)
    second.openConnection = async (session) => {
      session.state = 'open'
    }
    const secondSession = await second.create({ transport: 'telnet', host: '10.0.0.1', port: 23 }, 'ai', 'owner-a')
    assert.notEqual(secondSession.id, firstSession.id, 'a restart must not reuse a recorded st-N')

    const list = await second.historySessions({ owner: 'owner-a', actor: 'ai' })
    const ids = new Set(list.map((entry) => entry.id))
    assert.equal(ids.has(firstSession.id), true, 'the pre-restart history must remain addressable')
    assert.equal(ids.has(secondSession.id), true)

    // Two simultaneous instances on the same directory must not collide.
    const [leftStore, rightStore] = [makeStore(dir), makeStore(dir)]
    await Promise.all([leftStore.init(), rightStore.init()])
    const [left, right] = [makeRegistry(dir, leftStore), makeRegistry(dir, rightStore)]
    left.openConnection = async (session) => {
      session.state = 'open'
    }
    right.openConnection = async (session) => {
      session.state = 'open'
    }
    const [leftSession, rightSession] = await Promise.all([
      left.create({ transport: 'telnet', host: '10.0.0.2', port: 23 }, 'ai', 'owner-left'),
      right.create({ transport: 'telnet', host: '10.0.0.3', port: 23 }, 'ai', 'owner-right'),
    ])
    assert.notEqual(leftSession.id, rightSession.id, 'concurrent instances must reserve different ids')
    await left.dispose()
    await right.dispose()
    await second.dispose()
  })
})

test('every incarnation is listed and can be addressed and exported by historyId', async () => {
  await withDir(async (dir) => {
    const firstStore = makeStore(dir)
    await firstStore.init()
    await firstStore.openSession({
      id: 'st-1', owner: 'owner-same', title: 'first', transport: 'ssh', host: 'first.example', port: 22, username: 'u', createdAt: T0,
    })
    firstStore.appendChunk('st-1', 'FIRST-INCARNATION\n', T0 + 1, 'owner-same')
    await firstStore.closeSession('st-1', { owner: 'owner-same', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(firstStore)

    const secondStore = makeStore(dir)
    await secondStore.init()
    await secondStore.openSession({
      id: 'st-1', owner: 'owner-same', title: 'second', transport: 'ssh', host: 'second.example', port: 22, username: 'u', createdAt: T0 + 3,
    })
    secondStore.appendChunk('st-1', 'SECOND-INCARNATION\n', T0 + 4, 'owner-same')
    await secondStore.closeSession('st-1', { owner: 'owner-same', closedAt: T0 + 5, permission: { aiAccess: 'wo' } })
    await settle(secondStore)

    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)
    const list = await registry.historySessions({ owner: 'owner-same', actor: 'human' })
    const sameId = list.filter((entry) => entry.id === 'st-1')
    assert.equal(sameId.length, 2, 'both incarnations must remain listed')
    const historyIds = new Set(sameId.map((entry) => entry.historyId))
    assert.equal(historyIds.size, 2, 'each incarnation must have its own address')
    assert.equal([...historyIds].some((value) => typeof value !== 'string' || value.length === 0), false)

    const firstEntry = sameId.find((entry) => entry.title === 'first')
    const secondEntry = sameId.find((entry) => entry.title === 'second')
    const firstResult = await registry.historyQuery({
      sessionId: 'st-1', historyId: firstEntry.historyId, owner: 'owner-same', actor: 'human', search: 'FIRST-INCARNATION',
    })
    assert.equal(firstResult.matches.length, 1)
    const secondResult = await registry.historyQuery({
      sessionId: 'st-1', historyId: secondEntry.historyId, owner: 'owner-same', actor: 'human', search: 'SECOND-INCARNATION',
    })
    assert.equal(secondResult.matches.length, 1)
    const crossed = await registry.historyQuery({
      sessionId: 'st-1', historyId: firstEntry.historyId, owner: 'owner-same', actor: 'human', search: 'SECOND-INCARNATION',
    })
    assert.equal(crossed.matches.length, 0, 'a historyId must never merge the other incarnation')

    const firstExport = await registry.exportHistory({
      sessionId: 'st-1', historyId: firstEntry.historyId, owner: 'owner-same', actor: 'human',
    })
    const firstText = await readFile(firstExport.files[0].path, 'utf8')
    assert.equal(firstText.includes('FIRST-INCARNATION'), true)
    assert.equal(firstText.includes('SECOND-INCARNATION'), false)
    const secondExport = await registry.exportHistory({
      sessionId: 'st-1', historyId: secondEntry.historyId, owner: 'owner-same', actor: 'human',
    })
    const secondText = await readFile(secondExport.files[0].path, 'utf8')
    assert.equal(secondText.includes('SECOND-INCARNATION'), true)
    assert.equal(secondText.includes('FIRST-INCARNATION'), false)
    assert.notEqual(firstExport.files[0].path, secondExport.files[0].path, 'each incarnation needs a distinct export file')

    // AI permission is per incarnation: the first is rw, the second is wo.
    const firstAi = await registry.historyQuery({
      sessionId: 'st-1', historyId: firstEntry.historyId, owner: 'owner-same', actor: 'ai', search: 'FIRST-INCARNATION',
    })
    assert.equal(firstAi.matches.length, 1)
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', historyId: secondEntry.historyId, owner: 'owner-same', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    // Another owner can never use a leaked historyId.
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', historyId: firstEntry.historyId, owner: 'owner-other', actor: 'ai' }),
      'SESSION_NOT_FOUND',
    )
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 8. Close and export failure paths.
 * ------------------------------------------------------------------ */

test('a failed reservation never lets close stamp an unrelated crash journal', async () => {
  await withDir(async (dir) => {
    // A previous incarnation crashed after flushing bytes but before close.
    const oldStore = makeStore(dir)
    await oldStore.init()
    await oldStore.openSession({
      id: 'st-1', owner: 'owner-a', title: 'crashed', transport: 'ssh', host: 'old.example', port: 22, username: 'u', createdAt: T0,
    })
    oldStore.appendChunk('st-1', 'CRASHED-DATA\n', T0 + 1, 'owner-a')
    await oldStore.flush('st-1')
    await oldStore.dispose()

    class FailingReservationStore extends HistoryStore {
      async reserveJournal() {
        return undefined
      }
    }
    const broken = new FailingReservationStore({ dir, flushIntervalMs: 5, log: () => {} })
    await broken.init()
    const opened = await broken.openSession({
      id: 'st-1', owner: 'owner-a', title: 'new', transport: 'ssh', host: 'new.example', port: 22, username: 'u', createdAt: T0 + 2,
    })
    assert.equal(opened, false, 'the reservation failure must be reported')
    await broken.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 3, permission: { aiAccess: 'rw' } })
    await settle(broken)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    await rejectsWithCode(
      () => registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai' }),
      'AI_READ_DENIED',
      'permission for the crashed incarnation must stay unknown',
    )
    const human = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'human', search: 'CRASHED-DATA' })
    assert.equal(human.matches.length, 1)
    await registry.dispose()
  })
})

test('live journal resolution re-checks the owner instead of trusting the id', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'a', transport: 'ssh', host: 'a.example', port: 22, username: 'u', createdAt: T0,
    })
    await store.openSession({
      id: 'st-1', owner: 'owner-b', title: 'b', transport: 'ssh', host: 'b.example', port: 22, username: 'u', createdAt: T0 + 1,
    })
    assert.equal(store.activeJournal('st-1', 'owner-a'), undefined, 'owner A must not resolve owner B active journal')
    assert.ok(store.activeJournal('st-1', 'owner-b'))
  })
})

test('an export waits for an unfinished journal reservation', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const original = store.openSession.bind(store)
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    store.openSession = async (meta) => {
      await gate
      return original(meta)
    }
    const registry = makeRegistry(dir, store)
    registry.openConnection = async (session) => {
      session.state = 'open'
    }
    const info = await registry.create({ transport: 'telnet', host: '10.0.0.9', port: 23 }, 'ai', 'owner-early')
    registry.handleData(registry.sessions.get(info.id), 'EARLY-EXPORT\n')
    const pending = registry.exportHistory({ sessionId: info.id, owner: 'owner-early', actor: 'ai' })
    release()
    const result = await pending
    assert.equal(result.files.length, 1)
    const text = await readFile(result.files[0].path, 'utf8')
    assert.equal(text.includes('EARLY-EXPORT'), true)
    await registry.dispose()
  })
})

test('a failed close flush keeps the bytes and does not stamp a permission', async () => {
  await withDir(async (dir) => {
    let failures = 1
    class FailingAppendStore extends HistoryStore {
      async appendJournal(file, data) {
        if (failures > 0) {
          failures -= 1
          throw new Error('simulated append failure')
        }
        return super.appendJournal(file, data)
      }
    }
    const store = new FailingAppendStore({
      dir,
      retentionMs: 3_600_000,
      maxBytesPerSession: 1_000_000,
      maxSessions: 100,
      flushIntervalMs: 60_000,
      log: () => {},
    })
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'flush', transport: 'ssh', host: 'a.example', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'FLUSH-MUST-SURVIVE\n', T0 + 1, 'owner-a')
    const journal = store.activeJournal('st-1', 'owner-a')
    assert.ok(journal)
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    const failedRaw = await readFile(journal, 'utf8')
    assert.equal(failedRaw.includes('FLUSH-MUST-SURVIVE'), false, 'the simulated append failed before bytes reached disk')
    assert.equal(failedRaw.includes('"_aiterm":"close"'), false, 'a failed flush must not stamp a close permission')

    // The bytes are still buffered; restoring the writer flushes them.
    await store.flush('st-1')
    const raw = await readFile(journal, 'utf8')
    assert.equal(decodedOutput(raw).includes('FLUSH-MUST-SURVIVE'), true, 'the close flush bytes must be retained and retryable')
    assert.equal(raw.includes('"_aiterm":"close"'), false, 'the permission may only be stamped after a successful flush')

    // Unknown permission after the failed close: AI fails closed, human reads.
    const blocked = makeStore(dir)
    await blocked.init()
    const blockedRegistry = makeRegistry(dir, blocked)
    await rejectsWithCode(
      () => blockedRegistry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai' }),
      'AI_READ_DENIED',
    )
    const human = await blockedRegistry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'human', search: 'FLUSH-MUST-SURVIVE' })
    assert.equal(human.matches.length, 1)
    await blockedRegistry.dispose()

    // A later close retry records the permission normally.
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 3, permission: { aiAccess: 'rw' } })
    await settle(store)
    const recovered = makeStore(dir)
    await recovered.init()
    const recoveredRegistry = makeRegistry(dir, recovered)
    const ai = await recoveredRegistry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'FLUSH-MUST-SURVIVE' })
    assert.equal(ai.matches.length, 1)
    await recoveredRegistry.dispose()
  })
})

test('an explicit export of a vanished journal fails instead of writing an empty file', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'gone', transport: 'ssh', host: 'a.example', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'GONE-DATA\n', T0 + 1, 'owner-a')
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(store)
    const journal = store.journalForSync('st-1', { owner: 'owner-a', actor: 'human' })
    assert.ok(journal)
    await rm(journal, { force: true })

    const registry = makeRegistry(dir, store)
    await rejectsWithCode(
      () => registry.exportHistory({ sessionId: 'st-1', owner: 'owner-a', actor: 'human' }),
      'SESSION_NOT_FOUND',
    )
    await registry.dispose()
  })
})

test('closed history search is case-insensitive like live history search', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'case', transport: 'ssh', host: 'a.example', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'SecretTokenValue\n', T0 + 1, 'owner-a')
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(store)
    const registry = makeRegistry(dir, store)
    const result = await registry.historyQuery({ sessionId: 'st-1', owner: 'owner-a', actor: 'ai', search: 'secrettokenvalue' })
    assert.equal(result.matches.length, 1, 'search must not silently differ between live and closed sessions')
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 9. Explicit human-only legacy history access.
 * ------------------------------------------------------------------ */

test('the owner-bound panel has a human-only legacy bucket that never attributes or edits old files', async () => {
  await withDir(async (dir) => {
    const legacy = `${JSON.stringify({ t: T0, d: payload('UNOWNED-OLD\n') })}\n`
    await writeFile(join(dir, 'st-1.ndjson'), legacy, { mode: 0o600 })
    await writeFile(join(dir, 'st-9.ndjson'), `${JSON.stringify({ t: T0, d: payload('ORPHAN\n') })}\n`, { mode: 0o600 })
    await writeFile(
      join(dir, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: [{ id: 'st-1', title: 'old unowned', transport: 'ssh', host: 'old.example', port: 22, username: 'old', createdAt: T0, lastTs: T0 }],
      })}\n`,
      { mode: 0o600 },
    )

    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)

    const list = await registry.legacyHistorySessions({ actor: 'human' })
    assert.deepEqual(list.map((entry) => entry.id), ['st-1'])
    const query = await registry.legacyHistoryQuery({ actor: 'human', sessionId: 'st-1', search: 'UNOWNED-OLD' })
    assert.equal(query.matches.length, 1)
    const exported = await registry.legacyHistoryExport({ actor: 'human', sessionId: 'st-1' })
    assert.equal(exported.files.length, 1)
    assert.equal((await readFile(exported.files[0].path, 'utf8')).includes('UNOWNED-OLD'), true)

    // The explicit view never rewrites, renames or attributes the old file.
    assert.equal(await readFile(join(dir, 'st-1.ndjson'), 'utf8'), legacy)
    const again = await registry.legacyHistorySessions({ actor: 'human' })
    assert.equal(again.length, 1)
    assert.equal(again[0].owner, undefined)
    assert.equal(again[0].historyId, undefined)

    // Orphans still never appear, even in the explicit human bucket.
    await rejectsWithCode(() => registry.legacyHistoryQuery({ actor: 'human', sessionId: 'st-9' }), 'SESSION_NOT_FOUND')
    await rejectsWithCode(() => registry.legacyHistoryExport({ actor: 'human', sessionId: 'st-9' }), 'SESSION_NOT_FOUND')

    // No AI path exists through these methods.
    await rejectsWithCode(() => registry.legacyHistorySessions({ actor: 'ai' }), 'HUMAN_ONLY')
    await rejectsWithCode(() => registry.legacyHistoryQuery({ actor: 'ai', sessionId: 'st-1' }), 'HUMAN_ONLY')
    await rejectsWithCode(() => registry.legacyHistoryExport({ actor: 'ai', sessionId: 'st-1' }), 'HUMAN_ONLY')

    // The normal owner-bound view still excludes legacy data.
    const normal = await registry.historySessions({ actor: 'human', owner: 'owner-real' })
    assert.deepEqual(normal, [])
    await registry.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 10. Automatic-log legacy settings migration.
 * ------------------------------------------------------------------ */

test('a legacy enabled autolog setting is preserved but stays off until the human confirms', async () => {
  await withDir(async (dir) => {
    const settingsFile = join(dir, 'settings.json')
    const logsDir = join(dir, 'old-logs')
    const original = `${JSON.stringify({
      version: 1,
      other: { keep: true },
      autolog: { enabled: true, dir: logsDir },
    }, null, 2)}\n`
    await writeFile(settingsFile, original, { mode: 0o600 })

    const autolog = new AutoLog({ dataDir: dir, settingsFile, log: () => {} })
    await autolog.init()
    const pending = autolog.get()
    assert.equal(pending.enabled, false, 'the unsafe persisted value must not start writing after upgrade')
    assert.equal(pending.needsReview, true)
    assert.equal(pending.dir, logsDir, 'the original directory is preserved for the human decision')
    assert.equal(await readFile(settingsFile, 'utf8'), original, 'loading must not rewrite the real settings file')

    await autolog.set({ enabled: false })
    const off = autolog.get()
    assert.equal(off.enabled, false)
    assert.equal(off.needsReview, false)
    assert.equal(off.dir, logsDir, 'confirming keep-off preserves the configured directory')
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.equal(saved.autolog.enabled, false)
    assert.equal(saved.autolog.dir, logsDir)
    assert.equal(typeof saved.autolog.reviewedAt, 'number')
    assert.deepEqual(saved.other, { keep: true }, 'unrelated settings survive the write')
    await autolog.dispose()
  })
})

test('the human can explicitly re-enable a legacy autolog setting', async () => {
  await withDir(async (dir) => {
    const settingsFile = join(dir, 'settings.json')
    const logsDir = join(dir, 'old-logs')
    await writeFile(
      settingsFile,
      `${JSON.stringify({ version: 1, autolog: { enabled: true, dir: logsDir } })}\n`,
      { mode: 0o600 },
    )
    const autolog = new AutoLog({ dataDir: dir, settingsFile, log: () => {} })
    await autolog.init()
    assert.equal(autolog.get().needsReview, true)
    const enabled = await autolog.set({ enabled: true })
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.needsReview, false)
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.equal(saved.autolog.enabled, true)
    assert.equal(saved.autolog.dir, logsDir)
    assert.equal(typeof saved.autolog.reviewedAt, 'number')
    await autolog.dispose()
  })
})


/* ------------------------------------------------------------------ *
 * 11. Bounded scans, export size and audit.
 * ------------------------------------------------------------------ */

test('unknown history ids do not trigger one directory scan per request', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const baseline = store.scanCount
    for (let index = 0; index < 25; index += 1) {
      await store.resolveForRead(`st-${10_000 + index}`, 'owner-a', 'ai')
    }
    assert.ok(store.scanCount - baseline <= 1, `misses must not rescan the directory each time (scans: ${store.scanCount - baseline})`)
  })
})

test('export streams a large journal instead of enforcing an arbitrary size ceiling', async () => {
  await withDir(async (dir) => {
    const journal = join(dir, 'large.ndjson')
    const lines = []
    for (let index = 0; index < 4000; index += 1) {
      lines.push(JSON.stringify({ t: T0 + index, d: payload(`${String(index).padStart(5, '0')} ${'X'.repeat(200)}\n`) }))
    }
    await writeFile(journal, `${lines.join('\n')}\n`, { mode: 0o600 })
    const out = join(dir, 'exports')
    const fakeStore = {
      fileFor: () => journal,
      flush: async () => {},
      listSessions: async () => [{
        id: 'st-1', title: 'large', transport: 'ssh', host: 'h.example', port: 22, username: 'u', createdAt: T0, bytes: 1, lastTs: T0,
      }],
    }
    const result = await exportSessions({ historyStore: fakeStore, dir: out, sessionId: 'st-1' })
    assert.equal(result.files.length, 1)
    assert.deepEqual(result.skipped, [])
    assert.ok(result.files[0].bytes > 64 * 1024, 'the streamed export is not empty')
    assert.equal(result.files[0].lines, 4002, 'all records plus the two header lines')
    const text = await readFile(result.files[0].path, 'utf8')
    assert.ok(text.includes('03999 '), 'the final record was streamed')
  })
})

test('export all covers every readable incarnation, skips unreadable ones, and reports missing sources', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const openSame = async (title, createdAt) => {
      await store.openSession({
        id: 'st-1', owner: 'owner-same', title, transport: 'ssh', host: 'same.example', port: 22, username: 'u', createdAt,
      })
    }
    await openSame('first', T0)
    store.appendChunk('st-1', 'FIRST-ALL\n', T0 + 1, 'owner-same')
    await store.closeSession('st-1', { owner: 'owner-same', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await openSame('second', T0 + 3)
    store.appendChunk('st-1', 'SECOND-ALL\n', T0 + 4, 'owner-same')
    await store.closeSession('st-1', { owner: 'owner-same', closedAt: T0 + 5, permission: { aiAccess: 'rw' } })
    await openSame('wo', T0 + 6)
    store.appendChunk('st-1', 'WO-ALL\n', T0 + 7, 'owner-same')
    await store.closeSession('st-1', { owner: 'owner-same', closedAt: T0 + 8, permission: { aiAccess: 'wo' } })
    await openSame('crash', T0 + 9)
    store.appendChunk('st-1', 'UNKNOWN-ALL\n', T0 + 10, 'owner-same')
    await store.flush('st-1')
    await settle(store)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)

    const ai = await registry.exportHistory({ all: true, owner: 'owner-same', actor: 'ai' })
    assert.equal(ai.files.length, 2, 'both rw incarnations are exported')
    assert.equal(ai.skipped.length, 2, 'wo and unknown-permission incarnations are reported individually')
    assert.deepEqual(new Set(ai.skipped.map((entry) => entry.code)), new Set(['AI_READ_DENIED']))
    const aiText = (await Promise.all(ai.files.map((file) => readFile(file.path, 'utf8')))).join('\n')
    assert.equal(aiText.includes('FIRST-ALL'), true)
    assert.equal(aiText.includes('SECOND-ALL'), true)
    assert.equal(aiText.includes('WO-ALL'), false)
    assert.equal(aiText.includes('UNKNOWN-ALL'), false)
    assert.equal(new Set(ai.files.map((file) => file.path)).size, ai.files.length)

    const human = await registry.exportHistory({ all: true, owner: 'owner-same', actor: 'human' })
    assert.equal(human.files.length, 4, 'the human can export all recorded incarnations')
    const humanText = (await Promise.all(human.files.map((file) => readFile(file.path, 'utf8')))).join('\n')
    assert.equal(humanText.includes('WO-ALL'), true)
    assert.equal(humanText.includes('UNKNOWN-ALL'), true)
    assert.equal(human.skipped.length, 0)

    // A vanished source is reported as skipped, never as a successful file.
    const missing = ai.files[0]
    await rm(missing.path, { force: true })
    const withMissing = await registry.exportHistory({ all: true, owner: 'owner-same', actor: 'ai' })
    assert.ok(withMissing.files.length >= 1, 'readable sources are still exported')
    assert.equal(withMissing.skipped.length, 2, 'only the permission skips remain after an export file is deleted')

    const source = fresh.journalForSync('st-1', { owner: 'owner-same', actor: 'ai', historyId: ai.files[0].historyId })
    assert.ok(source)
    await rm(source, { force: true })
    const skipped = await registry.exportHistory({ all: true, owner: 'owner-same', actor: 'ai' })
    assert.equal(skipped.skipped.length, 3, 'two permission skips plus the missing source')
    const missingSkip = skipped.skipped.find((entry) => entry.code === 'SESSION_NOT_FOUND')
    assert.ok(missingSkip)
    assert.equal(missingSkip.sessionId, 'st-1')
    assert.equal(skipped.skipped.filter((entry) => entry.code === 'AI_READ_DENIED').length, 2)
    assert.equal(skipped.files.length, 1, 'the remaining readable incarnation is exported')
    await registry.dispose()
  })
})

test('concurrent all-exports never choose the same file name', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'same', transport: 'ssh', host: 'a.example', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'CONCURRENT\n', T0 + 1, 'owner-a')
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(store)
    const registry = makeRegistry(dir, store)
    const [left, right] = await Promise.all([
      registry.exportHistory({ all: true, owner: 'owner-a', actor: 'ai' }),
      registry.exportHistory({ all: true, owner: 'owner-a', actor: 'ai' }),
    ])
    const leftPaths = new Set(left.files.map((file) => file.path))
    const rightPaths = new Set(right.files.map((file) => file.path))
    for (const path of leftPaths) assert.equal(rightPaths.has(path), false)
    await registry.dispose()
  })
})

test('live history reads and exports are recorded in the session audit', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store)
    registry.openConnection = async (session) => {
      session.state = 'open'
    }
    const info = await registry.create({ transport: 'telnet', host: '10.0.0.4', port: 23 }, 'ai', 'owner-audit')
    const record = registry.sessions.get(info.id)
    registry.handleData(record, 'AUDIT-ME\n')
    await registry.historyQuery({ sessionId: info.id, owner: 'owner-audit', actor: 'ai' })
    assert.ok(record.audit.some((entry) => entry.action === 'read' && entry.detail === 'history:slice'))
    await registry.exportHistory({ sessionId: info.id, owner: 'owner-audit', actor: 'ai' })
    assert.ok(record.audit.some((entry) => entry.action === 'read' && entry.detail === 'export'))
    await registry.dispose()
  })
})

test('id allocation skips ids occupied by an old automatic-log file', async () => {
  await withDir(async (dir) => {
    const logsDir = join(dir, 'logs')
    await mkdir(logsDir, { recursive: true })
    await writeFile(join(logsDir, 'st-1.log'), 'OLD OWNER OUTPUT\n', { mode: 0o600 })

    const store = makeStore(dir)
    await store.init()
    const id = await store.allocateSessionId({
      isIdAvailable: async (candidate) => !(await new AutoLog({ dataDir: dir, dir: logsDir, log: () => {} }).hasLog(candidate)),
    })
    assert.notEqual(id, 'st-1', 'an existing <id>.log must force a different session id')

    const autolog = new AutoLog({ dataDir: dir, dir: logsDir, log: () => {} })
    await autolog.init()
    const registry = new SessionRegistry({
      config: resolveConfig({ aiAccessDefault: 'rw', blockHumanWhileAi: true }),
      profiles: {},
      dataDir: dir,
      log: () => {},
      historyStore: store,
      autolog,
    })
    registry.openConnection = async (session) => {
      session.state = 'open'
    }
    const info = await registry.create({ transport: 'telnet', host: '10.0.0.5', port: 23 }, 'ai', 'owner-a')
    assert.notEqual(info.id, 'st-1', 'the registry allocator must consult the autolog files')
    await registry.dispose()
  })
})

test('the legacy view opens the legacy file even when a new incarnation shares its id', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'st-1.ndjson'), `${JSON.stringify({ t: T0, d: payload('LEGACY-ONLY\n') })}\n`, { mode: 0o600 })
    await writeFile(
      join(dir, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: [{ id: 'st-1', title: 'legacy', transport: 'ssh', host: 'old', port: 22, username: 'u', createdAt: T0, lastTs: T0 }],
      })}\n`,
      { mode: 0o600 },
    )
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: null, title: 'new ownerless', transport: 'ssh', host: 'new', port: 22, username: 'u', createdAt: T0 + 1,
    })
    store.appendChunk('st-1', 'ATTRIBUTED-ONLY\n', T0 + 2, null)
    await store.closeSession('st-1', { owner: null, closedAt: T0 + 3, permission: { aiAccess: 'rw' } })
    await settle(store)

    const fresh = makeStore(dir)
    await fresh.init()
    const registry = makeRegistry(dir, fresh)
    // The normal no-owner list must not show two ambiguous rows for one id;
    // the legacy file is reachable through the explicit legacy view instead.
    const normal = await registry.historySessions({ actor: 'human', owner: null })
    assert.equal(normal.filter((entry) => entry.id === 'st-1').length, 1)
    assert.ok(normal.find((entry) => entry.id === 'st-1')?.historyId)
    const legacyHits = await registry.legacyHistoryQuery({ actor: 'human', sessionId: 'st-1', search: 'LEGACY-ONLY' })
    assert.equal(legacyHits.matches.length, 1)
    const attributedHits = await registry.legacyHistoryQuery({ actor: 'human', sessionId: 'st-1', search: 'ATTRIBUTED-ONLY' })
    assert.equal(attributedHits.matches.length, 0, 'the legacy view must never read a new incarnation')
    const exported = await registry.legacyHistoryExport({ actor: 'human', sessionId: 'st-1' })
    const text = await readFile(exported.files[0].path, 'utf8')
    assert.equal(text.includes('LEGACY-ONLY'), true)
    assert.equal(text.includes('ATTRIBUTED-ONLY'), false)
    await registry.dispose()
  })
})

test('export all does not report a readable live incarnation as a permission skip', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-live', title: 'closed', transport: 'ssh', host: 'closed.example', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'CLOSED-LIVE\n', T0 + 1, 'owner-live')
    await store.closeSession('st-1', { owner: 'owner-live', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    await settle(store)

    const registry = makeRegistry(dir, store)
    registry.openConnection = async (session) => {
      session.state = 'open'
    }
    const live = await registry.create({ transport: 'telnet', host: '10.0.0.6', port: 23 }, 'ai', 'owner-live')
    registry.handleData(registry.sessions.get(live.id), 'LIVE-DATA\n')
    const exported = await registry.exportHistory({ all: true, owner: 'owner-live', actor: 'ai' })
    assert.equal(exported.skipped.length, 0, 'a readable live incarnation is not a permission skip')
    assert.equal(exported.files.length, 2)
    const text = (await Promise.all(exported.files.map((file) => readFile(file.path, 'utf8')))).join('\n')
    assert.equal(text.includes('CLOSED-LIVE'), true)
    assert.equal(text.includes('LIVE-DATA'), true)
    await registry.dispose()
  })
})


/* ------------------------------------------------------------------ *
 * 12. Audit redaction, partial writes, live snapshot, prune, budget.
 * ------------------------------------------------------------------ */

test('audit never stores input text and redacts old entries before returning to AI', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    const registry = makeRegistry(dir, store, { aiAccessDefault: 'wo' })
    registry.openConnection = async (session) => {
      session.state = 'open'
      session.connection = { write() {}, resize() {}, close: async () => {} }
    }
    const info = await registry.create({ transport: 'telnet', host: '127.0.0.1', port: 23 }, 'human', 'owner-a')
    const session = registry.sessions.get(info.id)
    const secret = 'SUDO-PASSWORD-hunter2'
    await registry.write(info.id, `${secret}\n`, 'human', 'owner-a')
    const humanAudit = registry.audit({ sessionId: info.id, owner: 'owner-a', actor: 'human' })
    const aiAudit = registry.audit({ sessionId: info.id, owner: 'owner-a', actor: 'ai' })
    assert.equal(humanAudit.some((entry) => String(entry.detail).includes(secret)), false, 'new write entries must not store input')
    assert.equal(aiAudit.some((entry) => String(entry.detail).includes(secret)), false)

    // Simulate a pre-fix in-memory entry that still contains raw input.
    const legacyEntry = {
      at: Date.now(), sessionId: info.id, title: session.title, source: 'human',
      action: 'write', detail: 'OLD-SECRET-INPUT', byteLength: 15,
    }
    session.audit.push(legacyEntry)
    registry.globalAudit.push(legacyEntry)
    const redacted = registry.audit({ sessionId: info.id, owner: 'owner-a', actor: 'ai' })
    assert.equal(redacted.some((entry) => String(entry.detail).includes('OLD-SECRET-INPUT')), false)
    assert.ok(redacted.every((entry) => typeof entry.detail === 'string' && entry.detail.length > 0))
    const humanOld = registry.audit({ sessionId: info.id, owner: 'owner-a', actor: 'human' })
    assert.equal(humanOld.some((entry) => String(entry.detail).includes('OLD-SECRET-INPUT')), true, 'the human keeps the trusted view')

    // The real AI tool must be redacted as well.
    const definitions = new Map()
    const ctx = {
      tools: { register(definition) { definitions.set(definition.name, definition); return () => {} }, get() { return undefined } },
      effect(run) { run(); return () => {} },
      inject() {},
      on() {},
    }
    registerTools(ctx, { config: resolveConfig({ ...DEFAULT_CONFIG, toolDisclosure: 'full' }), registry, scripts: undefined, profiles: {} })
    const auditTool = definitions.get('aiterm_audit')
    const toolResult = await auditTool.execute({ sessionId: info.id }, { agent: { id: 'owner-a' } })
    assert.equal(String(toolResult.text).includes('OLD-SECRET-INPUT'), false)
    assert.equal(String(toolResult.text).includes(secret), false)

    await registry.close(info.id, 'test', 'human', 'owner-a')
    await settle(store)
    const globalAi = registry.audit({ owner: 'owner-a', actor: 'ai' })
    assert.equal(globalAi.some((entry) => String(entry.detail).includes('OLD-SECRET-INPUT')), false)
    assert.equal(globalAi.some((entry) => String(entry.detail).includes(secret)), false)
    await registry.dispose()
  })
})

test('export handles partial writes and never renames a failed temp file', async () => {
  await withDir(async (dir) => {
    const history = join(dir, 'history')
    const out = join(dir, 'exports')
    await mkdir(history, { recursive: true })
    const journal = join(history, 'st-1.ndjson')
    await writeFile(journal, `${JSON.stringify({ t: T0, d: payload('PARTIAL-WRITE\n') })}\n`, { mode: 0o600 })
    const fakeStore = {
      fileFor: () => journal,
      flush: async () => {},
      listSessions: async () => [{ id: 'st-1', title: 't', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 }],
    }
    const partial = async (handle, text) => {
      const buffer = Buffer.from(text, 'utf8')
      let offset = 0
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, 1)
        if (bytesWritten !== 1) throw new Error('short write')
        offset += 1
      }
    }
    const result = await exportSessions({ historyStore: fakeStore, dir: out, sessionId: 'st-1', writeAll: partial })
    const info = await stat(result.files[0].path)
    const text = await readFile(result.files[0].path, 'utf8')
    assert.equal(result.files[0].bytes, info.size)
    assert.equal(text.includes('PARTIAL-WRITE'), true)
    assert.equal((text.match(/\n/g) || []).length, result.files[0].lines)

    const failedOut = join(dir, 'failed-exports')
    const failing = async (handle, text) => {
      await handle.write(Buffer.from(text.slice(0, 1), 'utf8'))
      throw new Error('simulated disk full')
    }
    await assert.rejects(
      () => exportSessions({ historyStore: fakeStore, dir: failedOut, sessionId: 'st-1', writeAll: failing }),
      (error) => {
        assert.equal(error?.code, 'HISTORY_READ_FAILED')
        assert.equal(String(error.message).includes(history), false, 'the private journal path must not leak')
        return true
      },
    )
    assert.deepEqual(await readdir(failedOut), [], 'a failed stream must not leave a log or temp file')
  })
})

test('live export freezes the source boundary and never streams to EOF', async () => {
  await withDir(async (dir) => {
    const history = join(dir, 'history')
    await mkdir(history, { recursive: true })
    const journal = join(history, 'st-1~live.ndjson')
    await writeFile(journal, `${JSON.stringify({ _aiterm: 'journal', version: 1, id: 'st-1', owner: 'owner-a', title: 'live', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 })}\n${JSON.stringify({ t: T0, d: payload('PRE-SNAPSHOT\n') })}\n`, { mode: 0o600 })
    let release
    let reached
    const gate = new Promise((resolve) => { release = resolve })
    const reachedP = new Promise((resolve) => { reached = resolve })
    const fakeStore = {
      fileFor: () => journal,
      flush: async () => {},
      listSessions: async () => [{ id: 'st-1', historyId: 'st-1~live', title: 'live', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 }],
      beforeRead: async () => {
        reached()
        await gate
      },
    }
    const outcome = exportSessions({ historyStore: fakeStore, sessions: [], dir: join(dir, 'exports'), all: true })
    await reachedP
    await appendFile(journal, `${JSON.stringify({ t: T0 + 1, d: payload('AFTER-SNAPSHOT\n') })}\n`)
    release()
    const result = await outcome
    assert.equal(result.files.length, 1)
    const text = await readFile(result.files[0].path, 'utf8')
    assert.equal(text.includes('PRE-SNAPSHOT'), true)
    assert.equal(text.includes('AFTER-SNAPSHOT'), false, 'output after the frozen boundary must not be included')

    // A writer that keeps growing the file must not keep the exporter at EOF.
    const floodJournal = join(history, 'st-2~live.ndjson')
    await writeFile(floodJournal, `${JSON.stringify({ _aiterm: 'journal', version: 1, id: 'st-2', owner: 'owner-a', title: 'flood', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 })}\n${JSON.stringify({ t: T0, d: payload('FIRST\n') })}\n`, { mode: 0o600 })
    let flooding = true
    const flood = (async () => {
      let index = 0
      while (flooding) {
        await appendFile(floodJournal, `${JSON.stringify({ t: T0 + index, d: payload(`FLOOD-${index}\n`) })}\n`)
        index += 1
        if (index % 10 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
    })().catch(() => {})
    const floodStore = {
      fileFor: () => floodJournal,
      flush: async () => {},
      listSessions: async () => [{ id: 'st-2', historyId: 'st-2~live', title: 'flood', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 }],
    }
    const floodResult = await Promise.race([
      exportSessions({ historyStore: floodStore, sessions: [], dir: join(dir, 'flood-exports'), all: true }),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('export hung on a growing live journal')), 2500)),
    ])
    flooding = false
    await flood
    assert.equal(floodResult.files.length, 1)
    await rm(join(dir, 'flood-exports'), { recursive: true, force: true })
  })
})

test('revoking AI read during export fails closed, and closing during export uses the durable journal', async () => {
  await withDir(async (dir) => {
    let releaseFlush
    let reachedFlush
    let exportGate = false
    class GateStore extends HistoryStore {
      async flush(sessionId) {
        if (exportGate && sessionId === undefined) {
          exportGate = false
          reachedFlush()
          await new Promise((resolve) => { releaseFlush = resolve })
        }
        return super.flush(sessionId)
      }
    }
    const store = new GateStore({ dir, retentionMs: 3_600_000, maxBytesPerSession: 1_000_000, maxSessions: 100, flushIntervalMs: 10, log: () => {} })
    await store.init()
    const registry = makeRegistry(dir, store)
    registry.openConnection = async (session) => {
      session.state = 'open'
      session.connection = { write() {}, resize() {}, close: async () => {} }
    }
    const info = await registry.create({ transport: 'telnet', host: '127.0.0.1', port: 23 }, 'human', 'owner-a')
    const record = registry.sessions.get(info.id)
    registry.handleData(record, 'PRE-REVOKE\n')
    await store.flush(info.id)

    exportGate = true
    const reached = new Promise((resolve) => { reachedFlush = resolve })
    const exportPromise = registry.exportHistory({ all: true, owner: 'owner-a', actor: 'ai' })
    await reached
    registry.setAiAccess(info.id, 'wo', 'human', 'owner-a')
    registry.handleData(record, 'POST-REVOKE-SECRET\n')
    await store.flush(info.id)
    releaseFlush()
    const result = await exportPromise
    assert.equal(result.files.length, 0, 'revoked live read must not produce an export file')
    assert.ok(result.skipped.length > 0)
    assert.equal(result.skipped.some((entry) => String(entry.message).includes('POST-REVOKE-SECRET')), false)

    // Restore read, gate again, and close the session while the export runs.
    registry.setAiAccess(info.id, 'rw', 'human', 'owner-a')
    exportGate = true
    const closeReached = new Promise((resolve) => { reachedFlush = resolve })
    const closeExport = registry.exportHistory({ sessionId: info.id, owner: 'owner-a', actor: 'ai' })
    await closeReached
    await registry.close(info.id, 'race close', 'human', 'owner-a')
    await settle(store)
    releaseFlush()
    const closedResult = await closeExport
    assert.equal(closedResult.files.length, 1, 'the durable incarnation must remain exportable after close')
    const closedText = await readFile(closedResult.files[0].path, 'utf8')
    assert.equal(closedText.includes('PRE-REVOKE'), true)
    await registry.dispose()
  })
})

test('prune preserves unclosed journals from another store and uses mtime for closed ones', async () => {
  await withDir(async (dir) => {
    const oldAt = Date.now() - 3 * 24 * 60 * 60 * 1000
    const first = makeStore(dir, { retentionMs: 3_600_000 })
    await first.init()
    await first.openSession({
      id: 'st-1', owner: 'owner-a', title: 'live', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: oldAt,
    })
    first.appendChunk('st-1', 'FIRST-LIVE\n', oldAt + 1, 'owner-a')
    await first.flush('st-1')
    const liveJournal = first.journalForSync('st-1', { owner: 'owner-a', actor: 'human' })
    assert.ok(liveJournal)

    const second = makeStore(dir, { retentionMs: 3_600_000 })
    await second.init()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(await stat(liveJournal).then(() => true, () => false), 'another store must not prune an unclosed live journal')
    first.appendChunk('st-1', 'SECOND-LIVE\n', Date.now(), 'owner-a')
    await first.flush('st-1')
    const liveText = decodedOutput(await readFile(liveJournal, 'utf8'))
    assert.equal(liveText.includes('FIRST-LIVE'), true)
    assert.equal(liveText.includes('SECOND-LIVE'), true)

    // A closed journal with a huge tail written recently but an old lastTs must
    // survive because its filesystem mtime is recent.
    await first.openSession({
      id: 'st-2', owner: 'owner-a', title: 'big-tail', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: oldAt,
    })
    first.appendChunk('st-2', `${'X'.repeat(100 * 1024)}\n`, oldAt + 2, 'owner-a')
    await first.flush('st-2')
    const bigJournal = first.journalForSync('st-2', { owner: 'owner-a', actor: 'human' })
    await first.closeSession('st-2', { owner: 'owner-a', closedAt: oldAt + 3, permission: { aiAccess: 'rw' } })
    await settle(first)
    const third = makeStore(dir, { retentionMs: 3_600_000 })
    await third.init()
    assert.ok(await stat(bigJournal).then(() => true, () => false), 'recent mtime must protect the large tail')

    // With both timestamps old, the closed journal is pruned.
    await utimes(bigJournal, new Date(oldAt), new Date(oldAt))
    const fourth = makeStore(dir, { retentionMs: 3_600_000 })
    await fourth.init()
    assert.equal(await stat(bigJournal).then(() => true, () => false), false, 'a genuinely old closed journal is pruned')
    await first.dispose()
    await second.dispose()
    await third.dispose()
    await fourth.dispose()
  })
})

test('export enforces a per-call output budget and reports the skipped file', async () => {
  await withDir(async (dir) => {
    const history = join(dir, 'history')
    await mkdir(history, { recursive: true })
    const first = join(history, 'a.ndjson')
    const second = join(history, 'b.ndjson')
    const record = (text) => `${JSON.stringify({ t: T0, d: payload(text) })}\n`
    await writeFile(first, record(`${'A'.repeat(400)}\n`), { mode: 0o600 })
    await writeFile(second, record(`${'B'.repeat(400)}\n`), { mode: 0o600 })
    const store = {
      fileFor: (id) => (id === 'st-1' ? first : id === 'st-2' ? second : undefined),
      flush: async () => {},
      listSessions: async () => [
        { id: 'st-1', title: 'a', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 },
        { id: 'st-2', title: 'b', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 },
      ],
    }
    const result = await exportSessions({ historyStore: store, dir: join(dir, 'budget'), all: true, maxTotalBytes: 900 })
    assert.equal(result.files.length, 1)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].code, 'EXPORT_BUDGET')
    assert.equal(result.skipped[0].sessionId, 'st-2')
    await assert.rejects(
      () => exportSessions({ historyStore: store, dir: join(dir, 'budget-explicit'), sessionId: 'st-2', maxTotalBytes: 100 }),
      (error) => {
        assert.equal(error?.code, 'EXPORT_BUDGET')
        return true
      },
    )
    assert.deepEqual(await readdir(join(dir, 'budget-explicit')), [])
  })
})

test('allocation uses one high-water scan, skips reservations, and fails fast on a broken directory', async () => {
  await withDir(async (dir) => {
    const history = join(dir, 'history')
    await mkdir(history, { recursive: true })
    await writeFile(join(history, 'st-500.ndjson'), `${JSON.stringify({ t: T0, d: payload('OLD\n') })}\n`, { mode: 0o600 })
    await mkdir(join(history, '.ids'), { recursive: true })
    await writeFile(join(history, '.ids', 'st-1'), '{}', { mode: 0o600 })
    await writeFile(join(history, '.ids', 'st-2'), '{}', { mode: 0o600 })
    const store = makeStore(history)
    await store.init()
    const id = await store.allocateSessionId()
    assert.equal(id, 'st-501', 'the fresh high-water scan skips every used/reserved id')

    const brokenPath = join(dir, 'not-a-directory')
    await writeFile(brokenPath, 'x', { mode: 0o600 })
    const broken = new HistoryStore({ dir: brokenPath, log: () => {} })
    await broken.init()
    const brokenId = await broken.allocateSessionId()
    assert.equal(brokenId, undefined, 'a non-ENOENT directory error must fail allocation, not walk candidates')
  })
})

test('a historyId-only query resolves its incarnation and list truncation is explicit', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    for (const [id, text] of [['st-1', 'ONE\n'], ['st-2', 'TWO\n']]) {
      await store.openSession({
        id, owner: 'owner-a', title: id, transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0,
      })
      store.appendChunk(id, text, T0 + 1, 'owner-a')
      await store.closeSession(id, { owner: 'owner-a', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    }
    await settle(store)
    const registry = makeRegistry(dir, store)
    const list = await registry.historySessions({ owner: 'owner-a', actor: 'human' })
    const first = list.find((entry) => entry.id === 'st-1')
    assert.ok(first?.historyId)
    const byHistoryId = await registry.historyQuery({ historyId: first.historyId, owner: 'owner-a', actor: 'human', search: 'ONE' })
    assert.equal(byHistoryId.matches.length, 1, 'historyId alone must be resolved, not treated as a list request')
    await rejectsWithCode(
      () => registry.historyQuery({ historyId: 'st-1~missing', owner: 'owner-a', actor: 'human' }),
      'SESSION_NOT_FOUND',
    )
    const page = await registry.historyQuery({ owner: 'owner-a', actor: 'human', limit: 1 })
    assert.equal(page.sessions.length, 1)
    assert.equal(page.truncated, true)
    await registry.dispose()
  })
})

test('history list keeps older incarnations that share a live logical id', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir)
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'old', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0,
    })
    store.appendChunk('st-1', 'OLD-INCARNATION\n', T0 + 1, 'owner-a')
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 2, permission: { aiAccess: 'rw' } })
    const handle = await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'live', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0 + 3,
    })
    assert.ok(handle && typeof handle === 'object')
    const registry = makeRegistry(dir, store)
    const now = Date.now()
    registry.sessions.set('st-1', {
      id: 'st-1', title: 'live', transport: 'ssh', host: 'h', port: 22, username: 'u', owner: 'owner-a', state: 'open',
      createdAt: now, updatedAt: now, lastActivityAt: now, bytesIn: 0, bytesOut: 0, lastOutputAt: now,
      permission: createPermission(registry.config), historyId: handle.historyId,
    })
    registry.owners.set('st-1', 'owner-a')
    const page = await registry.historySessionsPage({ owner: 'owner-a', actor: 'human' })
    const sameId = page.sessions.filter((entry) => entry.id === 'st-1')
    assert.equal(sameId.length, 2, 'live plus the older incarnation must both be listed')
    assert.equal(new Set(sameId.map((entry) => entry.historyId)).size, 2)
    await registry.dispose()
  })
})

test('a permanently failing writer bounds pending bytes, drops visibly and recovers', async () => {
  await withDir(async (dir) => {
    let failing = true
    const logs = []
    class FailingStore extends HistoryStore {
      async appendJournal(file, data) {
        if (failing) throw new Error('simulated permanent disk failure')
        return super.appendJournal(file, data)
      }
    }
    const store = new FailingStore({
      dir,
      retentionMs: 3_600_000,
      maxBytesPerSession: 1_000_000,
      maxSessions: 100,
      flushIntervalMs: 60_000,
      maxPendingBytes: 1024,
      log: (level, message) => logs.push(`${level}:${message}`),
    })
    await store.init()
    await store.openSession({
      id: 'st-1', owner: 'owner-a', title: 'fail', transport: 'ssh', host: 'h', port: 22, username: 'u', createdAt: T0,
    })
    for (let index = 0; index < 30; index += 1) {
      store.appendChunk('st-1', `CHUNK-${String(index).padStart(2, '0')} ${'X'.repeat(180)}\n`, T0 + index, 'owner-a')
      await store.flush('st-1')
    }
    const failed = await store.stats('st-1')
    assert.ok(failed)
    assert.ok(failed.pendingBytes <= 1024, `pending must stay bounded, got ${failed.pendingBytes}`)
    assert.ok(failed.droppedBytes > 0, 'the drop policy must be visible, not zero-loss')
    assert.ok(failed.writeFailures > 0)
    assert.equal(failed.degraded, true)
    assert.ok(logs.length <= 4, `failure logging must be throttled, got ${logs.length}`)

    failing = false
    store.appendChunk('st-1', 'RECOVERED-NEWEST\n', T0 + 100, 'owner-a')
    await store.flush('st-1')
    const recovered = await store.stats('st-1')
    assert.equal(recovered.pendingBytes, 0)
    assert.equal(recovered.writeFailures, 0)
    assert.equal(recovered.degraded, true, 'prior dropped bytes keep the alert sticky')
    const journal = store.activeJournal('st-1', 'owner-a')
    const text = decodedOutput(await readFile(journal, 'utf8'))
    assert.equal(text.includes('RECOVERED-NEWEST'), true, 'newest output survives')
    assert.equal(text.includes('CHUNK-00 '), false, 'old unsaved bytes were explicitly dropped')
    await store.closeSession('st-1', { owner: 'owner-a', closedAt: T0 + 101, permission: { aiAccess: 'rw' } })
    await store.dispose()
  })
})

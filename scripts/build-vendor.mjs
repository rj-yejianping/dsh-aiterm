/**
 * Build `vendor/ssh2.cjs` — the pure-JS `ssh2` bundle shipped inside this package.
 *
 * Why: `ssh2` is already pure JS, but it carries two *optional* native extras
 * (`cpu-features` and its own `sshcrypto` node-gyp binding). Both are loaded
 * inside `try/catch` with a pure-JS fallback, yet their `install` / `rebuild`
 * scripts make pnpm 10+ stop and ask for build approval — which rolls back the
 * whole DSH profile install. Vendoring removes them from the dependency graph.
 *
 * Usage: `npm install && npm run build:vendor`
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const entry = require.resolve('ssh2')
const esbuild = resolve(root, 'node_modules', '.bin', 'esbuild')
const outfile = resolve(root, 'vendor', 'ssh2.cjs')

execFileSync(esbuild, [
  entry,
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${outfile}`,
  '--external:cpu-features',
  '--external:nan',
  '--external:./crypto/build/Release/sshcrypto.node',
  '--log-level=warning',
], { stdio: 'inherit' })

const { statSync } = await import('node:fs')
console.log(`build-vendor: wrote ${outfile} (${Math.round(statSync(outfile).size / 1024)} KiB)`)

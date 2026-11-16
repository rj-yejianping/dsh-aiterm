#!/usr/bin/env node
/**
 * Build the browser half of `dsh-aiterm`.
 *
 * esbuild bundles `client/index.js` (React/JSX + xterm.js) into CommonJS, then
 * this script wraps the bundle in the Harness client module loader factory and
 * writes `lib/client.js`. `npm run build` reproduces the committed artifact.
 *
 * The wrapper shape is fixed by CONTRACTS.md §6 and the Harness module loader:
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-aiterm',
 *     factory(require) {
 *       var module = { exports: {} };
 *       ...bundled CJS...
 *       return module.exports
 *     },
 *   })
 *
 * Only `react`, `react-dom` and `react/jsx-runtime` may stay external: a
 * Harness client package is never imported by a third-party bundle, so the
 * build fails if the emitted bundle requires one.
 */

import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'client/index.js')
const output = resolve(root, 'lib/client.js')

/** Modules the Harness browser module table provides. */
const MODULE_TABLE = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
])

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

// The client module id, the package name and the patch row name must be one
// string: the module table indexes by id while the composition indexes by
// package name, so a mismatch registers the row but never activates it.
const PLUGIN_ID = manifest.name

const result = await build({
  entryPoints: [entry],
  absWorkingDir: root,
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'inline',
  charset: 'utf8',
  logLevel: 'warning',
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@deepseek-ai/*',
  ],
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
    // The panel reports its version through __DSH_AITERM_CLIENT__; taking it
    // from the manifest keeps it from drifting on every release.
    __DSH_PLUGIN_VERSION__: JSON.stringify(manifest.version),
  },
})

const outputFile = result.outputFiles && result.outputFiles[0]
if (!outputFile) throw new Error('build-client: esbuild produced no output')
const bundle = outputFile.text.endsWith('\n') ? outputFile.text : `${outputFile.text}\n`

// Enforce the module-table rule at build time: only React family requires may
// survive bundling. A Harness client package here would throw at materialization
// time in the browser and blank the slot entry.
const requires = [...bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
const unexpected = [...new Set(requires)].filter((specifier) => !MODULE_TABLE.has(specifier))
if (unexpected.length > 0) {
  throw new Error(`build-client: unexpected external module requires: ${unexpected.join(', ')}. Only the React family may stay external.`)
}

const header = `/**
 * dsh-aiterm — browser half.
 *
 * GENERATED FILE: edit client/** and run \`npm run build\` (scripts/build-client.mjs).
 */
`
const wrapper = `${header}window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${bundle}
    return module.exports;
  },
});
`

await mkdir(dirname(output), { recursive: true })
await writeFile(output, wrapper, 'utf8')

const kilobytes = Math.round(Buffer.byteLength(wrapper) / 1024)
console.log(`build-client: wrote ${output} (${kilobytes} KiB)`)

/**
 * Naming guard for `src/vendorName.js`.
 *
 * The vendor's product name is a property of the DEPLOYMENT, not of this
 * package: every source occurrence is assembled from fragments. This test
 * fails the moment a literal spelling creeps back into the code — comments
 * included. Documentation, the deployment config, and the CLI's own on-disk
 * artifacts are out of scope by design.
 *
 *   node --test test/vendorName.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PASSTHROUGH_TOOL_NAMES } from '../src/tools.js'
import { CLI_BASENAME, CLI_HOME_DIRNAME, CREDENTIAL_REF, PLUGIN_NAME, PROVIDER, SUBAGENT_TOOL_NAME } from '../src/vendorName.js'

/** Assembled here too: a literal in this file would defeat its own guard. */
const NAME = `${'code'}${'chat'}`
const NEEDLE = new RegExp(NAME, 'i')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** The code surface the guard covers: two root entries plus these directories. */
const CODE_DIRS = ['src', 'test', 'scripts']
const CODE_FILES = ['index.js', 'client.js']

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (/\.(?:mjs|js)$/u.test(entry.name)) yield path
  }
}

const codeFiles = () => {
  const files = CODE_FILES
    .map((name) => join(ROOT, name))
    .filter((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
  for (const dir of CODE_DIRS) files.push(...walk(join(ROOT, dir)))
  return files
}

test('the runtime values are the vendor spelling and stay unchanged', () => {
  assert.equal(PROVIDER, NAME)
  assert.equal(CLI_BASENAME, NAME)
  assert.equal(CLI_HOME_DIRNAME, `.${NAME}`)
  assert.equal(CREDENTIAL_REF, `${NAME.toUpperCase()}_API_KEY`)
  assert.equal(PLUGIN_NAME, `subagent-${NAME}`)
  assert.equal(SUBAGENT_TOOL_NAME, `subagent_${NAME}`)
})

test('the delegation tool name is a passthrough name', () => {
  // The forwarded DSH prompt advertises it, so a bare-name call must route
  // instead of being refused as neither a vendor tool nor a DSH one.
  assert.equal(PASSTHROUGH_TOOL_NAMES.has(SUBAGENT_TOOL_NAME), true)
})

test('no code file spells the vendor name', () => {
  const offenders = []
  for (const path of codeFiles()) {
    const text = readFileSync(path, 'utf8')
    if (!NEEDLE.test(text)) continue
    const line = text.split('\n').findIndex((entry) => NEEDLE.test(entry)) + 1
    offenders.push(`${path.slice(ROOT.length + 1)}:${line}`)
  }
  assert.deepEqual(offenders, [])
})

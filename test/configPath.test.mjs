/**
 * Offline tests for portable configuration paths (`src/configPath.js`), plus a
 * guard that no code file may spell the operator's home directory.
 *
 *   node --test test/configPath.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHome, expandConfigPath } from '../src/configPath.js'

test('absolute and plain paths pass through untouched', () => {
  assert.equal(expandConfigPath('/var/log/x.jsonl'), '/var/log/x.jsonl')
  assert.equal(expandConfigPath('relative/path'), 'relative/path')
  assert.equal(expandConfigPath(''), '')
  assert.equal(expandConfigPath(undefined), '')
  assert.equal(expandConfigPath(42), '')
})

test('~ expands to the harness user home', () => {
  assert.equal(expandConfigPath('~'), homedir())
  assert.equal(expandConfigPath('~/logs/a.jsonl'), join(homedir(), 'logs', 'a.jsonl'))
  // A bare "~user" is not a supported spelling: guessing would be worse.
  assert.equal(expandConfigPath('~other/logs'), '~other/logs')
})

test('$DSH_HOME expands to the harness home (env first, then ~/.dsh)', () => {
  const before = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(dshHome(), join(homedir(), '.dsh'))
    assert.equal(expandConfigPath('$DSH_HOME/logs/a.jsonl'), join(homedir(), '.dsh', 'logs', 'a.jsonl'))
    process.env.DSH_HOME = '/srv/dsh'
    assert.equal(dshHome(), '/srv/dsh')
    assert.equal(expandConfigPath('$DSH_HOME'), '/srv/dsh')
    assert.equal(expandConfigPath('$DSH_HOME/logs/a.jsonl'), '/srv/dsh/logs/a.jsonl')
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

test('no code file spells the operator home directory', () => {
  // A row or module that hard-codes /home/<user>/… breaks the moment the
  // package is installed for another user or prefix. Portable spellings (~,
  // $DSH_HOME, package-relative defaults) are the supported answer.
  const HOME = homedir()
  const HERE = dirname(fileURLToPath(import.meta.url))
  const ROOT = join(HERE, '..')

  const walk = function* (dir) {
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

  const files = ['index.js', 'subagent.js', 'client.js']
    .map((name) => join(ROOT, name))
    .filter((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
  for (const dir of ['src', 'test', 'scripts']) files.push(...walk(join(ROOT, dir)))

  const offenders = []
  for (const path of files) {
    if (HOME.length < 2) continue
    const text = readFileSync(path, 'utf8')
    if (text.includes(HOME)) offenders.push(path.slice(ROOT.length + 1))
  }
  assert.deepEqual(offenders, [])
})

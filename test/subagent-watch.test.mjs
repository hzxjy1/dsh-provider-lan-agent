/**
 * Offline tests for the binary availability watch (`src/subagent/watch.js`).
 *
 *   node --test test/subagent-watch.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { binaryPresent, watchBinary } from '../src/subagent/watch.js'

const scratch = () => mkdtempSync(join(tmpdir(), 'lanagent-watch-'))

/** Poll a condition with a bounded wait; the watch itself may be polling. */
async function eventually(check, label) {
  const deadline = Date.now() + 5_000
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('binaryPresent requires an executable file', () => {
  const work = scratch()
  const bin = join(work, 'cli')
  try {
    assert.equal(binaryPresent(bin), false)
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    assert.equal(binaryPresent(bin), false)
    chmodSync(bin, 0o755)
    assert.equal(binaryPresent(bin), true)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('the watch reports the initial state, then appearances and disappearances', async () => {
  const work = scratch()
  const bin = join(work, 'cli')
  const seen = []
  const watcher = watchBinary(bin, (present) => seen.push(present), { pollMs: 50 })
  try {
    assert.deepEqual(seen, [false], 'the initial check is reported immediately')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await eventually(() => seen.includes(true), 'the file to appear')
    rmSync(bin, { force: true })
    await eventually(() => seen[seen.length - 1] === false, 'the file to disappear')
    assert.deepEqual(seen, [false, true, false])
  } finally {
    watcher.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

test('a missing directory still converges through the polling backstop', async () => {
  // fs.watch cannot cover a directory that does not exist yet, and installing
  // the binary may create it.
  const work = scratch()
  const bin = join(work, 'nested', 'cli')
  const seen = []
  const watcher = watchBinary(bin, (present) => seen.push(present), { pollMs: 25 })
  try {
    assert.deepEqual(seen, [false])
    mkdirSync(join(work, 'nested'), { recursive: true })
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await eventually(() => seen.includes(true), 'the file to appear without a directory watch')
  } finally {
    watcher.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

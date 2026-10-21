/**
 * Offline tests for the settings panel's audit feed (`src/auditFeed.js`).
 *
 *   node --test test/auditFeed.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readAuditTail } from '../src/auditFeed.js'

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'lanagent-feed-')), 'audit.jsonl')
const line = (name, extra = {}) => `${JSON.stringify({ time: 1, name, ok: true, ...extra })}\n`

test('an unconfigured path reports disabled rather than an error', () => {
  assert.deepEqual(readAuditTail(''), { enabled: false, file: '', records: [], size: 0 })
})

test('a missing file is the normal empty state', () => {
  const feed = readAuditTail(join(tmpdir(), 'lanagent-feed-absent', 'audit.jsonl'))
  assert.equal(feed.enabled, true)
  assert.deepEqual(feed.records, [])
  assert.equal(feed.error, undefined)
})

test('records come back newest first and are limited', () => {
  const file = tempFile()
  writeFileSync(file, line('bash') + line('read', { dshTool: 'read', durationMs: 12 }) + line('todo_write'))
  const feed = readAuditTail(file, { limit: 2 })
  assert.deepEqual(feed.records.map((r) => r.name), ['todo_write', 'read'])
  assert.equal(feed.records[1].dshTool, 'read')
  assert.equal(feed.records[1].durationMs, 12)
  assert.equal(feed.size > 0, true)
})

test('a truncated tail line is skipped, not fatal', () => {
  const file = tempFile()
  writeFileSync(file, line('bash'))
  appendFileSync(file, '{"name":"half-writ')
  const feed = readAuditTail(file)
  assert.deepEqual(feed.records.map((r) => r.name), ['bash'])
})

test('the reader refuses an implausibly large file', () => {
  const file = tempFile()
  writeFileSync(file, 'x'.repeat(1_048_577))
  const feed = readAuditTail(file)
  assert.deepEqual(feed.records, [])
  assert.match(String(feed.error), /refusing to read/)
})

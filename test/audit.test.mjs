/**
 * Offline tests for the bounded tool audit log (`src/audit.js`).
 *
 *   node --test test/audit.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAuditWriter } from '../src/audit.js'

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'lanagent-audit-')), 'audit.jsonl')

test('writes one JSON line per record', () => {
  const file = tempFile()
  const audit = createAuditWriter(file)
  audit({ name: 'bash', args: { command: 'pwd' }, ok: true })
  audit({ name: 'frobnicate', args: {}, ok: false, detail: 'unsupported tool name' })
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].name, 'bash')
  assert.equal(lines[0].ok, true)
  assert.equal(lines[1].detail, 'unsupported tool name')
  assert.match(lines[0].args, /pwd/)
})

test('keeps the request id and event so request/settled rows can be joined', () => {
  const file = tempFile()
  const audit = createAuditWriter(file)
  audit({ name: 'bash', args: {}, ok: null, requestId: 'req-1', event: 'request' })
  audit({ name: 'bash', args: {}, ok: true, requestId: 'req-1', event: 'settled' })
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => [line.requestId, line.event]), [['req-1', 'request'], ['req-1', 'settled']])
})

test('clips huge arguments instead of accumulating file content', () => {
  const file = tempFile()
  const audit = createAuditWriter(file, { maxArgsChars: 40 })
  audit({ name: 'write_to_file', args: { content: 'x'.repeat(5000) }, ok: true })
  const record = JSON.parse(readFileSync(file, 'utf8').trim())
  assert.ok(record.args.length < 120, `args should be clipped, got ${record.args.length}`)
  assert.match(record.args, /…\[\+\d+\]/)
})

test('truncates in place once the file outgrows its cap', () => {
  const file = tempFile()
  writeFileSync(file, `${'x'.repeat(4000)}\n`)
  const audit = createAuditWriter(file, { maxBytes: 1024 })
  audit({ name: 'bash', args: {}, ok: true })
  const text = readFileSync(file, 'utf8')
  assert.match(text.split('\n')[0], /"truncated":true/)
  assert.ok(statSync(file).size < 2000, 'the file is bounded after truncation')
  assert.equal(text.trim().split('\n').length, 2)
})

test('an unwritable path warns once and never throws into the turn', () => {
  const warnings = []
  const audit = createAuditWriter(join(tmpdir(), 'lanagent-audit-missing-dir', 'nested', 'audit.jsonl'), {
    logger: { warn: (message) => warnings.push(message) },
  })
  assert.doesNotThrow(() => audit({ name: 'bash', args: {}, ok: true }))
  assert.doesNotThrow(() => audit({ name: 'bash', args: {}, ok: true }))
  assert.equal(warnings.length, 1, 'reports once, then stays quiet')
})

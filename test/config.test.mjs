/**
 * Offline checks on the SHIPPED row (`cordis.patch.yml`).
 *
 * The row is what a deployment actually runs, and three of the behaviours fixed
 * in 1.4.0 are only real if the row carries values that agree with the code:
 *
 *   - the loop budget must sit ABOVE the vendor's declared 300000ms, or the
 *     `Math.min` cap preempts the vendor's own deadline (the 240000 bug);
 *   - the approval wait has its own budget, so it cannot stay on the 20s
 *     per-tool deadline;
 *   - the request deadline must leave room for the vendor's measured 282–312s
 *     silent gaps;
 *   - the audit trail must be enabled with an ABSOLUTE path, because the host's
 *     cwd is not stable and an empty value silently disables the writer.
 *
 * A YAML parser is deliberately not a dependency of this package, so the row is
 * read with anchored patterns: these are flat scalars under `llm-lan-agent`, and
 * a pattern that stops matching is itself worth a failing test.
 *
 *   node --test test/config.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/** The last value of a flat scalar key (the row is the only definition point). */
function scalar(key) {
  const matches = [...text.matchAll(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'gm'))]
  assert.ok(matches.length > 0, `cordis.patch.yml has no ${key}`)
  return matches.at(-1)[1]
}

test('shipped row: the loop budget never preempts the vendor declared timeout', () => {
  const budget = Number(scalar('loopBudgetMs'))
  assert.ok(Number.isFinite(budget), 'loopBudgetMs must be a number')
  assert.ok(budget >= 300_000, `loopBudgetMs ${budget} is below the vendor's declared 300000ms`)
})

test('shipped row: the approval wait has its own, longer budget', () => {
  const approval = Number(scalar('approvalTimeoutMs'))
  assert.ok(Number.isFinite(approval), 'approvalTimeoutMs must be a number')
  assert.ok(approval >= 60_000, `an approval wait of ${approval}ms is too short for a human`)
  const tool = Number(scalar('toolTimeoutMs'))
  assert.ok(Number.isFinite(tool), 'toolTimeoutMs must be a number')
  assert.ok(approval > tool, 'the approval wait must not share the per-tool soft deadline')
})

test('shipped row: the request deadline covers the vendor silent gaps', () => {
  const request = Number(scalar('requestTimeoutMs'))
  assert.ok(Number.isFinite(request), 'requestTimeoutMs must be a number')
  assert.ok(request >= 600_000, `requestTimeoutMs ${request} is shorter than the measured 312s gap plus headroom`)
})

test('shipped row: the audit trail is enabled at an absolute JSONL path', () => {
  const file = scalar('toolAuditFile')
  assert.ok(file.startsWith('/'), `toolAuditFile must be absolute, got ${file}`)
  assert.ok(file.endsWith('.jsonl'), `toolAuditFile must be a JSONL file, got ${file}`)
})

test('shipped row: the question tool is reachable through the vendor toolbox', () => {
  assert.match(text, /^\s*- ask_user_question\s*$/m, 'ask_user_question must stay published to the vendor')
})

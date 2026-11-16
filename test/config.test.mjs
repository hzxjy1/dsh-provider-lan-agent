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
 *   - the audit trail must be enabled at a path that EXPANDS to absolute,
 *     because the host's cwd is not stable and an empty value silently disables
 *     the writer (`~` / `$DSH_HOME` are expanded by src/configPath.js);
 *   - the CLI row must carry no machine-specific path: its binaryPath/homeDir
 *     default to the package's own bin/ and home/.
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

import { expandConfigPath } from '../src/configPath.js'
import { SUBAGENT_TOOL_NAME } from '../src/vendorName.js'

const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/**
 * Decode the escapes this row uses inside a double-quoted scalar.
 *
 * The two runtime names are written as \uXXXX escapes so the file never spells
 * the vendor's product name (see src/vendorName.js). A reader that compares the
 * RAW text would see the escape and wrongly report a mismatch, so every
 * comparison below goes through this decoder — which is exactly what a YAML
 * parser does.
 *
 * @param {string} raw the matched scalar, quotes included when double-quoted.
 * @returns {string}
 */
function decodeScalar(raw) {
  const quoted = raw.match(/^"([\s\S]*)"$/)
  if (quoted === null) return raw
  return quoted[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** The last value of a flat scalar key (the row is the only definition point). */
function scalar(key) {
  const matches = [...text.matchAll(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'gm'))]
  assert.ok(matches.length > 0, `cordis.patch.yml has no ${key}`)
  return decodeScalar(matches.at(-1)[1])
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

test('shipped row: the audit trail expands to an absolute JSONL path', () => {
  const file = scalar('toolAuditFile')
  const expanded = expandConfigPath(file)
  assert.ok(expanded.startsWith('/'), `toolAuditFile must expand to an absolute path, got ${expanded}`)
  assert.ok(expanded.endsWith('.jsonl'), `toolAuditFile must be a JSONL file, got ${expanded}`)
})

test('shipped row: the CLI row carries no machine-specific path', () => {
  // binaryPath/homeDir stay omitted on purpose: the defaults are derived from
  // the package's own location, so the row survives a relocated install. A
  // hard-coded home directory is the regression this guards.
  assert.doesNotMatch(text, /^\s*binaryPath:\s/m, 'binaryPath must stay omitted (package-relative default)')
  assert.doesNotMatch(text, /^\s*homeDir:\s/m, 'homeDir must stay omitted (package-relative default)')
  // The ASSEMBLED name, never a literal: the same rule the source follows.
  // The value is compared AFTER unescaping, so the YAML may (and does) carry it
  // as an escape sequence without this test going blind.
  assert.equal(scalar('toolName'), SUBAGENT_TOOL_NAME, 'the delegation tool must stay published under its row')
})

test('shipped row: the question tool is reachable through the vendor toolbox', () => {
  assert.match(text, /^\s*- ask_user_question\s*$/m, 'ask_user_question must stay published to the vendor')
})

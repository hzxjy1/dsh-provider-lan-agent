/**
 * Offline tests for the optional CLI capability's configuration
 * (`src/subagent/config.js`).
 *
 *   node --test test/subagent-config.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveChildCwd, resolveConfig, validateConfiguredCwd } from '../src/subagent/config.js'
import { CLI_BASENAME, PROVIDER } from '../src/vendorName.js'

/** A fictional package directory: the defaults are derived from it. */
const HERE = '/opt/lan-agent-pkg'
const scratch = () => mkdtempSync(join(tmpdir(), 'lanagent-cfg-'))
const drop = (path) => rmSync(path, { recursive: true, force: true })

test('defaults point at the package bin/home and carry the runtime route', () => {
  const config = resolveConfig(undefined, { here: HERE })
  assert.equal(config.provider, PROVIDER)
  assert.equal(config.binaryPath, join(HERE, 'bin', CLI_BASENAME))
  assert.equal(config.homeDir, join(HERE, 'home'))
  assert.equal(config.model, 'deepseek-v4.1-flash')
  assert.equal(config.timeoutMs, 600_000)
  assert.equal(config.graceMs, 5_000)
  assert.equal(config.fullDelegation, true)
  assert.equal(config.maxBudgetUsd, 2)
})

test('a missing binary is NOT a configuration error', () => {
  // The capability must still mount so the watch can report it absent and pick
  // it up the moment the operator installs the file.
  const work = scratch()
  const config = resolveConfig({ binaryPath: join(work, 'absent') }, { here: HERE })
  assert.equal(config.binaryPath, join(work, 'absent'))
  drop(work)
})

test('deployment faults fail at activation', () => {
  assert.throws(() => resolveConfig({ model: '' }, { here: HERE }), /model must be a non-empty string/)
  assert.throws(() => resolveConfig({ binaryPath: '' }, { here: HERE }), /binaryPath must be a non-empty string/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }, { here: HERE }), /timeoutMs must be a positive finite number/)
  assert.throws(() => resolveConfig({ graceMs: -1 }, { here: HERE }), /graceMs must be a positive finite number/)
})

test('a configured cwd is validated once and rejects the empty string', () => {
  const work = scratch()
  assert.equal(validateConfiguredCwd(work), work)
  assert.equal(validateConfiguredCwd(undefined), undefined)
  // The empty string would resolve to the process cwd — the launch-directory
  // fallback this validation exists to remove.
  assert.throws(() => validateConfiguredCwd(''), /must not be empty/)
  assert.throws(() => validateConfiguredCwd(join(work, 'missing')), /not an accessible directory/)
  drop(work)
})

test('child cwd precedence: override, then request, then parent', () => {
  const a = scratch()
  const b = scratch()
  assert.equal(resolveChildCwd(a, b, undefined), a)
  assert.equal(resolveChildCwd(undefined, b, a), b)
  assert.equal(resolveChildCwd(undefined, undefined, a), a)
  // An empty request.cwd is "not supplied", not a cwd: it falls through.
  assert.equal(resolveChildCwd(undefined, '', a), a)
  assert.throws(() => resolveChildCwd(undefined, undefined, undefined), /no working directory for the child/)
  drop(a)
  drop(b)
})

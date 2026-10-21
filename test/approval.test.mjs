/**
 * Offline tests for the vendor approval flag's mapping (`src/approval.js`).
 *
 *   node --test test/approval.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { requestApproval, requiresApproval } from '../src/approval.js'

const agent = { id: 'session-1' }

test('requiresApproval reads only the vendor flag', () => {
  assert.equal(requiresApproval({ command: 'pwd', requires_approval: true }), true)
  assert.equal(requiresApproval({ command: 'pwd', requires_approval: false }), false)
  assert.equal(requiresApproval({ command: 'pwd' }), false)
  assert.equal(requiresApproval('nonsense'), false)
  assert.equal(requiresApproval(undefined), false)
})

test('an allow-once outcome grants, and the request carries the routing facts', async () => {
  const seen = []
  const verdict = await requestApproval({
    approval: { request: async (request) => { seen.push(request); return 'allowed-once' } },
    agent,
    toolName: 'bash',
    callId: 'call-1',
    reason: '厂商请求执行需要审批的命令：rm -rf /tmp/x',
  })
  assert.deepEqual(verdict, { granted: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, agent)
  assert.equal(seen[0].toolName, 'bash')
  assert.equal(seen[0].callId, 'call-1')
  assert.match(seen[0].reason, /rm -rf/)
})

test('a rejection and an unknown outcome deny with distinct, honest reasons', async () => {
  const rejected = await requestApproval({ approval: { request: async () => 'rejected' }, agent, toolName: 'bash' })
  assert.equal(rejected.granted, false)
  assert.match(rejected.reason, /用户拒绝/)
  const other = await requestApproval({ approval: { request: async () => 'unavailable' }, agent, toolName: 'bash' })
  assert.match(other.reason, /unavailable/)
})

test('a missing approval service or an agent-less call degrades to a denial, never a silent allow', async () => {
  const noService = await requestApproval({ approval: undefined, agent, toolName: 'bash' })
  assert.equal(noService.granted, false)
  assert.match(noService.reason, /没有提供审批服务/)
  const noAgent = await requestApproval({ approval: { request: async () => 'allowed-once' }, agent: undefined, toolName: 'bash' })
  assert.equal(noAgent.granted, false)
  assert.match(noAgent.reason, /没有可路由审批的 agent/)
})

test('a throwing approval service denies with the failure text', async () => {
  const verdict = await requestApproval({
    approval: { request: async () => { throw new Error('seam exploded') } },
    agent,
    toolName: 'bash',
  })
  assert.equal(verdict.granted, false)
  assert.match(verdict.reason, /seam exploded/)
})

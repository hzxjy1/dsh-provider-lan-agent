/**
 * The vendor's per-call approval flag, mapped onto DSH's approval seam.
 *
 * `execute_command` carries `requires_approval` — the vendor's own client asks
 * the human before running the command. Our bridge ignored the flag entirely, so
 * the same request behaved differently depending on which execution route ran it:
 * the loop route inherits DSH's `ApprovalPolicy`, the out-of-band route asked
 * nobody. Both routes now go through this one decision, taken *before* the call
 * is executed or parked, so the vendor's model gets an explicit denial instead of
 * a result it should not have had.
 *
 * The seam is consumed with `ctx.get('approval')` (the key `dsh-tools` uses) and
 * degrades to a denial when no approval service is composed or the call has no
 * agent to route through — the same posture as `dsh-tools`.
 *
 * @module src/approval
 */

/**
 * Ask for approval of one vendor request.
 *
 * @param {object} options
 * @param {object|undefined} options.approval the `approval` service, when composed.
 * @param {object|undefined} options.agent the agent the call belongs to.
 * @param {string} options.toolName the DSH tool the call will run as.
 * @param {string} [options.callId]
 * @param {string} options.reason human-readable reason shown to the user.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{granted: boolean, reason?: string}>}
 */
export async function requestApproval({ approval, agent, toolName, callId, reason, signal }) {
  if (approval === undefined || typeof approval.request !== 'function') {
    return { granted: false, reason: '当前部署没有提供审批服务（approval 未挂载），因此不能自动放行需要审批的调用' }
  }
  if (agent === undefined) {
    return { granted: false, reason: '该调用没有可路由审批的 agent' }
  }
  let outcome
  try {
    outcome = await approval.request({
      agent,
      toolName,
      ...callId === undefined ? {} : { callId },
      ...reason === undefined ? {} : { reason },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    return { granted: false, reason: `审批请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (outcome === 'allowed-once') return { granted: true }
  if (outcome === 'rejected') return { granted: false, reason: '用户拒绝了这次调用' }
  return { granted: false, reason: `审批未通过（${String(outcome)}）` }
}

/**
 * Does this vendor request ask for approval?
 *
 * @param {object} input the vendor's argument map.
 * @returns {boolean}
 */
export function requiresApproval(input) {
  return input !== null && typeof input === 'object' && input.requires_approval === true
}

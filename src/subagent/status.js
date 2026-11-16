/**
 * Cross-entry status of the optional vendor CLI binary.
 *
 * The two host entries of this package are separate modules in ONE process:
 * `index.js` serves the model route and the `/lanagent/cli` status route,
 * while `subagent.js` owns the binary watch. The watch writes here and the
 * route reads here — a module-level store, not a service, because the value is
 * a single small record and neither side may assume the other is mounted.
 *
 * `known` is the important field: a deployment that never mounts the subagent
 * entry (row disabled, service missing) must not render a banner claiming the
 * binary is absent, so the banner only speaks when a watch has actually looked.
 *
 * @module src/subagent/status
 */

/** @type {{known: boolean, present: boolean, path: string, checkedAt: number}} */
let state = { known: false, present: false, path: '', checkedAt: 0 }

/**
 * Record the latest observation of the CLI binary.
 *
 * @param {{known?: boolean, present?: boolean, path?: string}} next
 */
export function setCliStatus(next) {
  state = { ...state, ...next, checkedAt: Date.now() }
}

/** @returns {{known: boolean, present: boolean, path: string, checkedAt: number}} */
export function getCliStatus() {
  return { ...state }
}

/**
 * The operator-facing hint for a missing binary.
 *
 * It is deliberately free of any download source: this package never fetches
 * the CLI, and the person who installed the plugin already knows where it came
 * from. The path is the actionable part.
 *
 * @param {string} binaryPath expected absolute location.
 * @returns {string}
 */
export function cliHint(binaryPath) {
  return `缺少 CLI 软件；装了插件的你知道在哪里下载，请把它放到 ${binaryPath}。`
}

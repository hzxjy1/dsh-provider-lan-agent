/**
 * Availability watch for the CLI binary.
 *
 * The capability is offered ONLY while the binary exists, and the operator may
 * install or remove it at any time — so availability cannot be decided once at
 * mount. The directory is watched rather than the file: installing by
 * rename/replace breaks a file-level watch, while a directory watch still sees
 * the `rename` event.
 *
 * `fs.watch` may miss or refuse (the bin directory itself can be absent, and
 * some filesystems drop events). A low-frequency unref'd poll is therefore kept
 * as a backstop: it costs one `access` call every 15s and guarantees the state
 * converges even when the watch is silent.
 *
 * @module src/subagent/watch
 */

import { accessSync, constants as fsConstants, watch } from 'node:fs'
import { basename, dirname } from 'node:path'

/** How often the backstop re-checks when no watch event arrives. */
const POLL_MS = 15_000

/**
 * Whether the configured binary exists and is executable.
 *
 * @param {string} binaryPath
 * @returns {boolean}
 */
export function binaryPresent(binaryPath) {
  try {
    accessSync(binaryPath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Observe the binary's presence, reporting the current value immediately.
 *
 * @param {string} binaryPath absolute path of the CLI executable.
 * @param {(present: boolean) => void} onChange called on the initial check and
 *   on every observed transition; never called for an unchanged value.
 * @param {{logger?: {warn?: Function, debug?: Function}, pollMs?: number}} [options]
 *   `pollMs` exists so tests need not wait 15s for the backstop.
 * @returns {{dispose: () => void, present: () => boolean}}
 */
export function watchBinary(binaryPath, onChange, { logger, pollMs = POLL_MS } = {}) {
  let present = binaryPresent(binaryPath)

  const report = (next, reason) => {
    if (next === present) return
    present = next
    logger?.debug?.( `binary ${next ? 'appeared' : 'disappeared'} (${reason}): ${binaryPath}`)
    onChange(next)
  }
  const check = (reason) => report(binaryPresent(binaryPath), reason)

  onChange(present)

  let watcher
  try {
    watcher = watch(dirname(binaryPath), { persistent: false }, (_event, filename) => {
      // A null filename means "something in this directory": re-check anyway.
      if (filename !== null && String(filename) !== basename(binaryPath)) return
      check('watch')
    })
    watcher.on?.('error', (error) => {
      logger?.warn?.( `cannot watch ${dirname(binaryPath)}: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch (error) {
    logger?.warn?.( `cannot watch ${dirname(binaryPath)}: ${error instanceof Error ? error.message : String(error)}; falling back to polling`)
  }

  const timer = setInterval(() => check('poll'), pollMs)
  timer.unref?.()

  return {
    present: () => present,
    dispose() {
      clearInterval(timer)
      try {
        watcher?.close()
      } catch {
        /* an already-closed watcher is not an error */
      }
    },
  }
}

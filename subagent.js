/**
 * Host entry: the optional vendor CLI subagent capability.
 *
 * WHY IT LIVES HERE
 * -----------------
 * This CLI belongs to the same vendor as the `lanagent` route: one deployment,
 * one account, one credential store. Keeping it in the same package means the
 * capability ships with the vendor glue it needs (auth seeding, the process
 * seam, the P1 naming rule) instead of a second package that has to be kept in
 * step with it.
 *
 * IT IS OPTIONAL, AND IT SAYS SO
 * ------------------------------
 * The CLI binary is supplied by the operator and is NOT distributed with this
 * package. When it is absent the row still mounts — it has to, in order to
 * watch for the file and report status — but no provider is registered, so the
 * model-facing delegation tool never appears and the vendor toolbox never
 * declares it. A settings banner names the expected path; nothing here ever
 * fetches or downloads the binary.
 *
 * @module @local/dsh-provider-lan-agent/subagent
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUGIN_NAME, PROVIDER } from './src/vendorName.js'
import { resolveConfig } from './src/subagent/config.js'
import { makeProvider } from './src/subagent/provider.js'
import { cliHint, setCliStatus } from './src/subagent/status.js'
import { watchBinary } from './src/subagent/watch.js'

/** Stable Cordis plugin name (assembled: see src/vendorName.js). */
export const name = PLUGIN_NAME

/** The subagent registry and the process seam are both required to serve a run. */
export const inject = ['subagents', 'subprocess']

/** This package's own directory, for the default binary and isolated home. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Mount the capability and keep its availability in step with the file.
 *
 * `registerProvider` returns its own Cordis effect disposer, so withdrawal is
 * exact: the provider disappears, the tool row unmounts the delegation tool,
 * and the next turn's toolbox declaration no longer carries it.
 *
 * @param {object} ctx plugin context.
 * @param {object} [rawConfig] the row's `config`.
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? console
  const config = resolveConfig(rawConfig, { here: HERE })

  /** @type {(() => void)|undefined} */
  let stopProvider
  const register = () => {
    if (stopProvider !== undefined) return
    stopProvider = ctx.subagents.registerProvider(makeProvider(ctx, config))
    logger.info?.(`${PLUGIN_NAME}: provider "${PROVIDER}" is live (CLI binary present)`)
  }
  const unregister = () => {
    if (stopProvider === undefined) return
    stopProvider()
    stopProvider = undefined
    logger.warn?.(`${PLUGIN_NAME}: provider "${PROVIDER}" withdrawn — CLI binary is missing`)
  }

  ctx.effect(() => {
    const watcher = watchBinary(config.binaryPath, (present) => {
      setCliStatus({ known: true, present, path: config.binaryPath })
      if (present) register()
      else {
        unregister()
        logger.warn?.(cliHint(config.binaryPath))
      }
    }, { logger })
    return () => {
      unregister()
      watcher.dispose()
    }
  }, `${PLUGIN_NAME}: CLI binary availability`)
}

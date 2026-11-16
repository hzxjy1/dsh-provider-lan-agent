/**
 * Configuration for the optional vendor CLI subagent capability.
 *
 * A missing binary is a SUPPORTED state, not a configuration error: the row
 * still mounts (it must, to run the watch and report status), the provider is
 * simply not registered, and the capability stays invisible to every agent.
 * Only genuine deployment faults — an empty model, a non-numeric budget, an
 * unusable cwd — fail at activation.
 *
 * The two cwd helpers are local copies. `@deepseek-ai/dsh-subagent` exported
 * them up to 0.2.0-rc.2 and dropped them from the public barrel in 0.2.1-rc.2;
 * they are implemented here exactly as upstream did so the pinned CLI contract
 * keeps working across the upgrade.
 *
 * @module src/subagent/config
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { expandConfigPath } from '../configPath.js'
import { deploymentValue } from '../deployment.js'
import { CLI_BASENAME, CLI_HOME_DIRNAME, CREDENTIAL_REF, PLUGIN_NAME, PROVIDER } from '../vendorName.js'

const PREFIX = PLUGIN_NAME

/**
 * Default origin for the CLI: the LAN service.
 *
 * The vendor's own host name resolves to this exact address, so the source
 * uses the address and never the name. Deployments on another network
 * override it (`serverUrl`, `LAN_AGENT_SERVER_URL`, or the deployment file).
 */
const DEFAULT_SERVER_URL = 'http://10.219.9.56'

/**
 * Prefer an explicit row value, then the deployment's out-of-band value.
 *
 * The package ships NEITHER an origin NOR an account: both name one
 * deployment's network and staff. A deployment supplies them through
 * `src/deployment.js` (environment or `$DSH_HOME/lan-agent.deployment.json`),
 * so the source stays free of them and the CLI still gets a usable config.
 *
 * @param {object} config raw row config.
 * @param {'serverUrl'|'username'} key
 * @returns {string}
 */
function deploymentOr(config, key) {
  const value = config[key]
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return deploymentValue(key)
}

/**
 * Assert a configured timing bound is a positive finite number.
 *
 * Inlined with {@link assertUsableCwd} on purpose: this module then imports NO
 * bare specifier, so `node --test` works straight from the package directory,
 * which has no module anchor. The provider and runner still reach the real
 * seams; only configuration is decoupled from them.
 *
 * @param {string} prefix
 * @param {string} name
 * @param {number} value
 */
function assertPositiveFinite(prefix, name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${prefix}: ${name} must be a positive finite number`)
}

/**
 * Whether a path names an existing directory the process can ENTER.
 *
 * The search-permission probe matters: `statSync().isDirectory()` is true for
 * a mode-600 directory, but a subprocess cwd needs `X_OK` or spawn fails EACCES.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isEnterableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Assert a cwd can actually host the child.
 *
 * @param {string} prefix
 * @param {string} label
 * @param {string} cwd
 * @returns {string}
 */
function assertUsableCwd(prefix, label, cwd) {
  if (!isAbsolute(cwd)) throw new Error(`${prefix}: ${label} must be an absolute path: ${cwd}`)
  if (!isEnterableDirectory(cwd)) throw new Error(`${prefix}: ${label} is not an accessible directory: ${cwd}`)
  return cwd
}

/**
 * Validate a configured `cwd` override ONCE, at plugin load.
 *
 * The empty string is rejected on purpose: `path.resolve('')` is the process
 * cwd, which would silently reintroduce the launch-directory fallback this
 * resolution exists to remove.
 *
 * @param {string|undefined} cwd the configured override.
 * @returns {string|undefined} the validated absolute override.
 */
export function validateConfiguredCwd(cwd) {
  if (cwd === undefined) return undefined
  if (cwd === '') throw new Error(`${PREFIX}: config cwd must not be empty — omit the key to inherit the parent session cwd`)
  return assertUsableCwd(PREFIX, 'config cwd', resolve(cwd))
}

/**
 * Resolve the child's working directory at start.
 *
 * Order: the deployment override, then the request's own cwd (the service
 * resolves it before calling a provider, so it is authoritative), then the
 * parent agent's recorded cwd for callers that start a provider directly.
 * Failing loud beats binding the child to the harness launch directory, which
 * one server process would share across sessions with different workspaces.
 *
 * @param {string|undefined} configured load-validated override.
 * @param {string|undefined} requested `request.cwd`.
 * @param {string|undefined} parentCwd `request.parent.meta.cwd`.
 * @returns {string} absolute child working directory.
 */
export function resolveChildCwd(configured, requested, parentCwd) {
  if (configured !== undefined) return configured
  const candidate = typeof requested === 'string' && requested.length > 0 ? requested : parentCwd
  if (candidate === undefined) throw new Error(`${PREFIX}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`)
  return assertUsableCwd(PREFIX, 'parent session cwd', candidate)
}

/**
 * Read and normalize the row's config. Fails loud at activation on a fault that
 * no later state can repair; a missing binary is NOT one of them.
 *
 * @param {object|undefined} raw the row's `config`.
 * @param {{here: string}} options the package directory, for the defaults.
 * @returns {object} the resolved configuration.
 */
export function resolveConfig(raw, { here }) {
  const config = raw ?? {}
  // Package-relative defaults on purpose: the row must not have to name a
  // machine-specific path, and a relocated install keeps working. An explicit
  // value may use `~` or `$DSH_HOME` (see src/configPath.js).
  const binaryPath = config.binaryPath === undefined
    ? join(here, 'bin', CLI_BASENAME)
    : expandConfigPath(config.binaryPath)
  const homeDir = config.homeDir === undefined ? join(here, 'home') : expandConfigPath(config.homeDir)
  const model = config.model ?? 'deepseek-v4.1-flash'
  const timeoutMs = config.timeoutMs ?? 600_000
  const graceMs = config.graceMs ?? 5_000
  const maxBudgetUsd = config.maxBudgetUsd ?? 2
  const configuredCwd = validateConfiguredCwd(config.cwd === undefined ? undefined : expandConfigPath(config.cwd))
  assertPositiveFinite(PREFIX, 'timeoutMs', timeoutMs)
  assertPositiveFinite(PREFIX, 'graceMs', graceMs)
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new Error(`${PREFIX}: binaryPath must be a non-empty string`)
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`${PREFIX}: model must be a non-empty string (the backend never answers without one)`)
  }
  return {
    provider: PROVIDER,
    binaryPath,
    homeDir,
    homeDirname: CLI_HOME_DIRNAME,
    model,
    timeoutMs,
    graceMs,
    maxBudgetUsd,
    configuredCwd,
    mode: config.mode ?? 'action',
    envName: config.envName ?? 'prod',
    fullDelegation: config.fullDelegation !== false,
    permissionMode: config.permissionMode ?? 'acceptEdits',
    allowedTools: Array.isArray(config.allowedTools) ? config.allowedTools : undefined,
    serverUrl: deploymentOr(config, 'serverUrl') || DEFAULT_SERVER_URL,
    authBasePath: config.authBasePath ?? '/common-api',
    username: deploymentOr(config, 'username'),
    tokenFile: config.tokenFile === undefined ? undefined : expandConfigPath(config.tokenFile),
    credentialsRef: config.credentialsRef ?? CREDENTIAL_REF,
  }
}

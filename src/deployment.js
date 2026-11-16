/**
 * Deployment-supplied connection settings.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The origin, the account, and the token path identify ONE deployment's
 * network and staff. Baking them into the package would publish that
 * deployment's topology to everyone who reads (or unpacks) the source, so the
 * source carries none of them. A deployment supplies them out of band:
 *
 *   - the environment (highest priority):
 *       LAN_AGENT_BASE_URL, LAN_AGENT_SERVER_URL,
 *       LAN_AGENT_USERNAME, LAN_AGENT_TOKEN_FILE
 *   - `$DSH_HOME/lan-agent.deployment.json`:
 *       { "baseURL": "...", "serverUrl": "...", "username": "...", "tokenFile": "..." }
 *
 * Both spellings are machine state, never source. The file lives in the
 * deployment's DSH home (outside this package, gitignored there), and the
 * environment belongs to one process, so neither can be redistributed with
 * the code by accident.
 *
 * A missing value is NOT a mount failure: the settings surface must still
 * render, and the miss is reported when the value is actually used.
 *
 * @module src/deployment
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { dshHome } from './configPath.js'

/** File name inside the deployment's DSH home. */
export const DEPLOYMENT_FILE_NAME = 'lan-agent.deployment.json'

/** Environment variable that overrides each key. */
const ENV_BY_KEY = Object.freeze({
  baseURL: 'LAN_AGENT_BASE_URL',
  serverUrl: 'LAN_AGENT_SERVER_URL',
  username: 'LAN_AGENT_USERNAME',
  tokenFile: 'LAN_AGENT_TOKEN_FILE',
})

/** Parsed file cache, invalidated by mtime (config hot-reload re-reads it). */
let cached

/**
 * Absolute path of the deployment file for this process.
 *
 * @returns {string}
 */
export function deploymentFilePath() {
  return join(dshHome(), DEPLOYMENT_FILE_NAME)
}

/**
 * Read and cache the deployment file. Any failure (missing, unreadable, not
 * JSON) is an empty object: absence is a supported state.
 *
 * @returns {Record<string, unknown>}
 */
function readDeploymentFile() {
  const path = deploymentFilePath()
  try {
    const stat = statSync(path)
    if (cached !== undefined && cached.path === path && cached.mtimeMs === stat.mtimeMs) return cached.data
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    cached = { path, mtimeMs: stat.mtimeMs, data }
    return data
  } catch {
    cached = undefined
    return {}
  }
}

/**
 * Resolve one deployment value.
 *
 * Priority: environment, then the deployment file, then `''`. Values are
 * trimmed; a blank value counts as absent at both layers.
 *
 * @param {'baseURL'|'serverUrl'|'username'|'tokenFile'} key
 * @param {Record<string, string|undefined>} [env] process environment (tests).
 * @returns {string}
 */
export function deploymentValue(key, env = process.env) {
  const envName = ENV_BY_KEY[key]
  const fromEnv = envName === undefined ? undefined : env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const fromFile = readDeploymentFile()[key]
  if (typeof fromFile === 'string' && fromFile.trim().length > 0) return fromFile.trim()
  return ''
}

/**
 * Expand the portable spellings a deployment may use in a path-valued
 * configuration field.
 *
 * A row must not have to spell a machine-specific home directory: a value like
 * `/home/<user>/...` breaks the moment the package is installed for another
 * user, another prefix, or in a container. Two spellings are therefore
 * understood:
 *
 *   - `~`            the harness user's home directory
 *   - `$DSH_HOME`    the harness home (the `DSH_HOME` environment variable
 *                     when set, else `~/.dsh`)
 *
 * Everything else — including every absolute path — passes through untouched,
 * so existing rows keep working unchanged.
 *
 * @module src/configPath
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Expand `~` and `$DSH_HOME` in a configured path.
 *
 * @param {unknown} value the configured value.
 * @returns {string} the expanded path; an empty or non-string value yields `''`.
 */
export function expandConfigPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return ''
  const home = homedir()
  if (text === '~') return home
  if (text.startsWith('~/')) return join(home, text.slice(2))
  const harness = dshHome()
  if (text === '$DSH_HOME') return harness
  if (text.startsWith('$DSH_HOME/')) return join(harness, text.slice('$DSH_HOME/'.length))
  return text
}

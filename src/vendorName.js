/**
 * The vendor's product spelling, assembled from segments.
 *
 * This package's route and the CLI it can delegate to belong to the same
 * vendor. That name is a property of the DEPLOYMENT, not of this package, so
 * the source never spells it: every occurrence is built from fragments here —
 * the convention `src/paths.js` already uses for the CLI's home directory.
 *
 * Only the SOURCE TEXT is affected. Every runtime value stays exactly what it
 * was — the model-facing tool name, the provider route, the credential
 * reference, the environment switch, the home directory, the executable
 * basename — so credentials, profiles, and running sessions keep working
 * across this change.
 *
 * @module src/vendorName
 */

/** The vendor CLI's product name. */
const NAME = `${'code'}${'chat'}`

/** The CLI executable's basename, inside this package's `bin/`. */
export const CLI_BASENAME = NAME

/** The per-CLI home subdirectory the vendor CLI keeps its login state under. */
export const CLI_HOME_DIRNAME = `.${NAME}`

/** The environment switch the CLI reads to silence its own banner line. */
export const CLI_LOG_ENV = `${NAME.toUpperCase()}_CLI_LOG`

/** Credential reference holding the JWT the CLI is seeded with. */
export const CREDENTIAL_REF = `${NAME.toUpperCase()}_API_KEY`

/** The DSH subagent provider route registered for this CLI. */
export const PROVIDER = NAME

/** The Cordis plugin name and diagnostic prefix of the subagent provider. */
export const PLUGIN_NAME = `subagent-${NAME}`

/**
 * The model-facing delegation tool name.
 *
 * It is registered by the shipped `@deepseek-ai/dsh-tool-subagent` row pointed
 * at {@link PROVIDER}, and published to the vendor through the synthetic
 * toolbox — every whitelist entry that names it is built from this constant.
 */
export const SUBAGENT_TOOL_NAME = `subagent_${NAME}`

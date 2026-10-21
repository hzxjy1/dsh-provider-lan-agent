/**
 * Model catalog for the lanagent route.
 *
 * Source of truth for WHICH models exist is the vendor's own group listing
 * (`GET /chatbot/v3/model_groups`, no authentication required). Source of truth
 * for their CAPABILITIES is `GET /chatbot/v3/models`, whose 25 definitions are
 * not 1:1 with the six selectable groups — the groups carry only a `group`
 * name, while the definitions are keyed by `model_id`/`name` (for example the
 * `deepseek-v4.1-flash` group resolves server-side to
 * `_deepseek-v4.1-flash-volc200k`, whose `name` is `deepseek-v4-1-flash-260910`).
 * Matching groups to definitions by string identity is therefore unreliable, so
 * capabilities come from the static table below, whose values were read from
 * `/chatbot/v3/models` (design notes §2) and confirmed live by `token_usage`
 * (`used_tokens 16271 / max_token 204800` = 8%).
 *
 * The listing is fetched, cached, and falls back to the static group list when
 * the endpoint is unreachable: a provider route that cannot be selected at all
 * is worse than one advertising a slightly stale catalog.
 *
 * @module src/catalog
 */

/** Models advertised when the catalog endpoint is unreachable. */
export const FALLBACK_GROUP_IDS = [
  'glm-5.3',
  'glm-5.3-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'qwen-3.8-flash',
  'qwen-3.7-flash',
]

/**
 * Capabilities per selectable group.
 *
 * `max_tokens` is 16384 for every definition the vendor publishes, so output
 * stays capped there; `max_token` (the context window) is 204800 for the
 * 200K variants the groups resolve to.
 */
export const MODEL_METADATA = Object.freeze(Object.fromEntries(
  FALLBACK_GROUP_IDS.map((id) => [id, Object.freeze({ contextWindow: 204800, maxTokens: 16384 })]),
))

const DEFAULT_METADATA = Object.freeze({ contextWindow: 204800, maxTokens: 16384 })

/** The six groups are text-only here: the request body has no image field. */
export const INPUT_MODALITIES = Object.freeze(['text'])

/** Turn one vendor group row into the entry shape this adapter advertises. */
function entryFor(groupId, label) {
  const meta = MODEL_METADATA[groupId] ?? DEFAULT_METADATA
  return {
    id: groupId,
    name: typeof label === 'string' && label.length > 0 ? label : groupId,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    inputModalities: INPUT_MODALITIES,
  }
}

/** Cached, self-refreshing view of the vendor's selectable models. */
export class LanAgentCatalog {
  /**
   * @param {object} options
   * @param {string} options.baseURL
   * @param {number} [options.ttlMs]
   * @param {Function} [options.fetchImpl] injectable for tests.
   * @param {{info?: Function, warn?: Function, debug?: Function}} [options.logger]
   */
  constructor({ baseURL, ttlMs = 21_600_000, fetchImpl = fetch, logger }) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.ttlMs = ttlMs
    this.fetchImpl = fetchImpl
    this.logger = logger
    /** @type {{at: number, models: object[]}|undefined} */
    this.cache = undefined
    /** @type {Promise<object[]>|undefined} */
    this.inflight = undefined
    this.warnedOnce = false
  }

  /** Forget the cached catalog. */
  invalidate() {
    this.cache = undefined
  }

  /**
   * Advertised models, in the vendor's own order.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object[]>}
   */
  async list(signal) {
    const now = Date.now()
    if (this.cache !== undefined && now - this.cache.at < this.ttlMs) return this.cache.models
    this.inflight ??= this.#fetch(signal).finally(() => { this.inflight = undefined })
    return await this.inflight
  }

  /**
   * Metadata for one exact model id, whether or not it is in the catalog.
   *
   * @param {string} id
   * @returns {Promise<object>}
   */
  async resolve(id) {
    const models = await this.list()
    return models.find((model) => model.id === id) ?? entryFor(id, id)
  }

  /** Fetch the group listing, degrading to the static list on any failure. */
  async #fetch(signal) {
    try {
      const response = await this.fetchImpl(`${this.baseURL}/chatbot/v3/model_groups`, {
        method: 'GET',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const rows = Array.isArray(body?.data) ? body.data : []
      const models = rows
        .map((row) => (typeof row?.group === 'string' && row.group.length > 0 ? entryFor(row.group, row.name) : undefined))
        .filter((model) => model !== undefined)
      if (models.length === 0) throw new Error('empty model_groups payload')
      this.cache = { at: Date.now(), models }
      this.warnedOnce = false
      return models
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (!this.warnedOnce) {
        this.warnedOnce = true
        this.logger?.warn?.(
          `lanagent: model catalog unavailable (${error instanceof Error ? error.message : String(error)}); using the built-in list`,
        )
      }
      const models = FALLBACK_GROUP_IDS.map((id) => entryFor(id, id))
      // Cache the fallback briefly: a short TTL recovers quickly once the
      // endpoint answers again, while the long TTL keeps steady-state cheap.
      this.cache = { at: Date.now() - Math.max(0, this.ttlMs - 300_000), models }
      return models
    }
  }
}

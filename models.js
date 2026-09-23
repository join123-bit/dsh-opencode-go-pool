/**
 * Model-catalog helpers for the OpenCode Go pool.
 *
 * The shipped pi-ai catalog (`@earendil-works/pi-ai/providers/opencode-go`)
 * is a static snapshot: suppliers add models faster than the package
 * releases, so the card exposes a "拉取模型 / fetch models" action that pulls
 * the authoritative list from the official models endpoint:
 *
 *   GET <baseUrl>            (default https://opencode.ai/zen/go/v1/models)
 *   Authorization: Bearer <apiKey>   (optional — the endpoint is public)
 *
 * Response (OpenAI-compatible, undocumented for Go):
 *   { "object": "list", "data": [ { "id": "deepseek-v4-pro", "object": "model",
 *                                   "created": 1787845562, "owned_by": "opencode" } ] }
 *
 * The endpoint returns only ids (no per-model protocol/endpoint metadata), so
 * a fetched model that is not yet in the shipped catalog is synthesized as a
 * best-effort descriptor defaulting to the `openai-completions` protocol at
 * `/v1` — the dominant protocol in the Go catalog. Known models are routed by
 * the shipped catalog and are never overridden here.
 *
 * @module dsh-opencode-go-pool/models
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Coded failure for one models query; `code` is a stable machine key. */
export class ModelsError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const DEFAULT_API = 'openai-completions'
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'
const DEFAULT_CONTEXT_WINDOW = 1000000
const DEFAULT_MAX_TOKENS = 131072

/**
 * Models the OpenCode Go gateway serves as genuinely multimodal even though
 * nothing in the catalog says so.
 *
 * The shipped pi-ai catalog is a snapshot, and the official models endpoint
 * returns ids only — neither carries modalities for a model that arrived after
 * the snapshot. `dynamicModelDescriptor()` therefore declares `input: ['text']`
 * for every fetched model, and DSH trusts that declaration twice:
 *
 *   - `dsh-api-session-controller` refuses to attach an image at all
 *     ("Model ... does not support image input", MODEL_DOES_NOT_SUPPORT_IMAGES)
 *     because `resolveModel().inputModalities` omits `image`;
 *   - `dsh-llm-pi-ai`'s stream() throws UNSUPPORTED_CONTENT when an image
 *     reaches a descriptor whose `input` lacks `image`, and `dsh-llm` silently
 *     projects such images into a placeholder text instead.
 *
 * `deepseek-v4.1-flash` and `deepseek-flash` are both catalog-unknown (dynamic)
 * models that DO accept `image_url` content parts upstream and genuinely read
 * them: probed 2026-09-23 against https://opencode.ai/zen/go/v1/chat/completions
 * with a rendered image ("K7Q-3391" plus a blue square and a red circle), both
 * returned the exact text and both shapes. The same probe shows why this list
 * must stay evidence-based rather than optimistic:
 *
 *   - `deepseek-v4-flash`, `glm-5.3`  → HTTP 400, "Model only supports text input"
 *   - `deepseek-v4-pro`              → accepts the image, then answers
 *                                      "I can't view the image" (silent ignore)
 *   - `mimo-v2.5-pro`                → 404, model is not served at all
 *
 * Declaring a text-only model here does not fail fast: the image is admitted,
 * stored in the session, and the model answers as if no image existed — the
 * worst possible failure mode. Add an id only after verifying it upstream.
 */
export const DEFAULT_VISION_MODELS = Object.freeze(['deepseek-v4.1-flash', 'deepseek-flash'])

/**
 * Normalize a configured vision-model list: strings only, trimmed, non-empty,
 * de-duplicated, order preserved. Anything else is dropped rather than
 * throwing — a bad settings document must not take the route down.
 * @param {unknown} ids
 * @returns {string[]}
 */
export function normalizeVisionModels(ids) {
  if (!Array.isArray(ids)) return []
  const out = []
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (trimmed.length === 0 || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * Declare `image` input on exactly the models named by `visionModels`, leaving
 * every other descriptor — and every other field of the matching ones —
 * untouched. Returns the input array unchanged when nothing matched, so an
 * unconfigured route keeps object identity and no needless rebuild.
 *
 * This is the single lever that turns image input on for a model: the
 * descriptor's `input` is what `listModels()` reports as `inputModalities`
 * (attachment admission) and what `stream()` checks before inlining images.
 * @param {Array<object>} models - pi-ai model descriptors.
 * @param {Iterable<string>|string[]} visionModels - ids to declare image-capable.
 * @returns {Array<object>} the same array, or a copy with `input` widened.
 */
export function withVisionInput(models, visionModels) {
  const ids = visionModels instanceof Set ? visionModels : new Set(normalizeVisionModels(visionModels))
  if (ids.size === 0) return models
  let changed = false
  const out = models.map(model => {
    if (!model || typeof model.id !== 'string' || !ids.has(model.id)) return model
    const input = Array.isArray(model.input) ? model.input : ['text']
    if (input.includes('image')) return model
    changed = true
    return { ...model, input: [...input, 'image'] }
  })
  return changed ? out : models
}

/** Best-effort display name from a kebab-case id: "deepseek-v4-pro" → "Deepseek V4 Pro". */
export function titleCaseId(id) {
  if (typeof id !== 'string' || id.length === 0) return id
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

/**
 * Query the models endpoint once.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} [options.apiKey] - optional; sent as Bearer when present.
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] - injectable fetch for tests.
 * @returns {Promise<Array<{id: string, name: string}>>}
 * @throws {ModelsError} with codes: network | unauthorized | http-<status> | bad-json
 */
export async function fetchModels({ baseUrl, apiKey, timeoutMs = 15000, fetchImpl }) {
  const impl = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  let res
  try {
    res = await impl(baseUrl, { headers, signal: controller.signal })
  } catch {
    throw new ModelsError('network', `models request failed: ${baseUrl}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) {
    throw new ModelsError('unauthorized', 'models endpoint rejected the key (401)')
  }
  if (!res.ok) {
    throw new ModelsError(`http-${res.status}`, `models endpoint answered HTTP ${res.status}`)
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new ModelsError('bad-json', 'models endpoint answered with non-JSON')
  }
  const raw = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : [])
  const models = []
  for (const item of raw) {
    if (typeof item === 'string') {
      models.push({ id: item, name: titleCaseId(item) })
      continue
    }
    if (item && typeof item === 'object' && typeof item.id === 'string') {
      models.push({
        id: item.id,
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : titleCaseId(item.id),
      })
    }
  }
  return models
}

/**
 * Synthesize a routable pi-ai model descriptor for a fetched model that the
 * shipped catalog does not yet know. The protocol/endpoint/reasoning shape
 * are best-effort defaults mirroring the dominant Go catalog family
 * (DeepSeek-style openai-completions): the same reasoning levels as
 * deepseek-v4-pro (off/high/max), so the thinking-strength control behaves
 * like the shipped models. Models the shipped catalog already knows are
 * never synthesized.
 * @param {string} id
 * @param {string} [name]
 * @param {string} route - provider route id (e.g. opencode-go).
 */
export function dynamicModelDescriptor(id, name, route) {
  return {
    id,
    name: name || titleCaseId(id),
    provider: route,
    api: DEFAULT_API,
    baseUrl: DEFAULT_BASE_URL,
    input: ['text'],
    // Supplier-new models have no published per-token pricing. Cost them at
    // zero instead of omitting `cost`: the pi-ai usage pipeline calls
    // calculateCost() on every completed stream, and it iterates
    // `model.cost.tiers` — a descriptor without a cost block crashes the
    // whole round with "Cannot read properties of undefined (reading 'tiers')"
    // (PI_AI_ERROR). Regression: test/models.test.mjs.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Mirror deepseek-v4-pro: getSupportedThinkingLevels() yields
    // [off, high, max], and the deepseek thinking format serializes
    // thinking + reasoning_effort on the wire.
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  }
}

/**
 * Load persisted fetched-model pairs from a JSON cache file.
 * @param {string} path
 * @returns {Array<{id: string, name: string}>} empty on any failure.
 */
export function loadDynamicModels(path) {
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .filter(entry => entry && typeof entry.id === 'string')
      .map(entry => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id }))
  } catch {
    return []
  }
}

/**
 * Persist fetched-model pairs to a JSON cache file (best-effort atomic write).
 * @param {string} path
 * @param {Array<{id: string, name: string}>} entries
 */
export function saveDynamicModels(path, entries) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entries, null, 2))
    renameSync(tmp, path)
  } catch {
    // Persistence is best-effort: losing the fetched cache only costs a re-fetch.
  }
}
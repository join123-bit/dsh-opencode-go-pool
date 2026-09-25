#!/usr/bin/env node
/**
 * dsh-opencode-go-pool — upgrade smoke test.
 *
 * Run it AFTER upgrading DSH (or its profile bundles), BEFORE trusting the
 * pool plugin: it verifies every module-level integration point the plugin
 * imports still exists and behaves in the current runtime.
 *
 * Usage (run from inside the DSH profile so @deepseek-ai packages resolve):
 *
 *   cd "$DSH_HOME/profiles/web" && node node_modules/dsh-opencode-go-pool/smoke.mjs
 *
 * or against a local checkout installed in the profile:
 *
 *   cd "$DSH_HOME/profiles/web" && node /path/to/dsh-opencode-go-pool/smoke.mjs
 *
 * Exit code: 0 = all probes passed; 1 = an integration point moved (read the
 * FAIL lines and check the DSH changelog). This script is intentionally
 * dependency-light and synchronous — it can run in any Node ≥ 20.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { probeCoreImports, Config, buildProfile } from './index.js'
import { dynamicModelDescriptor } from './models.js'

const require = createRequire(import.meta.url)
const failures = []
const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail })
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

/** Version of a dependency, tolerant of packages whose exports hides ./package.json. */
function packageVersion(pkg) {
  let entry = null
  try {
    entry = require.resolve(pkg)
  } catch {
    // ESM-first packages reject CJS resolution (ERR_PACKAGE_PATH_NOT_EXPORTED);
    // resolve through the import condition instead.
    if (typeof import.meta.resolve === 'function') {
      try {
        entry = import.meta.resolve(pkg).replace(/^file:\/\//, '')
      } catch {
        entry = null
      }
    }
  }
  if (!entry) return undefined
  let dir = dirname(entry)
  for (;;) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      const json = JSON.parse(readFileSync(file, 'utf8'))
      if (json.name === pkg) return json.version
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// 1. Runtime & dependency versions (record these in the compatibility matrix).
check('node runtime ≥ 20', Number(process.versions.node.split('.')[0]) >= 20, process.version)
const VERSION_PACKAGES = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/schemastery',
  '@earendil-works/pi-ai',
]
for (const pkg of VERSION_PACKAGES) {
  const version = packageVersion(pkg)
  check(pkg, version !== undefined, version ?? 'package not found from this location — run from inside the DSH profile')
}

// 2. Module-level integration probe (imports + shapes + constructor contract).
const issues = probeCoreImports()
check('probeCoreImports()', issues.length === 0, issues.join('; '))

// 3. Config schema still validates the documented shape via the Standard
//    Schema interface (~standard), which stays stable across schemastery
//    generations (parse/check names have already moved once).
try {
  const validator = Config && Config['~standard'] && Config['~standard'].validate
  if (typeof validator !== 'function') {
    check('Config schema validates', false, 'no ~standard.validate on the schema')
  } else {
    const result = validator({
      route: 'opencode-go',
      keys: [],
      preemptAtPercent: 100,
      switchAfterConsecutiveFailures: 0,
      modelMode: 'all',
      models: [],
      usageBaseUrl: 'https://opencode.ai/zen/go/v1/usage',
      modelsBaseUrl: 'https://opencode.ai/zen/go/v1/models',
      usageRefreshMs: 30000,
      timeoutMs: 15000,
    })
    const schemaIssues = result && Array.isArray(result.issues) ? result.issues : []
    check('Config schema validates', schemaIssues.length === 0, schemaIssues.map(item => item.message ?? String(item)).join('; '))
  }
} catch (error) {
  check('Config schema validates', false, String((error && error.message) || error))
}

// 4. Runtime profile contract: buildProfile() hand-declares the profile object
//    llm-pi-ai's PiAiAdapter reads. Fields that class dereferences without a
//    fallback are integration points exactly like an import is — and they are
//    invisible to the checks above. llm-pi-ai 0.1.5-rc.1 reads
//    `profile.modelErrors.get(model)` in modelOf(), so a profile that omits the
//    map makes every resolveModel() throw "Cannot read properties of undefined
//    (reading 'get')": listModels() keeps working, so the provider still lists
//    while the model picker reports it as failed to load. Build a profile with
//    the shipped shape and drive both reads through a real adapter.
const SHIPPED_PROFILE_FIELDS = {
  provider: 'opencode-go',
  displayName: 'OpenCode Zen Go（池）',
  streamIdleTimeoutMs: 300000,
  headers: {},
  configuredMaxTokens: new Map(),
  modelErrors: new Map(),
  modelCapabilities: new Map(),
}

try {
  // The route's own first catalog model is the picker's representative resolve.
  const catalog = opencodeGoProvider().getModels()
  const sampleModel = catalog[0] && catalog[0].id
  if (sampleModel === undefined) {
    check('profile contract: resolveModel()', false, 'shipped catalog is empty')
  } else {
    const upstream = opencodeGoProvider()
    if (upstream.id !== 'opencode-go') upstream.id = 'opencode-go'
    const profile = { ...SHIPPED_PROFILE_FIELDS, piProvider: { ...upstream, getModels: () => upstream.getModels() } }
    const adapter = new PiAiAdapter({
      profiles: () => new Map([['opencode-go', profile]]),
      resolveApiKey: async () => { throw new Error('smoke: keys are never resolved here') },
      resolveAttachments: () => undefined,
    })
    await adapter.resolveModel('opencode-go', sampleModel)
    check('profile contract: resolveModel()', true, sampleModel)
  }
} catch (error) {
  check('profile contract: resolveModel()', false, `${String((error && error.message) || error)} — buildProfile() is missing a field this llm-pi-ai dereferences`)
}

// 5. Image-input contract (v0.1.16). The descriptor's `input` is the single
//    lever for vision: listModels() reports it as inputModalities (attachment
//    admission in the session controller) and the adapter re-checks it before
//    inlining an image. Drive the real buildProfile() with a vision id and with
//    a text-only catalog model, and require the modality to land on exactly one
//    of them.
try {
  const route = 'opencode-go'
  const VISION_ID = 'deepseek-v4.1-flash'
  const TEXT_ID = 'deepseek-v4-flash'
  const profile = buildProfile(
    route,
    r => [dynamicModelDescriptor(VISION_ID, 'DeepSeek V4.1 Flash', r)],
    {},
    [VISION_ID],
  )
  const adapter = new PiAiAdapter({
    profiles: () => new Map([[route, profile]]),
    resolveApiKey: async () => { throw new Error('smoke: keys are never resolved here') },
    resolveAttachments: () => undefined,
  })
  const models = await adapter.listModels(route)
  const vision = models.find(model => model.id === VISION_ID)
  const text = models.find(model => model.id === TEXT_ID)
  check('vision: dynamic model reports image input', Boolean(vision && vision.inputModalities.includes('image')),
    vision ? `${VISION_ID} → ${vision.inputModalities.join('+')}` : `${VISION_ID} missing from the catalog`)
  const resolved = await adapter.resolveModel(route, VISION_ID)
  check('vision: resolveModel() carries the image modality', resolved.inputModalities.includes('image'),
    resolved.inputModalities.join('+'))
  check('vision: text-only catalog model stays text-only', Boolean(text && !text.inputModalities.includes('image')),
    text ? `${TEXT_ID} → ${text.inputModalities.join('+')}` : `${TEXT_ID} missing from the catalog`)
  // Declaring the modality is only half the contract: the adapter hands the
  // profile's image-request policy straight to the attachment store, whose
  // first act is to validate maxPixels/maxBytes as positive safe integers.
  // v0.1.16 shipped the modality without this policy, and every image request
  // died with "Image request maxPixels must be a positive integer." — invisible
  // to the modality checks above, because it fires only on the image path.
  const policy = [profile.maxRequestImageBytes, profile.requestImagePixelBudget, profile.requestImageMaxBytes]
  check('vision: profile carries a positive image request policy',
    policy.every(value => Number.isSafeInteger(value) && value > 0),
    policy.join(' / '))
} catch (error) {
  check('vision: image-input contract', false, String((error && error.message) || error))
}

// 6. Typert manifest contract (v0.1.17). The typert-loader validates the
//    hand-written ./typert manifest BEFORE the plugin body runs, so item 2's
//    probe can never see a drift here — a stale strict-codec shape fails the
//    whole activation with «strict codec has no create() factory», not a
//    dormant plugin. Since dsh-typert-protocol 0.1.6 the loader requires every
//    strict codec (every parameter and result) to expose a `create()` factory
//    returning a schema with parse(); assert that shape on the shipped
//    manifest and exercise the zod primitive codecs through a created codec.
try {
  const { TYPERT } = await import('./typert.host.js')
  const entries = []
  for (const invocation of TYPERT.invocations ?? []) {
    entries.push({ at: `${invocation.id} result`, codec: invocation.result })
    for (const parameter of invocation.parameters ?? []) {
      entries.push({ at: `${invocation.id} param ${parameter.wire}`, codec: parameter.codec })
    }
  }
  check('typert: manifest declares invocations', entries.length > 0, String(entries.length))
  const strictShape = entries.filter(({ codec }) => codec && codec.mode === 'strict' && typeof codec.typeSymbol === 'string')
  check('typert: every codec is strict with typeSymbol', strictShape.length === entries.length,
    `${strictShape.length}/${entries.length}`)
  const withFactory = entries.filter(({ codec }) => typeof codec.create === 'function')
  check('typert: strict codecs expose create()', withFactory.length === entries.length,
    `${withFactory.length}/${entries.length}`)
  const unusable = []
  for (const { at, codec } of entries) {
    const created = codec.create()
    if (typeof created?.parse !== 'function') {
      unusable.push(`${at}: create() did not return a schema with parse()`)
      continue
    }
    if (codec.typeSymbol === 'boolean' || codec.typeSymbol === 'string') {
      try {
        created.parse(codec.typeSymbol === 'boolean' ? true : 'x')
      } catch (error) {
        unusable.push(`${at}: ${String((error && error.message) || error)}`)
      }
    }
  }
  check('typert: created codecs are parseable schemas', unusable.length === 0, unusable.join('; '))
} catch (error) {
  check('typert: manifest contract', false, String((error && error.message) || error))
}

// 7. Client remote codec contract (v0.1.18). The settings card mounts its
//    remote with hand-written descriptors in client.js, and the CLIENT
//    registry (dsh-typert-registry/lib/client.js validateCodec) enforces the
//    same create() rule on strict codecs at ctx.remote.$mount() time —
//    «typert: <endpoint> result strict codec has no create() factory» fails
//    the card with 加载失败 even when the host loader accepts the manifest.
//    client.js is browser code (React) and cannot be imported here, so guard
//    its source shape: the strict() helper and every descriptor codec must go
//    through it, and it must carry create().
try {
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const hasFactory = source.includes('create: passthrough')
  const usesHelper = source.includes('codec: strict()')
  const noInlineOldShape = !/codec: \{ mode: 'strict'[^}]*schema: passthrough\(\) \}/.test(source)
  check('client: strict codecs declare create()', hasFactory && usesHelper && noInlineOldShape,
    `factory=${hasFactory} helper=${usesHelper} inlineOld=${!noInlineOldShape}`)
} catch (error) {
  check('client: strict codecs declare create()', false, String((error && error.message) || error))
}

for (const { label, ok, detail } of checks) {
  if (ok) console.log(`PASS  ${label}${detail ? `  →  ${detail}` : ''}`)
  else console.log(`FAIL  ${label}${detail ? `  →  ${detail}` : ''}`)
}

console.log()
if (failures.length > 0) {
  console.error(`smoke FAILED — ${failures.length} integration point(s) moved.`)
  console.error('The plugin will start DORMANT on this DSH (no crashes, no takeover);')
  console.error('status().takeoverHint shows exactly what moved.')
  console.error('Next steps: check the DSH changelog and adapt, or roll back the DSH version.')
  process.exitCode = 1
} else {
  console.log('smoke PASSED — all module-level integration points present; the plugin may serve the route.')
}
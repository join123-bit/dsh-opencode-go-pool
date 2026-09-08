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
import { probeCoreImports, Config } from './index.js'

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
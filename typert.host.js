// Hand-written Typert host manifest for the opencodePool Remote.
// The typert-loader imports this via package.json exports["./typert"] and
// registers it into ctx.typert.local, which the Host gateway uses to claim
// and dispatch the "opencodePool/*" endpoints in strict mode.
//
// IMPORTANT: the typert-loader REQUIRES strict result codecs on EVERY
// invocation (src-json is rejected at manifest validation, which fails the
// whole plugin activation). Every result below is therefore a zod v4 schema;
// the business payload (status) is strict-validated before it crosses the
// wire, and the simple mutation results ride as strict booleans/strings.
//
// Since dsh-typert-protocol 0.1.6 (deepseek-harness «perf(typert): materialize
// generated schemas on first use») a strict codec must expose a `create()`
// factory that materializes the boundary schema on first use instead of
// carrying a pre-built `schema`; the loader rejects a strict codec without
// `create` at activation («strict codec has no create() factory»). The
// `strict()` helper below emits BOTH shapes: `schema` for pre-0.1.6 loaders
// (DSH 0.1.2-rc era) and `create()` for 0.1.6+ (desktop nightly builds).

import { z } from 'zod'

const windowSchema = z.object({
  status: z.string().nullable(),
  percent: z.number().nullable(),
  resetsAt: z.string().nullable(),
})

const usageSchema = z.object({
  rolling: windowSchema.nullable(),
  weekly: windowSchema.nullable(),
  monthly: windowSchema.nullable(),
})

const lastFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  at: z.string(),
})

const keyStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string(),
  state: z.string(),
  active: z.boolean(),
  usage: usageSchema.nullable(),
  usageError: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  credentialSet: z.boolean(),
  lastFailure: lastFailureSchema.nullable(),
})

const lastSwitchSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string(),
  at: z.string(),
})

const refreshModelsResultSchema = z.object({
  count: z.number(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })),
  added: z.array(z.string()),
  fetchedAt: z.string(),
})

const poolStatusSchema = z.object({
  takeover: z.string(),
  route: z.string(),
  usageRefreshMs: z.number(),
  preemptAtPercent: z.number(),
  switchAfterConsecutiveFailures: z.number(),
  modelMode: z.string(),
  availableModels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    dynamic: z.boolean(),
  })),
  activeId: z.string().nullable(),
  lastSwitch: lastSwitchSchema.nullable(),
  takeoverHint: z.string().nullable(),
  keys: z.array(keyStatusSchema),
})

const keyInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string(),
})

const strict = (typeSymbol, schema) => ({
  mode: 'strict',
  typeSymbol,
  // pre-0.1.6 shape — read by DSH 0.1.2-rc era loaders (dsh-typert-protocol ^0.1.0-rc.5).
  schema,
  // dsh-typert-protocol >= 0.1.6 contract — the desktop loader requires this
  // factory (materialize the schema on first boundary use). A zod v4 schema is
  // already a live object whose parse() satisfies TypertSchema, so returning it
  // directly is the whole factory.
  create: () => schema,
})

const invocation = (method, parameters, result) => ({
  id: `dsh-opencode-go-pool#opencodePool/${method}`,
  service: 'opencodePool',
  namespace: 'opencodePool',
  method,
  invocation: { kind: 'direct' },
  parameters: parameters.map(({ name, wire, typeSymbol, schema }) => ({
    name, wire, source: 'json', codec: strict(typeSymbol, schema),
  })),
  result,
})

export const TYPERT = {
  package: 'dsh-opencode-go-pool',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', [], strict('dsh-opencode-go-pool#PoolStatus', poolStatusSchema)),
    invocation('setActive', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('setDisabled', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
      { name: 'on', wire: 'on', typeSymbol: 'boolean', schema: z.boolean() },
    ], strict('boolean', z.boolean())),
    invocation('clearInvalid', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('putKeys', [
      { name: 'keys', wire: 'keys', typeSymbol: 'dsh-opencode-go-pool#KeyInputList', schema: z.array(keyInputSchema) },
    ], strict('boolean', z.boolean())),
    invocation('putConfig', [
      { name: 'config', wire: 'config', typeSymbol: 'dsh-opencode-go-pool#PoolConfigPatch', schema: z.object({
        preemptAtPercent: z.number().optional(),
        switchAfterConsecutiveFailures: z.number().optional(),
        modelMode: z.string().optional(),
        models: z.array(z.string()).optional(),
      }) },
    ], strict('boolean', z.boolean())),
    invocation('putKeySecret', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
      { name: 'secret', wire: 'secret', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('takeOverState', [], strict('string', z.string())),
    invocation('refreshModels', [], strict('dsh-opencode-go-pool#RefreshModelsResult', refreshModelsResultSchema)),
  ],
  model: { services: [], events: [], objects: [] },
}

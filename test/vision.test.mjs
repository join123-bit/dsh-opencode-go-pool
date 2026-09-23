/**
 * Image-input declaration tests (v0.1.16).
 *
 * The whole vision feature is one field — a pi-ai model descriptor's `input`
 * array — so these tests pin the two properties that matter:
 *   1. only the ids the operator declared gain `image`, nothing else moves;
 *   2. nothing changes at all when the list is empty or the model already
 *      declares image (so the route keeps object identity and no rebuild).
 *
 * Pure module: `models.js` imports only node:fs/node:path, so this file runs
 * with plain `node --test` anywhere, no DSH packages required.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VISION_MODELS,
  dynamicModelDescriptor,
  normalizeVisionModels,
  withVisionInput,
} from '../models.js'

test('DEFAULT_VISION_MODELS ships the upstream-verified dynamic ids', () => {
  assert.ok(DEFAULT_VISION_MODELS.includes('deepseek-v4.1-flash'))
  assert.ok(DEFAULT_VISION_MODELS.includes('deepseek-flash'))
  // Evidence-based list: a model verified to *ignore* images upstream
  // (deepseek-v4-pro accepts image_url, then answers "I can't view the image")
  // must never be declared here.
  assert.ok(!DEFAULT_VISION_MODELS.includes('deepseek-v4-pro'))
  assert.ok(!DEFAULT_VISION_MODELS.includes('deepseek-v4-flash'))
})

test('normalizeVisionModels trims, drops junk, de-duplicates, keeps order', () => {
  assert.deepEqual(normalizeVisionModels([' a ', 'b', 'a', '', 7, null, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeVisionModels([]), [])
  assert.deepEqual(normalizeVisionModels(undefined), [])
  assert.deepEqual(normalizeVisionModels('deepseek-v4.1-flash'), [])
})

test('withVisionInput widens only the named models, leaving every other field alone', () => {
  const models = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', input: ['text'], contextWindow: 1000000 },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', input: ['text'] },
    { id: 'kimi-k3', name: 'Kimi K3', input: ['text', 'image'] },
  ]
  const out = withVisionInput(models, ['deepseek-v4.1-flash'])
  assert.deepEqual(out[0].input, ['text', 'image'])
  assert.deepEqual(out[1].input, ['text'])
  assert.deepEqual(out[2].input, ['text', 'image'])
  assert.equal(out[0].name, 'DeepSeek V4.1 Flash')
  assert.equal(out[0].contextWindow, 1000000)
  // The untouched descriptors keep their identity (no needless copies).
  assert.equal(out[1], models[1])
  assert.equal(out[2], models[2])
})

test('withVisionInput is identity when nothing matches or the model already claims image', () => {
  const models = [{ id: 'a', input: ['text'] }, { id: 'b', input: ['text', 'image'] }]
  assert.equal(withVisionInput(models, []), models)
  assert.equal(withVisionInput(models, ['nope']), models)
  assert.equal(withVisionInput(models, ['b']), models)
})

test('withVisionInput accepts a Set and tolerates a descriptor with no input array', () => {
  const out = withVisionInput([{ id: 'a' }], new Set(['a']))
  assert.deepEqual(out[0].input, ['text', 'image'])
})

test('a dynamic deepseek-v4.1-flash descriptor is text-only until declared', () => {
  const descriptor = dynamicModelDescriptor('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'opencode-go')
  assert.deepEqual(descriptor.input, ['text'])
  const [vision] = withVisionInput([descriptor], DEFAULT_VISION_MODELS)
  assert.deepEqual(vision.input, ['text', 'image'])
  // Declaring image input must not disturb the routing/reasoning shape.
  assert.equal(vision.api, descriptor.api)
  assert.equal(vision.baseUrl, descriptor.baseUrl)
  assert.deepEqual(vision.compat, descriptor.compat)
  assert.deepEqual(vision.cost, descriptor.cost)
})

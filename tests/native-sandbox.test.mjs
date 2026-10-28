import test from 'node:test'
import assert from 'node:assert/strict'
import { runNativeSmoke } from '../scripts/smoke-native.mjs'

const enabled = process.env.DSH_NATIVE_SANDBOX_TEST === '1' && process.platform === 'win32'
test('explicit real native sandbox integration verifies R02 and preserves source/goal boundaries', {
  skip: enabled ? false : 'Opt in on the configured Windows host with DSH_NATIVE_SANDBOX_TEST=1.',
  timeout: 180_000,
}, async () => {
  const result = await runNativeSmoke()
  assert.equal(result.passed, true, JSON.stringify({ error: result.error, verification: result.verification, resultFile: result.resultFile }))
  assert.equal(result.modelRequests, 0)
  assert.equal(result.verification.check.outcome, 'verified')
  assert.equal(result.sourceChangedApplicability.currentSource, false)
  assert.equal(result.revisedApplicability.currentGoal, false)
  assert.match(result.boundaryExecution.stdout, /OUTSIDE_DENIED=/)
  assert.equal(result.privateTempRemoved, true)
})

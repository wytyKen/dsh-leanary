import test from 'node:test'
import assert from 'node:assert/strict'
import { runLocalProjectSmoke } from '../scripts/smoke-local-project.mjs'

const enabled = process.env.DSH_NATIVE_SANDBOX_TEST === '1' && process.platform === 'win32'
test('explicit native local-project integration tracks imports, goal history, and every source snapshot', {
  skip: enabled ? false : 'Opt in on the configured Windows host with DSH_NATIVE_SANDBOX_TEST=1.',
  timeout: 180_000,
}, async () => {
  const result = await runLocalProjectSmoke()
  assert.equal(result.passed, true, JSON.stringify({ error: result.error, verification: result.verification, resultFile: result.resultFile }))
  assert.equal(result.modelRequests, 0)
  assert.equal(result.flattenedInputUsed, false)
  assert.equal(result.copiedOldBuildProducts, false)
  assert.equal(result.verification.check.outcome, 'verified')
  assert.deepEqual(result.verification.check.sourceFiles.map(source => source.path).sort(), ['Congruence.lean', 'ModEq.lean', 'Positive.lean'])
  assert.equal(result.verification.applicability.currentDependencies, true)
  assert.equal(result.dependencyChangedApplicability.currentSource, true)
  assert.equal(result.dependencyChangedApplicability.currentDependencies, false)
  assert.equal(result.dependencyChangedApplicability.currentMaterials, true)
  assert.equal(result.dependencyChangedApplicability.applicableToRecordedInputs, false)
  assert.equal(result.revisedApplicability.currentGoal, false)
  assert.equal(result.revisedApplicability.currentDependencies, true)
  assert.equal(result.revisedApplicability.check.outcome, 'verified')
  assert.equal(result.snapshotChangedApplicability.snapshotIntact, false)
  assert.equal(result.snapshotChangedApplicability.currentDependencies, true)
  assert.deepEqual(result.restoredSourceHashes, result.sourceHashes)
  assert.equal(result.disposed, true)
})

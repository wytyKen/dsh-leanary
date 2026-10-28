// Explicit no-model integration for local Lean imports. Inputs are preserved
// copies from the first Web trial; all mutations stay in a fresh test workspace.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../dist/index.js'
import { bindHostCall } from '../dist/host/adapters.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(project, 'experiments/prototype/fixtures/local-project')
const sources = ['Positive.lean', 'ModEq.lean', 'Congruence.lean']
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const formalType = '∀ (a b : Int), 0 < b → ModArith.ExistsUnique (fun r => 0 ≤ r ∧ r < b ∧ ModArith.ModEq b a r)'

export async function runLocalProjectSmoke() {
  if (process.env.DSH_NATIVE_SANDBOX_TEST !== '1') throw new Error('Set DSH_NATIVE_SANDBOX_TEST=1 to enable this real sandbox smoke.')
  if (process.platform !== 'win32') throw new Error('This smoke targets the installed Windows native sandbox.')
  const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
  const workspaces = path.join(project, 'experiments/research-workflows/.cache/workspaces')
  await fs.mkdir(workspaces, { recursive: true })
  const workspace = await fs.mkdtemp(path.join(workspaces, 'prototype-project-'))
  const realTemp = process.env.DSH_SMOKE_TEMP || 'D:\\CodeTools\\dsh-data\\math-dev\\tmp'
  await fs.access(realTemp)
  const leanCommand = process.env.DSH_SMOKE_LEAN || path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.22.0/bin/lean.exe')
  await fs.access(leanCommand) // Never trigger a toolchain download.
  const originals = new Map()
  for (const source of sources) {
    const content = await fs.readFile(path.join(fixture, source))
    originals.set(source, content)
    await fs.writeFile(path.join(workspace, source), content)
  }
  await fs.writeFile(path.join(workspace, 'problem.md'), 'For integers a,b with 0 < b, establish the unique representative r in [0,b) with ModEq b a r.\n')
  await fs.writeFile(path.join(workspace, 'lean-toolchain'), 'leanprover/lean4:v4.22.0\n')
  assert.deepEqual((await fs.readdir(workspace)).sort(), [...sources, 'problem.md', 'lean-toolchain'].sort())
  const oldTemp = process.env.TEMP, oldTmp = process.env.TMP
  process.env.TEMP = realTemp; process.env.TMP = realTemp
  const policy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'local-project-smoke-' + crypto.randomUUID() }
  const ctx = new Context()
  const result = {
    schemaVersion: 1, startedAt: new Date().toISOString(), workspace, fixture, realTemp, leanCommand,
    sourceHashes: Object.fromEntries(sources.map(source => [source, hash(originals.get(source))])),
    policy, calls: [], passed: false, modelRequests: 0, credentialFilesRead: 0, profileChanges: false,
    copiedInputs: [...sources, 'problem.md', 'lean-toolchain'], copiedOldBuildProducts: false, flattenedInputUsed: false,
    fixtureBoundary: 'Preserved first-Web-trial Lean sources. This agentless test starts no user Session, reads no credentials, and never writes the original demo.',
    nativeProvider: '@deepseek-ai/dsh-sandbox-local', nativeProviderInternalsOverridden: false,
  }
  try {
    ctx.provide('workingDirectory', { get: () => workspace })
    ctx.provide('sandboxPolicy', { defaultMode: policy.mode, resolve: () => policy })
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandboxProvider, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
    await ctx.plugin(plugin, { leanCommand, timeoutMs: 60_000 })
    let sequence = 0
    const invoke = async (name, args) => {
      const value = await ctx.tools.execute({ callId: `local-project-smoke-${++sequence}`, name, arguments: args, signal: new AbortController().signal })
      result.calls.push({ name, arguments: args, result: value })
      assert.equal(value.isError, false, JSON.stringify(value))
      return value.value ?? JSON.parse(value.content.map(block => block.text ?? '').join('\n'))
    }
    // Dependency files deliberately are not manually registered as materials:
    // their discovery and staleness must come from the import-aware verifier.
    const created = await invoke('math_task', {
      action: 'create', request: 'Continue the existing local integer-congruence project.',
      goal: 'For 0 < b, establish the unique representative of every integer congruence class in [0,b).',
      assumptions: ['a b : Int', '0 < b'], materials: ['problem.md', 'lean-toolchain'],
    })
    const taskId = created.task.id
    const claimed = await invoke('math_task', {
      action: 'claim', task_id: taskId, revision: 1,
      statement: 'For every integer a and positive b, there is exactly one r in [0,b) congruent to a modulo b.',
      role: 'target', formal_type: formalType, conditions: ['0 < b', 'ModArith.ModEq b a r means b divides r - a'],
    })
    const claimId = claimed.task.claims[0].id
    const checked = await invoke('math_verify', {
      task_id: taskId, claim_id: claimId, source_path: 'Congruence.lean', declaration: 'ModArith.existsUnique_representative',
    })
    result.verification = checked
    assert.equal(checked.check.outcome, 'verified', JSON.stringify(checked))
    assert.equal(checked.check.sourcePath, 'Congruence.lean')
    assert.equal(checked.check.expectedType, formalType)
    assert.equal(checked.check.semanticCorrespondence, 'not_automatically_certified')
    assert.deepEqual(checked.check.sourceFiles.map(source => source.path).sort(), [...sources].sort())
    for (const source of checked.check.sourceFiles) assert.equal(source.sha256, result.sourceHashes[source.path])
    assert.ok(checked.check.commands.length >= 5)
    assert.ok(checked.check.commands.every(command => command.exitCode === 0))
    assert.equal(checked.applicability.currentDependencies, true)
    assert.equal(checked.applicability.snapshotIntact, true)
    assert.equal(checked.applicability.applicableToRecordedInputs, true)
    const receiptId = checked.check.id
    const binding = await bindHostCall(ctx, { signal: new AbortController().signal })
    const dependency = await binding.io.read('Positive.lean')
    await binding.io.write('Positive.lean', dependency.content + '\n-- Dependency content changed after verification.\n', dependency.version)
    const changed = await invoke('math_task', { action: 'read', task_id: taskId })
    result.dependencyChangedApplicability = changed.checks[0]
    assert.equal(changed.checks[0].currentSource, true)
    assert.equal(changed.checks[0].currentDependencies, false)
    assert.equal(changed.checks[0].currentMaterials, true)
    assert.equal(changed.checks[0].currentGoal, true)
    assert.equal(changed.checks[0].snapshotIntact, true)
    assert.equal(changed.checks[0].applicableToRecordedInputs, false)
    assert.equal(hash(await fs.readFile(path.join(workspace, 'Congruence.lean'))), result.sourceHashes['Congruence.lean'])
    const changedDependency = await binding.io.read('Positive.lean')
    await binding.io.write('Positive.lean', dependency.content, changedDependency.version)
    const revised = await invoke('math_task', {
      action: 'revise', task_id: taskId, expected_revision: 1, request: 'Investigate a changed divisor range.',
      goal: 'Explore standard representatives without assuming a positive divisor.', assumptions: ['a b : Int'],
      materials: ['problem.md', 'lean-toolchain'], reason: 'Controlled goal change after restoring the unchanged verified project.',
    })
    result.revisedApplicability = revised.checks[0]
    assert.equal(revised.task.currentRevision, 2)
    assert.equal(revised.task.checks.length, 1)
    assert.equal(revised.task.checks[0].id, receiptId)
    assert.equal(revised.task.checks[0].outcome, 'verified')
    assert.equal(revised.task.checks[0].expectedType, formalType)
    assert.equal(revised.checks[0].currentSource, true)
    assert.equal(revised.checks[0].currentDependencies, true)
    assert.equal(revised.checks[0].currentGoal, false)
    assert.equal(revised.checks[0].snapshotIntact, true)
    assert.equal(revised.checks[0].applicableToRecordedInputs, false)
    const dependencySnapshot = checked.check.sourceFiles.find(source => source.path === 'Positive.lean')
    const archived = await binding.io.read(dependencySnapshot.snapshot)
    await binding.io.write(dependencySnapshot.snapshot, archived.content + '\n-- Controlled archived dependency tampering.\n', archived.version)
    const tampered = await invoke('math_task', { action: 'read', task_id: taskId })
    result.snapshotChangedApplicability = tampered.checks[0]
    assert.equal(tampered.checks[0].check.outcome, 'verified')
    assert.equal(tampered.checks[0].currentSource, true)
    assert.equal(tampered.checks[0].currentDependencies, true)
    assert.equal(tampered.checks[0].snapshotIntact, false)
    assert.equal(tampered.checks[0].applicableToRecordedInputs, false)
    result.restoredSourceHashes = Object.fromEntries(await Promise.all(sources.map(async source => [source, hash(await fs.readFile(path.join(workspace, source)))])))
    assert.deepEqual(result.restoredSourceHashes, result.sourceHashes)
    result.passed = true
  } catch (error) {
    result.error = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    try { await ctx.fiber.dispose(); result.disposed = true } catch (error) { result.disposeError = error.message; result.passed = false }
    if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp
    if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp
    result.endedAt = new Date().toISOString()
    result.coverage = 'Real native host and LocalSandboxProvider directly compile a three-source local import graph. Dependency edits, a later goal, and a changed dependency snapshot invalidate applicability without erasing the original verified declaration.'
    result.boundary = 'This small local core-only project does not validate arbitrary Lake/Mathlib layouts, complete external dependency archival, remote execution, model interaction, or read/network isolation. Outside-write enforcement is covered by the separate original native smoke.'
    result.nativeStandingGrantNote = 'Only the original provider performs ordinary grants in the newly created workspace. The provider is disposed normally. Test workspaces and evidence are retained; no existing directory is removed.'
    result.resultFile = path.join(workspace, 'smoke-result.json')
    await fs.writeFile(result.resultFile, JSON.stringify(result, null, 2) + '\n')
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.DSH_NATIVE_SANDBOX_TEST !== '1') {
    console.log('Not run. Set DSH_NATIVE_SANDBOX_TEST=1 to opt into the real Windows local-project sandbox smoke.')
  } else {
    const result = await runLocalProjectSmoke()
    console.log(JSON.stringify({ passed: result.passed, resultFile: result.resultFile, workspace: result.workspace, error: result.error ?? null,
      verification: result.verification?.check.outcome ?? null, localSources: result.verification?.check.sourceFiles?.map(source => source.path) ?? null,
      dependencyChanged: result.dependencyChangedApplicability?.currentDependencies ?? null, disposed: result.disposed ?? false }, null, 2))
    process.exitCode = result.passed ? 0 : 1
  }
}

// Explicitly enabled, no-model integration smoke. All durable test files live in
// a fresh prototype-* workspace. The native provider owns normal sandbox grants.
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
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const quote = text => "'" + text.replaceAll("'", "''") + "'"

export async function runNativeSmoke() {
  if (process.env.DSH_NATIVE_SANDBOX_TEST !== '1') throw new Error('Set DSH_NATIVE_SANDBOX_TEST=1 to enable this real sandbox smoke.')
  if (process.platform !== 'win32') throw new Error('This smoke targets the installed Windows native sandbox.')
  const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
  const workspaces = path.join(project, 'experiments/research-workflows/.cache/workspaces')
  await fs.mkdir(workspaces, { recursive: true })
  const workspace = await fs.mkdtemp(path.join(workspaces, 'prototype-native-'))
  const outside = workspace + '-outside'
  await fs.mkdir(outside)
  const outsideFile = path.join(outside, 'must-not-exist.txt')
  const realTemp = process.env.DSH_SMOKE_TEMP || 'D:\\CodeTools\\dsh-data\\math-dev\\tmp'
  await fs.access(realTemp)
  const leanCommand = process.env.DSH_SMOKE_LEAN || path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.22.0/bin/lean.exe')
  await fs.access(leanCommand) // never ask elan to download a missing toolchain
  const originalSource = await fs.readFile(path.join(project, 'experiments/research-workflows/reviews/model-artifacts/R02.lean'))
  await fs.writeFile(path.join(workspace, 'R02.lean'), originalSource)
  await fs.writeFile(path.join(workspace, 'material.md'), 'For integers a,b with 0 < b, establish 0 ≤ a % b and a % b < b.\n')
  await fs.writeFile(path.join(workspace, 'lean-toolchain'), 'leanprover/lean4:v4.22.0\n')
  const oldTemp = process.env.TEMP, oldTmp = process.env.TMP
  process.env.TEMP = realTemp; process.env.TMP = realTemp
  const diagnosticId = 'native-smoke-' + crypto.randomUUID()
  const policy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: diagnosticId }
  const ctx = new Context()
  const result = {
    schemaVersion: 1, startedAt: new Date().toISOString(), workspace, outside, realTemp, leanCommand,
    sourceOriginalSha256: hash(originalSource), policy, calls: [], passed: false,
    modelRequests: 0, credentialFilesRead: 0, profileChanges: false,
    fixture: 'Offline agentless calls with an explicit diagnostic policy/session identity; no persisted user Session.',
    nativeProvider: '@deepseek-ai/dsh-sandbox-local', nativeProviderInternalsOverridden: false,
  }
  let privateTemp
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
      const value = await ctx.tools.execute({ callId: `native-smoke-${++sequence}`, name, arguments: args, signal: new AbortController().signal })
      result.calls.push({ name, arguments: args, result: value })
      assert.equal(value.isError, false, JSON.stringify(value))
      return value.value ?? JSON.parse(value.content.map(block => block.text ?? '').join('\n'))
    }
    const created = await invoke('math_task', { action: 'create', request: 'Continue the existing remainder draft.', goal: 'For Int a b with 0 < b, prove 0 ≤ a % b ∧ a % b < b.', assumptions: ['a b : Int', '0 < b'], materials: ['material.md'] })
    const taskId = created.task.id
    const claimed = await invoke('math_task', {
      action: 'claim', task_id: taskId, revision: 1, statement: 'Positive integer divisors give the stated remainder range.', role: 'target',
      formal_type: '∀ (a b : Int), 0 < b → 0 ≤ a % b ∧ a % b < b', conditions: ['0 < b'],
    })
    const claimId = claimed.task.claims[0].id
    const checked = await invoke('math_verify', { task_id: taskId, claim_id: claimId, source_path: 'R02.lean', declaration: 'remainder_range' })
    result.verification = checked
    assert.equal(checked.check.outcome, 'verified', JSON.stringify(checked))
    assert.ok(checked.check.commands.length >= 3)
    assert.ok(checked.check.commands.every(command => command.exitCode === 0))
    assert.equal(checked.check.semanticCorrespondence, 'not_automatically_certified')
    assert.equal(checked.applicability.applicableToRecordedInputs, true)
    const receiptId = checked.check.id
    const binding = await bindHostCall(ctx, { signal: new AbortController().signal })
    const before = await binding.io.read('R02.lean')
    await binding.io.write('R02.lean', before.content + '\n-- Changed after the verified receipt.\n', before.version)
    const changed = await invoke('math_task', { action: 'read', task_id: taskId })
    result.sourceChangedApplicability = changed.checks[0]
    assert.equal(changed.checks[0].currentSource, false)
    assert.equal(changed.checks[0].currentGoal, true)
    assert.equal(changed.checks[0].applicableToRecordedInputs, false)
    const changedSource = await binding.io.read('R02.lean')
    await binding.io.write('R02.lean', before.content, changedSource.version)
    const revised = await invoke('math_task', { action: 'revise', task_id: taskId, expected_revision: 1, request: 'Consider a changed divisor assumption.', goal: 'Investigate the range without assuming a positive divisor.', assumptions: ['a b : Int'], materials: ['material.md'], reason: 'Controlled change of the mathematical goal.' })
    result.revisedApplicability = revised.checks[0]
    assert.equal(revised.task.currentRevision, 2)
    assert.equal(revised.task.checks.length, 1)
    assert.equal(revised.task.checks[0].id, receiptId)
    assert.equal(revised.task.checks[0].revision, 1)
    assert.equal(revised.checks[0].currentSource, true)
    assert.equal(revised.checks[0].currentGoal, false)
    assert.equal(revised.checks[0].applicableToRecordedInputs, false)
    await assert.rejects(binding.io.write(outsideFile, 'unexpected', null), { code: 'PATH_OUTSIDE_WORKSPACE' })
    const denied = await binding.run({ command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', [
      "$ErrorActionPreference='Stop'", 'Write-Output "PRIVATE_TEMP=$env:TEMP"',
      "Set-Content -LiteralPath './inside-native.txt' -Value 'inside-ok'",
      "Set-Content -LiteralPath (Join-Path $env:TEMP 'temp-native.txt') -Value 'temp-ok'",
      'try { Set-Content -LiteralPath ' + quote(outsideFile) + " -Value 'unexpected' -ErrorAction Stop; Write-Output 'OUTSIDE_UNEXPECTED'; exit 71 }",
      "catch { if ($_.Exception -is [System.UnauthorizedAccessException] -or $_.CategoryInfo.Category -eq 'PermissionDenied') { Write-Output ('OUTSIDE_DENIED='+$_.Exception.Message) } else { throw } }",
      'exit 0',
    ].join('\n')], cwd: workspace, env: {}, signal: new AbortController().signal, timeoutMs: 30_000 })
    result.boundaryExecution = denied
    assert.equal(denied.exitCode, 0, JSON.stringify(denied))
    assert.match(denied.stdout, /OUTSIDE_DENIED=/)
    assert.equal(await fs.stat(outsideFile).then(() => true, () => false), false)
    assert.equal(await fs.readFile(path.join(workspace, 'inside-native.txt'), 'utf8').then(x => x.trim()), 'inside-ok')
    privateTemp = denied.stdout.match(/^PRIVATE_TEMP=(.+)\r?$/m)?.[1]?.trim()
    assert.ok(privateTemp)
    const relative = path.relative(realTemp, privateTemp)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    assert.equal(await fs.readFile(path.join(privateTemp, 'temp-native.txt'), 'utf8').then(x => x.trim()), 'temp-ok')
    result.privateTemp = privateTemp
    result.sourceRestoredSha256 = hash(await fs.readFile(path.join(workspace, 'R02.lean')))
    result.passed = true
  } catch (error) {
    result.error = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    try { await ctx.fiber.dispose() } catch (error) { result.disposeError = error.message; result.passed = false }
    if (privateTemp) {
      result.privateTempRemoved = await fs.stat(privateTemp).then(() => false, () => true)
      if (!result.privateTempRemoved) result.passed = false
    }
    if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp
    if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp
    result.endedAt = new Date().toISOString()
    result.coverage = 'Real native LocalSandboxProvider/runner, native sandbox FS/subprocess and plugin, R02 verification, source/goal staleness, inner/private-temp writes and denied outside write. Windows enforcement remains partial; this is not read/network isolation.'
    result.nativeStandingGrantNote = 'Only the original provider performs its ordinary workspace grants; those stand by design. Its private temp is disposed. All durable diagnostic workspaces are retained; no existing directory is removed.'
    const file = path.join(workspace, 'smoke-result.json')
    await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n')
    result.resultFile = file
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.DSH_NATIVE_SANDBOX_TEST !== '1') {
    console.log('Not run. Set DSH_NATIVE_SANDBOX_TEST=1 to opt into the real Windows sandbox smoke.')
  } else {
    const result = await runNativeSmoke()
    console.log(JSON.stringify({ passed: result.passed, resultFile: result.resultFile, workspace: result.workspace, error: result.error ?? null, verification: result.verification?.check.outcome ?? null, privateTempRemoved: result.privateTempRemoved ?? null }, null, 2))
    process.exitCode = result.passed ? 0 : 1
  }
}

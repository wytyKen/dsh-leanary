import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../dist/index.js'

async function fixture(t, mode = 'workspace-write') {
  const cache = path.resolve('.cache/tests'); await fs.mkdir(cache, { recursive: true })
  const root = await fs.mkdtemp(path.join(cache, 'plugin-'))
  await fs.writeFile(path.join(root, 'draft.md'), 'An existing mathematical draft.')
  await fs.writeFile(path.join(root, 'Proof.lean'), 'theorem target : True := True.intro\n')
  const ctx = new Context()
  ctx.provide('workingDirectory', { get: session => session.cwd })
  ctx.provide('sandboxPolicy', { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: root }) })
  ctx.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SandboxedFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  // This executable deliberately does not exist: the verifier must attach the
  // real environment failure, never a simulated successful proof.
  const fiber = ctx.plugin(plugin, { leanCommand: 'dsh-math-test-no-such-lean-executable', timeoutMs: 5000 })
  await fiber
  let seq = 0
  const invoke = async (name, args) => ctx.tools.execute({ callId: `host-test-${++seq}`, name, arguments: args, signal: new AbortController().signal })
  const value = async (name, args) => {
    const result = await invoke(name, args)
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value ?? JSON.parse(result.content.map(block => block.text ?? '').join('\n'))
  }
  t.after(async () => {
    await ctx.fiber.dispose()
    const relative = path.relative(cache, root)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    await fs.rm(root, { recursive: true, force: true })
  })
  return { ctx, fiber, root, invoke, value }
}

test('plugin loads native canonical schemas and natural-language guidance, then disposes registrations', async t => {
  const f = await fixture(t)
  const names = f.ctx.tools.schemas().map(s => s.name)
  assert.ok(names.includes('math_task')); assert.ok(names.includes('math_verify'))
  const assembly = await f.ctx.systemPrompt.assemble()
  const section = assembly.sections.find(s => s.name === 'dsh-math:research-workflow')
  assert.match(section.text, /without asking permission at every step/)
  assert.match(section.text, /does not automatically certify/)
  assert.deepEqual(await f.value('math_task', { action: 'list' }), [])
  await f.fiber.dispose()
  assert.equal(f.ctx.tools.schemas().some(s => s.name === 'math_task' || s.name === 'math_verify'), false)
})

test('task actions persist revisions; verification binds immutable claim type and attaches actual failure', async t => {
  const f = await fixture(t)
  const created = await f.value('math_task', { action: 'create', request: 'Continue this draft.', goal: 'Prove True.', materials: ['draft.md'] })
  const id = created.task.id
  const claimed = await f.value('math_task', { action: 'claim', task_id: id, revision: 1, statement: 'True holds.', formal_type: 'True', role: 'target' })
  const claim = claimed.task.claims[0]
  await f.value('math_task', { action: 'note', task_id: id, revision: 1, text: 'A simple proof is available.', next_step: 'Check the recorded declaration.' })
  const revised = await f.value('math_task', { action: 'revise', task_id: id, expected_revision: 1, request: 'Change direction.', goal: 'Investigate False.', reason: 'User changed the target.', assumptions: [], materials: ['draft.md'] })
  assert.equal(revised.task.currentRevision, 2)
  const checked = await f.value('math_verify', { task_id: id, claim_id: claim.id, source_path: 'Proof.lean', declaration: 'target', expected_type: 'False', revision: 2 })
  assert.equal(checked.check.expectedType, 'True'); assert.equal(checked.check.revision, 1)
  assert.equal(checked.check.outcome, 'environment_error')
  assert.equal(checked.check.semanticCorrespondence, 'not_automatically_certified')
  assert.equal(checked.applicability.currentGoal, false)
  const read = await f.value('math_task', { action: 'read', task_id: id })
  assert.equal(read.task.checks.length, 1); assert.equal(read.task.notes.length, 1)
  const listed = await f.value('math_task', { action: 'list' })
  assert.equal(listed[0].id, id)
})

test('native read-only policy prevents task creation; missing formal type is not silently supplied', async t => {
  const readonly = await fixture(t, 'read-only')
  const denied = await readonly.invoke('math_task', { action: 'create', request: 'Draft.', goal: 'Read only.' })
  assert.equal(denied.isError, true)
  const f = await fixture(t)
  const created = await f.value('math_task', { action: 'create', request: 'Draft.', goal: 'Study a claim.' })
  const claimed = await f.value('math_task', { action: 'claim', task_id: created.task.id, revision: 1, statement: 'Unformalized observation.', role: 'observation' })
  const rejected = await f.invoke('math_verify', { task_id: created.task.id, claim_id: claimed.task.claims[0].id, source_path: 'Proof.lean', declaration: 'target' })
  assert.equal(rejected.isError, true)
  const view = await f.value('math_task', { action: 'read', task_id: created.task.id })
  assert.equal(view.task.checks.length, 0)
})

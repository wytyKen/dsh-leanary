import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { bindHostCall } from '../dist/host/adapters.js'

async function fixture(t, mode = 'workspace-write', sandboxFs = false) {
  const cache = path.resolve('.cache/tests')
  await fs.mkdir(cache, { recursive: true })
  const base = await fs.mkdtemp(path.join(cache, 'host-'))
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside')
  await fs.mkdir(root); await fs.mkdir(outside)
  const ctx = new Context()
  const policy = { mode, workspaceRoot: root }
  ctx.provide('sandboxPolicy', { defaultMode: mode, resolve: () => policy })
  await ctx.plugin(sandboxFs ? SandboxedFileSystem : LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  const services = {
    fs: ctx.fs, subprocess: ctx.subprocess, sandboxPolicy: ctx.sandboxPolicy,
    workingDirectory: { get: session => session.current },
    sandbox: { confine: async argv => ({ argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) },
  }
  t.after(async () => {
    await ctx.fiber.dispose()
    const relative = path.relative(cache, base)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    await fs.rm(base, { recursive: true, force: true })
  })
  return { ctx, services, root, outside, policy }
}
const call = signal => ({ signal: signal ?? new AbortController().signal })

test('native filesystem uses guarded creates/CAS, stable relative listing, and canonical containment', async t => {
  const f = await fixture(t), { io } = await bindHostCall(f.services, call())
  assert.equal(await io.read('missing.md'), null)
  await io.write('nested/a.md', 'first', null)
  const first = await io.read('nested/a.md')
  assert.equal(first.content, 'first')
  assert.deepEqual(await io.list('nested'), ['nested/a.md'])
  await assert.rejects(io.write('nested/a.md', 'overwrite', null), { code: 'VERSION_CONFLICT' })
  await io.write('nested/a.md', 'second', first.version)
  await assert.rejects(io.write('nested/a.md', 'stale', first.version), { code: 'VERSION_CONFLICT' })
  await assert.rejects(io.read('../outside/private.md'), { code: 'PATH_OUTSIDE_WORKSPACE' })
  await fs.writeFile(path.join(f.outside, 'private.md'), 'not task input')
  await fs.symlink(f.outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(io.read('linked/private.md'), { code: 'PATH_OUTSIDE_WORKSPACE' })
  await assert.rejects(io.write('linked/private.md', 'escape', null), { code: 'PATH_OUTSIDE_WORKSPACE' })
  assert.equal(await fs.readFile(path.join(f.outside, 'private.md'), 'utf8'), 'not task input')
})

test('every call rebinds the calling directory and retains the session policy', async t => {
  const f = await fixture(t), second = path.join(f.root, 'second')
  await fs.mkdir(second)
  const session = { current: f.root }
  let seenSession
  f.services.sandboxPolicy = { resolve: request => { seenSession = request.session; return f.policy } }
  const first = await bindHostCall(f.services, { ...call(), agent: { session } })
  session.current = second
  const next = await bindHostCall(f.services, { ...call(), agent: { session } })
  assert.equal(first.io.root, f.root); assert.equal(next.io.root, second)
  assert.equal(seenSession, session)
  await next.io.write('current.txt', 'second-only', null)
  assert.equal(await first.io.read('current.txt'), null)
  assert.equal((await first.io.read('second/current.txt')).content, 'second-only')
})

test('read-only native FS remains read-only, and cancellation reaches filesystem operations', async t => {
  const f = await fixture(t, 'read-only', true)
  await fs.writeFile(path.join(f.root, 'draft.md'), 'readable')
  const abort = new AbortController(), { io } = await bindHostCall(f.services, call(abort.signal))
  assert.equal((await io.read('draft.md')).content, 'readable')
  await assert.rejects(io.write('new.md', 'forbidden', null), { code: 'FS_SANDBOX_DENIED' })
  abort.abort(new Error('caller cancelled'))
  await assert.rejects(io.read('draft.md'), /caller cancelled/)
  await assert.rejects(io.write('new.md', 'forbidden', null), /caller cancelled/)
})

test('runner uses returned confinement argv, explicit env only, and caller policy', async t => {
  const f = await fixture(t, 'read-only')
  let wrappedPolicy, spawnSpec, wrapSignal
  f.services.sandbox = { confine: async (argv, policy, signal) => {
    wrappedPolicy = policy; wrapSignal = signal
    return { argv: [argv[0], '-e', 'process.stdout.write("wrapped:"+process.env.ONLY_EXTRA)'], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }
  } }
  f.services.subprocess = {
    resolveExecutable: (...args) => f.ctx.subprocess.resolveExecutable(...args),
    spawn: spec => { spawnSpec = spec; return f.ctx.subprocess.spawn(spec) },
  }
  const exec = call(), { run } = await bindHostCall(f.services, exec)
  const result = await run({ command: process.execPath, args: ['-e', 'process.stdout.write("unwrapped")'], cwd: f.root, env: { ONLY_EXTRA: 'yes' }, signal: exec.signal, timeoutMs: 5000 })
  assert.equal(result.stdout, 'wrapped:yes'); assert.equal(result.exitCode, 0)
  assert.equal(wrappedPolicy.mode, 'read-only'); assert.equal(wrappedPolicy.workspaceRoot, f.root)
  assert.equal(wrapSignal, spawnSpec.signal)
  assert.deepEqual(spawnSpec.env, { ONLY_EXTRA: 'yes' })
  await assert.rejects(run({ command: process.execPath, args: [], cwd: f.outside, env: {}, signal: exec.signal, timeoutMs: 1000 }), { code: 'PATH_OUTSIDE_WORKSPACE' })
})

test('timeout and parent cancellation settle native processes without an unconfined retry', async t => {
  const f = await fixture(t)
  let wraps = 0
  f.services.sandbox.confine = async argv => { wraps++; return { argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] } }
  const timeoutBinding = await bindHostCall(f.services, call())
  const request = { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: f.root, env: {}, signal: new AbortController().signal, timeoutMs: 300 }
  const timeout = await timeoutBinding.run(request)
  assert.equal(timeout.timedOut, true); assert.equal(timeout.aborted, false)
  const parent = new AbortController(), binding = await bindHostCall(f.services, call(parent.signal))
  const pending = binding.run({ ...request, timeoutMs: 5000 })
  setTimeout(() => parent.abort(), 100)
  const cancelled = await pending
  assert.equal(cancelled.aborted, true); assert.equal(cancelled.timedOut, false)
  assert.equal(wraps, 2)
})

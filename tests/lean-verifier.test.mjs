import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { verifyLean } from '../dist/lean/verify.js'

const lean = process.env.DSH_MATH_TEST_LEAN
const real = { skip: !lean && 'Set DSH_MATH_TEST_LEAN to the installed Lean 4.22 executable.' }
const digest = value => createHash('sha256').update(value).digest('hex')

async function fixture(t, source, sourcePath = 'Result.lean') {
  const parent = path.resolve('.cache/tests/lean-verifier')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'dsh-math-verifier-'))
  t.after(async () => {
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith('dsh-math-verifier-'))
    await rm(root, { recursive: true, force: true })
  })
  const full = relative => {
    const target = path.resolve(root, ...relative.split('/'))
    assert.ok(target === root || target.startsWith(root + path.sep), 'fixture path escaped scratch')
    return target
  }
  const generations = new Map()
  const io = {
    root,
    async read(relative) {
      try {
        const content = await readFile(full(relative), 'utf8')
        return { content, version: digest(content) + ':' + (generations.get(relative) ?? 0) }
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
    },
    async write(relative, content, expectedVersion) {
      if (expectedVersion !== null) assert.equal((await io.read(relative))?.version, expectedVersion)
      await mkdir(path.dirname(full(relative)), { recursive: true })
      await writeFile(full(relative), content, { encoding: 'utf8', flag: expectedVersion === null ? 'wx' : 'w' })
    },
    async list() { return [] },
  }
  await io.write(sourcePath, source, null)
  const requests = []
  const execute = async request => {
    requests.push(request)
    return await new Promise(resolve => {
      let stdout = '', stderr = '', aborted = false, timedOut = false, settled = false
      // Tests intentionally exercise a real process in isolated scratch. Production uses only
      // the injected runner and never copies the process environment or invokes spawn/fs.
      const child = spawn(request.command, request.args, {
        cwd: request.cwd, env: { ...process.env, ...request.env }, windowsHide: true,
      })
      const abort = () => { aborted = true; child.kill() }
      const timer = setTimeout(() => { timedOut = true; child.kill() }, request.timeoutMs)
      request.signal.addEventListener('abort', abort, { once: true })
      const finish = exitCode => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        resolve({ exitCode, stdout, stderr, aborted, timedOut })
      }
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
      child.once('error', error => { stderr += error.message; finish(null) })
      child.once('close', code => finish(code))
    })
  }
  const request = { taskId: 'task-1', claimId: 'claim-1', revision: 2, sourcePath, declaration: 'result', expectedType: 'True' }
  const options = {
    io, run: execute, signal: new AbortController().signal, leanCommand: lean ?? 'lean-not-run', leanArgs: [],
    timeoutMs: 30_000, allowedAxioms: ['propext', 'Quot.sound', 'Classical.choice'],
  }
  return { io, root, requests, request, options, execute, bumpVersion: () => generations.set(sourcePath, 1) }
}

async function evidence(f, record) {
  assert.equal(record.semanticCorrespondence, 'not_automatically_certified')
  assert.equal(record.sourceSha256, digest((await f.io.read(record.sourceSnapshot)).content))
  assert.deepEqual(JSON.parse((await f.io.read(`.dsh/math/checks/${record.id}/record.json`)).content), record)
  for (const command of record.commands) {
    assert.equal(typeof (await f.io.read(command.stdoutFile)).content, 'string')
    assert.equal(typeof (await f.io.read(command.stderrFile)).content, 'string')
  }
}

test('valid: real Lean checks the exact proposition and preserves a nested module path', real, async t => {
  const source = `import Init.Data.Int
namespace Example
theorem result (a b : Int) (hb : 0 < b) : 0 ≤ a % b ∧ a % b < b := by
  exact ⟨Int.emod_nonneg a (Int.ne_of_gt hb), Int.emod_lt_of_pos a hb⟩
end Example
`
  const f = await fixture(t, source, 'Nested/Remainder.lean')
  const record = await verifyLean({ ...f.request, declaration: 'Example.result', expectedType: '∀ a b : Int, 0 < b → 0 ≤ a % b ∧ a % b < b' }, f.options)
  if (record.outcome !== 'verified') {
    for (const command of record.commands) t.diagnostic((await f.io.read(command.stdoutFile)).content + (await f.io.read(command.stderrFile)).content)
  }
  assert.equal(record.outcome, 'verified', record.message)
  assert.deepEqual(record.axioms, ['propext'])
  assert.equal(record.commands.length, 4)
  assert.ok(record.sourceSnapshot.endsWith('/snapshot/Nested/Remainder.lean'))
  assert.ok(record.commands.some(command => command.args.some(arg => arg.startsWith('--root='))))
  assert.deepEqual(record.sourceFiles, [{ path: f.request.sourcePath, sha256: digest(source), snapshot: record.sourceSnapshot }])
  assert.match((await f.io.read(`.dsh/math/checks/${record.id}/probe.lean`)).content, /import «Nested»\.«Remainder»/)
  assert.equal((await f.io.read(f.request.sourcePath)).content, source)
  await evidence(f, record)
})

test('rejects an extra False premise even though the resulting proposition is provable', real, async t => {
  const f = await fixture(t, 'theorem result (h : False) : True := by trivial\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'target_mismatch', record.message)
  assert.match(record.actualType, /False/)
  await evidence(f, record)
})

test('sorryAx can never be allowed by the configured whitelist', real, async t => {
  const f = await fixture(t, 'theorem result : True := by sorry\n')
  const record = await verifyLean(f.request, { ...f.options, allowedAxioms: [...f.options.allowedAxioms, 'sorryAx'] })
  assert.equal(record.outcome, 'unaccepted_axioms', record.message)
  assert.ok(record.axioms.includes('sorryAx'))
  await evidence(f, record)
})

test('rejects a custom axiom transitively used by a theorem, even if configured', real, async t => {
  const f = await fixture(t, 'axiom assumed : True\ndef bridge : True := assumed\ntheorem result : True := bridge\n')
  const record = await verifyLean(f.request, { ...f.options, allowedAxioms: [...f.options.allowedAxioms, 'assumed'] })
  assert.equal(record.outcome, 'unaccepted_axioms', record.message)
  assert.deepEqual(record.axioms, ['assumed'])
  await evidence(f, record)
})

test('a real compiler error is compile_error and does not run the probe', real, async t => {
  const f = await fixture(t, 'theorem result : True := by exact false\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'compile_error', record.message)
  const compilation = record.commands.find(command => command.stdoutFile.endsWith('/compile.stdout.txt'))
  assert.ok(compilation)
  assert.notEqual(compilation.exitCode, 0)
  assert.equal(record.commands.some(command => command.stdoutFile.endsWith('/probe.stdout.txt')), false)
  await evidence(f, record)
})

test('a changed current source cannot inherit the immutable snapshot result', real, async t => {
  const source = 'theorem result : True := by trivial\n'
  const f = await fixture(t, source)
  const record = await verifyLean(f.request, { ...f.options, run: async request => {
    const result = await f.execute(request)
    if (request.args.includes('-o')) await f.io.write(f.request.sourcePath, source + '-- changed\n', (await f.io.read(f.request.sourcePath)).version)
    return result
  } })
  assert.equal(record.outcome, 'source_changed', record.message)
  assert.equal((await f.io.read(record.sourceSnapshot)).content, source)
  assert.notEqual(digest((await f.io.read(f.request.sourcePath)).content), record.sourceSha256)
  await evidence(f, record)
})

test('a changed opaque IO version with identical content remains applicable', real, async t => {
  const f = await fixture(t, 'theorem result : True := by trivial\n')
  const record = await verifyLean(f.request, { ...f.options, run: async request => {
    const result = await f.execute(request)
    if (request.args.includes('-o')) f.bumpVersion()
    return result
  } })
  assert.equal(record.outcome, 'verified', record.message)
  await evidence(f, record)
})

test('a data definition is not a mathematical proposition proof', real, async t => {
  const f = await fixture(t, 'def result : Nat := 3\n')
  const record = await verifyLean({ ...f.request, expectedType: 'Nat' }, f.options)
  assert.equal(record.outcome, 'target_mismatch', record.message)
  await evidence(f, record)
})

test('a proof defined with def is accepted when its closed type is Prop', real, async t => {
  const f = await fixture(t, 'def result : True := True.intro\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'verified', record.message)
  await evidence(f, record)
})

test('a missing declaration is target_mismatch, not a successful inspection', real, async t => {
  const f = await fixture(t, 'theorem other : True := by trivial\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'target_mismatch', record.message)
  assert.equal(record.actualType, null)
  await evidence(f, record)
})

test('an expected type containing an unresolved metavariable cannot act as a wildcard', real, async t => {
  const f = await fixture(t, 'theorem result : True := by trivial\n')
  const record = await verifyLean({ ...f.request, expectedType: '_' }, f.options)
  assert.equal(record.outcome, 'target_mismatch', record.message)
  await evidence(f, record)
})

test('expected type names resolve in the inspection namespace and failed names retain an actionable diagnostic', real, async t => {
  const source = 'namespace Example\ndef RecordedLaw : Prop := True\ntheorem result : RecordedLaw := True.intro\nend Example\n'
  const f = await fixture(t, source)
  const unqualified = await verifyLean({ ...f.request, declaration: 'Example.result', expectedType: 'RecordedLaw' }, f.options)
  assert.equal(unqualified.outcome, 'target_mismatch', unqualified.message)
  assert.match(unqualified.message, /formal_type could not be elaborated/)
  assert.match(unqualified.message, /fully qualified custom names/)
  assert.match(unqualified.message, /unknown identifier 'RecordedLaw'/)
  await evidence(f, unqualified)
  const qualified = await verifyLean({ ...f.request, declaration: 'Example.result', expectedType: 'Example.RecordedLaw' }, f.options)
  assert.equal(qualified.outcome, 'verified', qualified.message)
  assert.notEqual(qualified.id, unqualified.id)
  assert.equal((await f.io.read(f.request.sourcePath)).content, source)
  await evidence(f, qualified)
})

test('duplicate host-nonce markers are refused', real, async t => {
  const f = await fixture(t, 'theorem result : True := by trivial\n')
  const record = await verifyLean(f.request, { ...f.options, run: async request => {
    const result = await f.execute(request)
    if (request.args.at(-1)?.endsWith('/probe.lean') || request.args.at(-1)?.endsWith('\\probe.lean')) {
      const markerLine = result.stdout.split(/\r?\n/).find(line => line.includes('__DSH_MATH_PROBE_'))
      assert.ok(markerLine)
      return { ...result, stdout: result.stdout + '\n' + markerLine + '\n' }
    }
    return result
  } })
  assert.equal(record.outcome, 'environment_error', record.message)
  await evidence(f, record)
})

test('pre-cancelled verification never invokes a command', async t => {
  const f = await fixture(t, 'theorem result : True := by trivial\n')
  const controller = new AbortController()
  controller.abort()
  const record = await verifyLean(f.request, { ...f.options, signal: controller.signal, run: async () => assert.fail('unexpected command') })
  assert.equal(record.outcome, 'cancelled')
  assert.equal(record.commands.length, 0)
})

test('runner timeout is distinguished from compilation or target failure', async t => {
  const f = await fixture(t, 'theorem result : True := by trivial\n')
  const record = await verifyLean(f.request, { ...f.options, run: async () => ({
    exitCode: null, stdout: '', stderr: 'fixture timeout', timedOut: true, aborted: true,
  }) })
  assert.equal(record.outcome, 'timeout')
  await evidence(f, record)
})

test('unsafe relative source paths are rejected before a command can run', async t => {
  const f = await fixture(t, 'theorem result : True := by trivial\n')
  for (const sourcePath of ['../Result.lean', 'Nested/C:/Result.lean', 'Nested/.. /Result.lean']) {
    const record = await verifyLean({ ...f.request, sourcePath }, { ...f.options, run: async () => assert.fail('unexpected command') })
    assert.equal(record.outcome, 'environment_error')
    assert.equal(record.commands.length, 0)
  }
})

test('interruption status survives a backend refusing to archive command output', async t => {
  for (const outcome of ['cancelled', 'timeout']) {
    const f = await fixture(t, 'theorem result : True := by trivial\n')
    const controller = new AbortController()
    const io = {
      ...f.io,
      async write(relative, content, expectedVersion) {
        if (relative.endsWith('.stdout.txt') || relative.endsWith('.stderr.txt')) throw new Error('fixture logging unavailable')
        await f.io.write(relative, content, expectedVersion)
      },
    }
    const record = await verifyLean(f.request, {
      ...f.options, io, signal: controller.signal,
      run: async () => {
        if (outcome === 'cancelled') controller.abort()
        return { exitCode: null, stdout: '', stderr: '', timedOut: outcome === 'timeout', aborted: true }
      },
    })
    assert.equal(record.outcome, outcome)
    assert.match(record.message, /Could not archive command output/)
  }
})

test('local imports: real Lean parses nested comments, multiline and quoted names, then builds the transitive closure', real, async t => {
  const source = `/- An ignored import Ghost. /- import StillGhost -/ -/
import
  Nested.Middle
import «Name.with.dot»
theorem result : True := middle
`
  const f = await fixture(t, source, 'App/Result.lean')
  await f.io.write('Nested/Middle.lean', 'import Base\ntheorem middle : True := leaf\n', null)
  await f.io.write('Base.lean', 'theorem leaf : True := True.intro\n', null)
  await f.io.write('Name.with.dot.lean', 'theorem quoted : True := True.intro\n', null)
  const record = await verifyLean(f.request, { ...f.options, timeoutMs: 60_000 })
  if (record.outcome !== 'verified') for (const command of record.commands) t.diagnostic((await f.io.read(command.stdoutFile)).content + (await f.io.read(command.stderrFile)).content)
  assert.equal(record.outcome, 'verified', record.message)
  assert.deepEqual(record.sourceFiles.map(file => file.path), ['App/Result.lean', 'Nested/Middle.lean', 'Base.lean', 'Name.with.dot.lean'])
  for (const file of record.sourceFiles) assert.equal(digest((await f.io.read(file.snapshot)).content), file.sha256)
  const compiled = record.commands.filter(command => command.args.includes('-o')).map(command => path.relative(f.root, command.args.at(-1)).replaceAll('\\', '/').split('/snapshot/')[1])
  assert.deepEqual(compiled, ['Base.lean', 'Nested/Middle.lean', 'Name.with.dot.lean', 'App/Result.lean'])
  assert.ok(f.requests.every(request => Object.hasOwn(request.env, 'LEAN_PATH')))
  await evidence(f, record)
})

test('a dependency changed during a real build prevents a successful receipt even when the main source is unchanged', real, async t => {
  const source = 'import Dep\ntheorem result : True := dependency\n'
  const f = await fixture(t, source)
  const dependency = 'theorem dependency : True := True.intro\n'
  await f.io.write('Dep.lean', dependency, null)
  const record = await verifyLean(f.request, { ...f.options, run: async request => {
    const executed = await f.execute(request)
    if (request.args.includes('-o')) await f.io.write('Dep.lean', dependency + '-- changed\n', (await f.io.read('Dep.lean')).version)
    return executed
  } })
  assert.equal(record.outcome, 'source_changed', record.message)
  assert.equal((await f.io.read(f.request.sourcePath)).content, source)
  assert.equal((await f.io.read(record.sourceFiles.find(file => file.path === 'Dep.lean').snapshot)).content, dependency)
  await evidence(f, record)
})

test('transitive sorry and custom axioms in local imported proofs remain rejected', real, async t => {
  for (const [body, rejected] of [
    ['theorem dependency : True := by sorry\n', 'sorryAx'],
    ['axiom localAssumption : True\ntheorem dependency : True := localAssumption\n', 'localAssumption'],
  ]) {
    const f = await fixture(t, 'import Dep\ntheorem result : True := dependency\n')
    await f.io.write('Dep.lean', body, null)
    const record = await verifyLean(f.request, { ...f.options, allowedAxioms: [...f.options.allowedAxioms, rejected] })
    assert.equal(record.outcome, 'unaccepted_axioms', record.message)
    assert.ok(record.axioms.includes(rejected))
    assert.equal(record.sourceFiles.length, 2)
    await evidence(f, record)
  }
})

test('missing and cyclic local imports fail clearly without accepting existing compiled artifacts', real, async t => {
  const missing = await fixture(t, 'import Missing\ntheorem result : True := by trivial\n')
  await missing.io.write('Missing.olean', 'an untracked compiled artifact', null)
  const absent = await verifyLean(missing.request, missing.options)
  assert.equal(absent.outcome, 'environment_error', absent.message)
  assert.match(absent.message, /requires workspace source Missing\.lean/)
  assert.equal(absent.commands.some(command => command.args.includes('-o')), false)
  await evidence(missing, absent)
  const cyclic = await fixture(t, 'import Cycle\ntheorem result : True := by trivial\n')
  await cyclic.io.write('Cycle.lean', 'import Result\ntheorem dependency : True := by trivial\n', null)
  const cycle = await verifyLean(cyclic.request, cyclic.options)
  assert.equal(cycle.outcome, 'environment_error', cycle.message)
  assert.match(cycle.message, /Cyclic local imports/)
  await evidence(cyclic, cycle)
})

test('ambient external LEAN_PATH cannot provide unarchived imports', real, async t => {
  const f = await fixture(t, 'import Outside\ntheorem result : True := outside\n')
  await f.io.write('external/Outside.lean', 'theorem outside : True := True.intro\n', null)
  const built = await f.execute({ command: lean, args: ['-o', path.join(f.root, 'external/Outside.olean'), path.join(f.root, 'external/Outside.lean')], cwd: path.join(f.root, 'external'), env: { LEAN_PATH: '' }, timeoutMs: 30_000, signal: new AbortController().signal })
  assert.equal(built.exitCode, 0, built.stderr + built.stdout)
  const prior = process.env.LEAN_PATH
  try {
    process.env.LEAN_PATH = path.join(f.root, 'external')
    const record = await verifyLean(f.request, f.options)
    assert.equal(record.outcome, 'environment_error', record.message)
    assert.match(record.message, /requires workspace source Outside\.lean/)
    await evidence(f, record)
  } finally {
    if (prior === undefined) delete process.env.LEAN_PATH
    else process.env.LEAN_PATH = prior
  }
})

test('toolchain module roots are reserved and cannot shadow the trusted import parser', real, async t => {
  const f = await fixture(t, 'theorem result : True := True.intro\n', 'Lean.lean')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'environment_error', record.message)
  assert.match(record.message, /reserved toolchain module root/)
  assert.equal(record.commands.some(command => command.args.includes('-o')), false)
  await evidence(f, record)
})

test('a missing module under a reserved root is reported as unavailable before compilation', real, async t => {
  const f = await fixture(t, 'import Lean.DshMathModuleThatDoesNotExist\ntheorem result : True := True.intro\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'environment_error', record.message)
  assert.match(record.message, /Toolchain module Lean\.DshMathModuleThatDoesNotExist is unavailable/)
  assert.equal(record.commands.some(command => command.args.includes('-o')), false)
  await evidence(f, record)
})

test('a malformed import header preserves Lean parser diagnostics and cannot be certified', real, async t => {
  const f = await fixture(t, 'import (Broken)\ntheorem result : True := True.intro\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'compile_error', record.message)
  assert.match(record.message, /rejected the import header/)
  assert.equal(record.commands.some(command => command.args.includes('-o')), false)
  const parsed = record.commands.find(command => command.stderrFile.endsWith('/imports-0.stderr.txt'))
  assert.ok(parsed)
  assert.match((await f.io.read(parsed.stderrFile)).content, /expected|unexpected|invalid/i)
  await evidence(f, record)
})

test('quoted import names cannot escape the workspace path', real, async t => {
  const f = await fixture(t, 'import «..».Escape\ntheorem result : True := True.intro\n')
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'environment_error', record.message)
  assert.match(record.message, /without traversal/)
  assert.equal(record.commands.some(command => command.args.includes('-o')), false)
  await evidence(f, record)
})

test('Windows case aliases cannot hide an import cycle or share one archived module', { ...real, skip: !lean || process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'import Dep\nimport dep\ntheorem result : True := dependency\n')
  await f.io.write('Dep.lean', 'theorem dependency : True := True.intro\n', null)
  const record = await verifyLean(f.request, f.options)
  assert.equal(record.outcome, 'environment_error', record.message)
  assert.match(record.message, /conflicting path case aliases/)
  await evidence(f, record)
})

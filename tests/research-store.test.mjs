import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ResearchStore, ResearchStoreError } from '../dist/core/research-store.js'

const sha256 = content => createHash('sha256').update(content).digest('hex')
const stamp = '2026-10-26T12:00:00.000Z'
const initial = { request: '继续核对这份草稿', goal: '判断草稿的结论是否成立', assumptions: [], materials: ['draft.md'] }
const claimInput = { statement: '一个待核对的精确命题', formalType: 'True', role: 'target', conditions: [] }
const proofSource = 'theorem target : True := True.intro\n'
const snapshotPath = 'snapshots/proof-before.lean'
const taskPath = id => `.dsh/math/tasks/${id}.json`
const hasCode = code => error => error instanceof ResearchStoreError && error.code === code

class MemoryIO {
  root = 'D:/test-workspace'
  files = new Map()
  sequence = 0
  writes = []
  beforeWrite = null
  failRead = null

  put(path, content) {
    // Deliberately not a number/hash: the store must pass versions through unchanged.
    this.files.set(path, { content, version: `opaque!${++this.sequence}|\nbackend` })
  }
  async read(path) {
    if (this.failRead === path) throw new Error('backend unavailable')
    const result = this.files.get(path)
    return result ? { ...result } : null
  }
  async write(path, content, version) {
    this.writes.push({ path, content, version })
    if (this.beforeWrite) await this.beforeWrite(path, content, version)
    const current = this.files.get(path)
    if ((version === null && current) || (version !== null && current?.version !== version)) {
      throw Object.assign(new Error('backend version conflict'), { code: 'VERSION_CONFLICT' })
    }
    this.put(path, content)
  }
  async list(directory) {
    return [...this.files.keys()].filter(path => path.startsWith(`${directory}/`))
  }
}

async function setup() {
  const io = new MemoryIO()
  io.put('draft.md', '原始中文草稿\n')
  io.put('proof.lean', proofSource)
  io.put(snapshotPath, proofSource)
  const store = new ResearchStore(io)
  const created = await store.create(initial)
  const withClaim = await store.addClaim(created.task.id, 1, claimInput)
  const claim = withClaim.task.claims[0]
  return { io, store, id: created.task.id, claim }
}

function receipt(id, claim, overrides = {}) {
  return {
    id: 'check-first', taskId: id, claimId: claim.id, revision: claim.revision,
    sourcePath: 'proof.lean', sourceSha256: sha256(proofSource), sourceSnapshot: snapshotPath,
    declaration: 'target', expectedType: claim.formalType, actualType: 'True', axioms: [],
    outcome: 'verified', message: 'The recorded Lean claim compiled.', toolchain: 'Lean 4.22.0',
    commands: [{ command: 'lean', args: ['proof.lean'], cwd: 'D:/test-workspace', exitCode: 0, stdoutFile: 'logs/first.stdout', stderrFile: 'logs/first.stderr' }],
    startedAt: stamp, completedAt: stamp, semanticCorrespondence: 'not_automatically_certified',
    ...overrides,
  }
}

test('creates only a task JSON, snapshots original material and returns honest summaries', async () => {
  const { io, store, id } = await setup()
  const view = await store.addNote(id, 1, { text: '论证还缺少一步', nextStep: '先检查这一步是否成立' })
  assert.equal(view.task.schemaVersion, 1)
  assert.match(id, /^task-/)
  assert.equal(view.task.revisions[0].materials[0].sha256, sha256('原始中文草稿\n'))
  assert.equal(view.task.notes[0].revision, 1)
  assert.equal(view.checks.length, 0)
  assert.equal(io.writes[0].version, null)
  assert.ok(io.writes.every(write => write.path === taskPath(id)))
  assert.deepEqual(await store.list(), [{
    id, currentRevision: 1, request: initial.request, goal: initial.goal,
    createdAt: view.task.createdAt, claimCount: 1, noteCount: 1, checkCount: 0,
  }])
  assert.equal(Object.hasOwn(view.task, 'verified'), false)
  assert.equal(Object.hasOwn(view.task.claims[0], 'verified'), false)
})

test('reopens serialized state without an in-memory task cache', async () => {
  const { io, store, id, claim } = await setup()
  await store.attachCheck(id, claim.id, receipt(id, claim))
  const reopenedIO = new MemoryIO()
  reopenedIO.files = new Map(JSON.parse(JSON.stringify([...io.files])))
  reopenedIO.sequence = io.sequence
  const reopened = await new ResearchStore(reopenedIO).read(id)
  assert.equal(reopened.task.checks[0].sourceSnapshot, snapshotPath)
  assert.equal((await reopenedIO.read(snapshotPath)).content, proofSource)
  assert.deepEqual(reopened.checks[0], {
    check: reopened.task.checks[0], currentGoal: true, currentSource: true,
    currentDependencies: null, currentMaterials: true, snapshotIntact: true, applicableToRecordedInputs: true,
  })
  // Mutating a returned object cannot edit the durable JSON.
  reopened.task.claims[0].formalType = 'False'
  assert.equal((await store.read(id)).task.claims[0].formalType, 'True')
})

test('a new goal records a new revision and leaves old claims, notes and checks intact', async () => {
  const { io, store, id, claim } = await setup()
  await store.addNote(id, 1, { text: '原始进展', nextStep: '保留待办' })
  const checked = await store.attachCheck(id, claim.id, receipt(id, claim))
  const original = structuredClone(checked.task.revisions[0])
  io.put('draft.md', '经人修改的草稿\n')
  const next = await store.revise(id, 1, {
    ...initial, goal: '在新增条件下继续研究', assumptions: ['补充的非零条件'], reason: '用户修正目标',
  })
  assert.equal(next.task.currentRevision, 2)
  assert.deepEqual(next.task.revisions[0], original)
  assert.equal(next.task.revisions[1].reason, '用户修正目标')
  assert.equal(next.task.revisions[1].materials[0].sha256, sha256('经人修改的草稿\n'))
  assert.deepEqual(next.task.claims, checked.task.claims)
  assert.deepEqual(next.task.notes, checked.task.notes)
  assert.deepEqual(next.task.checks, checked.task.checks)
  assert.equal(next.checks[0].currentGoal, false)
  assert.equal(next.checks[0].currentSource, true)
  // Compare with the check's original revision, not the new material snapshot.
  assert.equal(next.checks[0].currentMaterials, false)
  assert.equal(next.checks[0].applicableToRecordedInputs, false)
  assert.equal(next.checks[0].check.outcome, 'verified')
  const added = await store.addClaim(id, 2, { ...claimInput, formalType: 'False → False', role: 'conditional', conditions: ['假设 False'] })
  assert.equal(added.task.claims[0].formalType, 'True')
  assert.equal(added.task.claims[1].formalType, 'False → False')
  assert.notEqual(added.task.claims[0].id, added.task.claims[1].id)
})

test('source edits and deletion only change input applicability, never erase a historical result', async () => {
  const { io, store, id, claim } = await setup()
  await store.attachCheck(id, claim.id, receipt(id, claim))
  const persisted = io.files.get(taskPath(id)).content
  io.put('proof.lean', 'theorem changed : True := True.intro\n')
  const changed = await store.read(id)
  assert.equal(changed.checks[0].currentGoal, true)
  assert.equal(changed.checks[0].currentSource, false)
  assert.equal(changed.checks[0].currentMaterials, true)
  assert.equal(changed.checks[0].applicableToRecordedInputs, false)
  assert.equal(changed.task.checks[0].outcome, 'verified')
  assert.equal(io.files.get(taskPath(id)).content, persisted)
  io.files.delete('proof.lean')
  const missing = await store.read(id)
  assert.equal(missing.checks[0].currentSource, false)
  assert.equal(missing.task.checks.length, 1)
})

test('snapshot edits and deletion change evidence integrity independently of current inputs', async () => {
  const { io, store, id, claim } = await setup()
  const attached = await store.attachCheck(id, claim.id, receipt(id, claim))
  assert.equal(attached.checks[0].snapshotIntact, true)
  const persisted = io.files.get(taskPath(id)).content
  io.put(snapshotPath, 'a modified archive')
  const changed = await new ResearchStore(io).read(id)
  assert.deepEqual(changed.checks[0], {
    check: changed.task.checks[0], currentGoal: true, currentSource: true,
    currentDependencies: null, currentMaterials: true, snapshotIntact: false, applicableToRecordedInputs: true,
  })
  assert.equal(changed.task.checks[0].outcome, 'verified')
  assert.equal(io.files.get(taskPath(id)).content, persisted)
  io.files.delete(snapshotPath)
  const missing = await store.read(id)
  assert.equal(missing.checks[0].snapshotIntact, false)
  assert.equal(missing.checks[0].applicableToRecordedInputs, true)
  assert.equal(missing.task.checks[0].outcome, 'verified')
})

test('reads rehash the recorded material even if the task revision did not change', async () => {
  const { io, store, id, claim } = await setup()
  await store.attachCheck(id, claim.id, receipt(id, claim))
  io.put('draft.md', '另一份原稿')
  assert.equal((await store.read(id)).checks[0].currentMaterials, false)
  io.files.delete('draft.md')
  const missing = await store.read(id)
  assert.equal(missing.checks[0].currentMaterials, false)
  assert.equal(missing.task.currentRevision, 1)
  assert.equal(missing.task.checks[0].outcome, 'verified')
})

test('a late verifier receipt may attach to its historical claim after a goal revision', async () => {
  const { store, id, claim } = await setup()
  await store.revise(id, 1, { ...initial, goal: '新的研究目标', reason: '用户更新' })
  const historical = await store.attachCheck(id, claim.id, receipt(id, claim))
  assert.equal(historical.task.checks[0].revision, 1)
  assert.equal(historical.task.currentRevision, 2)
  assert.equal(historical.checks[0].currentSource, true)
  assert.equal(historical.checks[0].currentMaterials, true)
  assert.equal(historical.checks[0].currentGoal, false)
  assert.equal(historical.checks[0].applicableToRecordedInputs, false)
})

test('failed checks remain failures even when all recorded inputs are still current', async () => {
  const { store, id, claim } = await setup()
  const view = await store.attachCheck(id, claim.id, receipt(id, claim, {
    outcome: 'compile_error', actualType: null,
    commands: [{ command: 'lean', args: ['proof.lean'], cwd: 'D:/test-workspace', exitCode: 1, stdoutFile: 'logs/failed.stdout', stderrFile: 'logs/failed.stderr' }],
  }))
  assert.equal(view.checks[0].applicableToRecordedInputs, true)
  assert.equal(view.checks[0].check.outcome, 'compile_error')
  assert.equal(Object.hasOwn(view.task, 'status'), false)
  assert.equal(Object.hasOwn(view.task.claims[0], 'verified'), false)
})

test('stale goal revisions fail explicitly without writing over new progress', async () => {
  const { io, store, id } = await setup()
  await store.revise(id, 1, { ...initial, reason: '新请求' })
  const content = io.files.get(taskPath(id)).content
  const beforeWrites = io.writes.length
  await assert.rejects(store.revise(id, 1, { ...initial, reason: '旧请求' }), hasCode('REVISION_CONFLICT'))
  await assert.rejects(store.addClaim(id, 1, claimInput), hasCode('REVISION_CONFLICT'))
  await assert.rejects(store.addNote(id, 1, { text: '过时', nextStep: '过时' }), hasCode('REVISION_CONFLICT'))
  assert.equal(io.writes.length, beforeWrites)
  assert.equal(io.files.get(taskPath(id)).content, content)
})

test('concurrent appends use opaque CAS and one caller receives a conflict, never silent data loss', async () => {
  const { io, id } = await setup()
  const originalClaimCount = JSON.parse(io.files.get(taskPath(id)).content).claims.length
  let release
  const gate = new Promise(resolve => { release = resolve })
  let waiting = 0
  io.beforeWrite = async (_path, _content, version) => {
    assert.equal(typeof version, 'string')
    assert.match(version, /^opaque!\d+\|\nbackend$/)
    waiting += 1
    if (waiting === 2) { io.beforeWrite = null; release() }
    await gate
  }
  const results = await Promise.allSettled([
    new ResearchStore(io).addClaim(id, 1, { ...claimInput, statement: '并发研究甲' }),
    new ResearchStore(io).addClaim(id, 1, { ...claimInput, statement: '并发研究乙' }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failed = results.find(result => result.status === 'rejected')
  assert.equal(failed.reason.code, 'WRITE_CONFLICT')
  const saved = (await new ResearchStore(io).read(id)).task
  assert.equal(saved.claims.length, originalClaimCount + 1)
  assert.equal(saved.claims.filter(claim => claim.statement.startsWith('并发研究')).length, 1)
  // The caller can deliberately reread/retry; the store never retries a blind overwrite.
  await new ResearchStore(io).addNote(id, 1, { text: '已看到竞争结果', nextStep: '重新安排剩余研究' })
  assert.equal((await new ResearchStore(io).read(id)).task.notes.length, 1)
})

test('create-if-absent never replaces a task when the backend refuses creation', async () => {
  const io = new MemoryIO()
  io.put('draft.md', 'draft')
  io.put('.dsh/math/tasks/existing.json', 'existing bytes')
  io.write = async (_path, _content, version) => {
    assert.equal(version, null)
    throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
  }
  await assert.rejects(new ResearchStore(io).create(initial), hasCode('WRITE_CONFLICT'))
  assert.equal(io.files.get('.dsh/math/tasks/existing.json').content, 'existing bytes')
})

test('unsafe paths, nonexistent material and invented model status are rejected before storage', async () => {
  const io = new MemoryIO()
  io.put('draft.md', 'draft')
  const store = new ResearchStore(io)
  for (const path of ['../secret', 'a/../../secret', '/absolute', 'C:\\absolute', '\\\\server\\share', 'x:stream', 'a//b', 'CON.txt', 'a/./b', 'a/']) {
    await assert.rejects(store.create({ ...initial, materials: [path] }), hasCode('INVALID_INPUT'), path)
  }
  await assert.rejects(store.create({ ...initial, materials: ['missing.md'] }), hasCode('MATERIAL_NOT_FOUND'))
  await assert.rejects(store.create({ ...initial, verified: true }), hasCode('INVALID_INPUT'))
  assert.equal(io.writes.length, 0)
  const created = await store.create(initial)
  await assert.rejects(store.addClaim(created.task.id, 1, { ...claimInput, verified: true }), hasCode('INVALID_INPUT'))
  await assert.rejects(store.addClaim(created.task.id, 1, { ...claimInput, id: 'overwrite-existing' }), hasCode('INVALID_INPUT'))
  await assert.rejects(store.read('../outside'), hasCode('INVALID_INPUT'))
})

test('normalizes relative Windows separators while retaining the exact material contents', async () => {
  const io = new MemoryIO()
  io.put('notes/original.md', ' A\r\nB\n')
  const created = await new ResearchStore(io).create({ ...initial, materials: ['notes\\original.md'] })
  assert.deepEqual(created.task.revisions[0].materials, [{ path: 'notes/original.md', sha256: sha256(' A\r\nB\n') }])
})

test('cannot attach an unbound, incomplete or internally forged verified receipt', async () => {
  const { io, store, id, claim } = await setup()
  const original = io.files.get(taskPath(id)).content
  const invalidReceipts = [
    { actualType: null }, { commands: [] }, { axioms: ['sorryAx'] },
    { sourceSha256: sha256('different source') }, { expectedType: 'False' },
    { revision: 2 }, { taskId: 'another-task' }, { semanticCorrespondence: 'certified' },
    { sourcePath: '../proof.lean' }, { sourceSnapshot: '../snapshot.lean' }, { verified: true },
    { commands: [{ command: 'lean', args: [], cwd: 'D:/test-workspace', exitCode: 1, stdoutFile: 'log.out', stderrFile: 'log.err' }] },
  ]
  for (const override of invalidReceipts) {
    await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim, override)), hasCode('INVALID_CHECK'))
  }
  assert.equal(io.files.get(taskPath(id)).content, original)
  const saved = await store.attachCheck(id, claim.id, receipt(id, claim))
  await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim)), hasCode('INVALID_CHECK'))
  assert.equal((await store.read(id)).task.checks.length, 1)
  assert.equal(saved.task.claims[0].formalType, claim.formalType)
})

test('verified requires the actual snapshot file and its contents must match the recorded digest', async () => {
  const { io, store, id, claim } = await setup()
  const original = io.files.get(taskPath(id)).content
  io.files.delete(snapshotPath)
  await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim)), hasCode('INVALID_CHECK'))
  io.put(snapshotPath, 'not the compiled source')
  await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim)), hasCode('INVALID_CHECK'))
  await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim, {
    sourceSnapshot: '', sourceSha256: '',
  })), hasCode('INVALID_CHECK'))
  assert.equal(io.files.get(taskPath(id)).content, original)
  assert.equal((await store.read(id)).task.checks.length, 0)
  io.put(snapshotPath, proofSource)
  const accepted = await store.attachCheck(id, claim.id, receipt(id, claim))
  assert.equal(accepted.checks[0].snapshotIntact, true)
})

test('failures before snapshot creation persist an explicitly empty path/hash pair without becoming success', async () => {
  const { io, store, id, claim } = await setup()
  io.files.delete(snapshotPath)
  for (const outcome of ['environment_error', 'cancelled', 'timeout']) {
    const view = await store.attachCheck(id, claim.id, receipt(id, claim, {
      id: `check-${outcome}`, outcome, actualType: null, commands: [], toolchain: '',
      sourceSnapshot: '', sourceSha256: '', message: 'Stopped before a source snapshot was saved.',
    }))
    const current = view.checks.at(-1)
    assert.equal(current.check.outcome, outcome)
    assert.equal(current.snapshotIntact, false)
    assert.equal(current.currentSource, false)
    assert.equal(current.applicableToRecordedInputs, false)
  }
  const reopened = await new ResearchStore(io).read(id)
  assert.equal(reopened.task.checks.length, 3)
  assert.equal(reopened.task.checks.some(check => check.outcome === 'verified'), false)
  for (const incomplete of [{ sourceSnapshot: '' }, { sourceSha256: '' }]) {
    await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim, {
      id: 'check-incomplete', outcome: 'environment_error', actualType: null, commands: [],
      ...incomplete,
    })), hasCode('INVALID_CHECK'))
  }
  assert.equal((await store.read(id)).task.checks.length, 3)
})

test('a failed receipt may retain a planned snapshot path even if that file was never created', async () => {
  const { io, store, id, claim } = await setup()
  io.files.delete(snapshotPath)
  const view = await store.attachCheck(id, claim.id, receipt(id, claim, {
    outcome: 'environment_error', actualType: null, commands: [], toolchain: '',
    message: 'The snapshot write failed.',
  }))
  assert.equal(view.task.checks[0].sourceSnapshot, snapshotPath)
  assert.equal(view.task.checks[0].outcome, 'environment_error')
  assert.equal(view.checks[0].snapshotIntact, false)
  assert.equal(view.checks[0].currentSource, true)
  assert.equal(view.checks[0].applicableToRecordedInputs, true)
  assert.equal(Object.hasOwn(view.task, 'verified'), false)
})

test('accepts a verifier-reported actual type without pretending string equality checks Lean equivalence', async () => {
  const { store, id, claim } = await setup()
  const view = await store.attachCheck(id, claim.id, receipt(id, claim, { actualType: '(True)' }))
  assert.equal(view.task.checks[0].actualType, '(True)')
  assert.equal(view.task.checks[0].expectedType, 'True')
  assert.equal(view.task.checks[0].semanticCorrespondence, 'not_automatically_certified')
})

test('validates persisted JSON instead of repairing absent fields or accepting invented authority', async t => {
  const { io, id } = await setup()
  const valid = JSON.parse(io.files.get(taskPath(id)).content)
  const variants = [
    ['missing history', value => { delete value.notes }],
    ['unknown status', value => { value.verified = true }],
    ['wrong schema', value => { value.schemaVersion = 2 }],
    ['id/path mismatch', value => { value.id = 'a-different-task' }],
    ['noncontiguous revisions', value => { value.revisions[0].number = 2 }],
    ['future claim', value => { value.claims[0].revision = 9 }],
    ['missing formal type', value => { delete value.claims[0].formalType }],
    ['unsafe stored material', value => { value.revisions[0].materials[0].path = '../outside.md' }],
    ['duplicate claim', value => { value.claims.push(structuredClone(value.claims[0])) }],
  ]
  for (const [label, change] of variants) {
    await t.test(label, async () => {
      const damaged = structuredClone(valid)
      change(damaged)
      io.put(taskPath(id), JSON.stringify(damaged))
      await assert.rejects(new ResearchStore(io).read(id), hasCode('INVALID_STATE'))
    })
  }
  io.put(taskPath(id), '{broken')
  await assert.rejects(new ResearchStore(io).read(id), hasCode('INVALID_STATE'))
})

test('backend read errors remain execution errors, not fabricated current/missing flags', async () => {
  const { io, store, id, claim } = await setup()
  await store.attachCheck(id, claim.id, receipt(id, claim))
  io.failRead = 'draft.md'
  await assert.rejects(store.read(id), hasCode('READ_FAILED'))
  io.failRead = null
  assert.equal((await store.read(id)).checks[0].currentMaterials, true)
})

test('list accepts basename listings but rejects invalid JSON task entries', async () => {
  const { io, store, id } = await setup()
  io.list = async () => [`${id}.json`]
  assert.equal((await store.list())[0].id, id)
  io.list = async () => ['../outside.json']
  await assert.rejects(store.list(), hasCode('INVALID_STATE'))
  io.list = async () => ['task-missing.json']
  await assert.rejects(store.list(), hasCode('TASK_NOT_FOUND'))
})

function sourceManifest() {
  return [{ path: 'proof.lean', sha256: sha256(proofSource), snapshot: snapshotPath }]
}

function addDependency(io, name = 'Local/Lemma.lean', source = 'theorem supporting : True := True.intro\n') {
  const snapshot = `snapshots/${name}`
  io.put(name, source)
  io.put(snapshot, source)
  return { path: name, sha256: sha256(source), snapshot }
}

test('legacy receipts retain their exact shape and report untracked dependencies without a storage migration', async () => {
  const { io, store, id, claim } = await setup()
  await store.attachCheck(id, claim.id, receipt(id, claim))
  const before = io.files.get(taskPath(id)).content
  const writes = io.writes.length
  const view = await new ResearchStore(io).read(id)
  assert.equal(view.checks[0].currentDependencies, null)
  assert.equal(view.checks[0].applicableToRecordedInputs, true)
  assert.equal(Object.hasOwn(view.task.checks[0], 'sourceFiles'), false)
  assert.equal(io.files.get(taskPath(id)).content, before)
  assert.equal(io.writes.length, writes)
  const extended = await store.addNote(id, 1, { text: '保留此前证据', nextStep: '继续判断新目标' })
  assert.equal(extended.task.schemaVersion, 1)
  assert.equal(Object.hasOwn(extended.task.checks[0], 'sourceFiles'), false)
})

test('dependency edits and deletion invalidate current inputs even when the primary source and registered materials are unchanged', async () => {
  const { io, store, id, claim } = await setup()
  const dependency = addDependency(io)
  const sourceFiles = [...sourceManifest(), dependency]
  const attached = await store.attachCheck(id, claim.id, receipt(id, claim, { sourceFiles }))
  assert.equal(attached.checks[0].currentDependencies, true)
  assert.equal(attached.checks[0].applicableToRecordedInputs, true)
  const persisted = io.files.get(taskPath(id)).content
  io.put(dependency.path, 'theorem supporting : False := by sorry\n')
  const changed = await new ResearchStore(io).read(id)
  assert.equal(changed.checks[0].currentSource, true)
  assert.equal(changed.checks[0].currentMaterials, true)
  assert.equal(changed.checks[0].currentDependencies, false)
  assert.equal(changed.checks[0].snapshotIntact, true)
  assert.equal(changed.checks[0].applicableToRecordedInputs, false)
  assert.equal(changed.task.checks[0].outcome, 'verified')
  assert.equal(io.files.get(taskPath(id)).content, persisted)
  io.files.delete(dependency.path)
  assert.equal((await store.read(id)).checks[0].currentDependencies, false)
})

test('tracked primary source changes remain distinct from dependencies and a new goal preserves exact historical proof evidence', async () => {
  const { io, store, id, claim } = await setup()
  const attached = await store.attachCheck(id, claim.id, receipt(id, claim, { sourceFiles: sourceManifest() }))
  assert.equal(attached.checks[0].currentDependencies, true)
  const savedCheck = structuredClone(attached.task.checks[0])
  const revised = await store.revise(id, 1, { ...initial, goal: '在旧引理上新增一个目标', reason: '用户继续研究' })
  assert.equal(revised.checks[0].currentGoal, false)
  assert.equal(revised.checks[0].currentSource, true)
  assert.equal(revised.checks[0].currentDependencies, true)
  assert.equal(revised.checks[0].snapshotIntact, true)
  assert.equal(revised.checks[0].applicableToRecordedInputs, false)
  assert.deepEqual(revised.task.checks[0], savedCheck)
  io.put('proof.lean', 'theorem changed : True := True.intro\n')
  const changed = await store.read(id)
  assert.equal(changed.checks[0].currentSource, false)
  assert.equal(changed.checks[0].currentDependencies, true)
  assert.equal(changed.checks[0].snapshotIntact, true)
})

test('every dependency snapshot is required for verified attachment and contributes to archived evidence integrity', async () => {
  const { io, store, id, claim } = await setup()
  const dependency = addDependency(io)
  const check = receipt(id, claim, { sourceFiles: [...sourceManifest(), dependency] })
  const snapshotContent = io.files.get(dependency.snapshot).content
  io.files.delete(dependency.snapshot)
  await assert.rejects(store.attachCheck(id, claim.id, check), hasCode('INVALID_CHECK'))
  io.put(dependency.snapshot, 'a different snapshot')
  await assert.rejects(store.attachCheck(id, claim.id, check), hasCode('INVALID_CHECK'))
  assert.equal((await store.read(id)).task.checks.length, 0)
  io.put(dependency.snapshot, snapshotContent)
  const attached = await store.attachCheck(id, claim.id, check)
  assert.equal(attached.checks[0].snapshotIntact, true)
  io.put(dependency.snapshot, 'a damaged archive')
  const changed = await store.read(id)
  assert.equal(changed.checks[0].snapshotIntact, false)
  assert.equal(changed.checks[0].currentDependencies, true)
  assert.equal(changed.checks[0].applicableToRecordedInputs, true)
  assert.equal(changed.task.checks[0].outcome, 'verified')
  io.files.delete(dependency.snapshot)
  assert.equal((await store.read(id)).checks[0].snapshotIntact, false)
})

test('source manifests reject incomplete records, unsafe or aliased paths and invented authority before attachment', async () => {
  const { io, store, id, claim } = await setup()
  const [primary] = sourceManifest()
  const dependency = addDependency(io)
  const invalidManifests = [
    undefined, null, {}, [], [null], [dependency],
    [{ ...primary, sha256: 'not-a-hash' }],
    [{ ...primary, sha256: sha256('a different primary source') }],
    [{ ...primary, snapshot: 'snapshots/a-different-primary.lean' }],
    [{ ...primary, path: '../proof.lean' }],
    [primary, { ...dependency, snapshot: '../outside.lean' }],
    [primary, { ...dependency, verified: true }],
    [primary, dependency, { ...dependency }],
    [primary, dependency, { ...dependency, path: 'Local\\Lemma.lean', snapshot: 'snapshots/other.lean' }],
    [primary, dependency, { ...dependency, path: 'local/lemma.lean', snapshot: 'snapshots/other.lean' }],
    [primary, dependency, { ...dependency, path: 'Local/Other.lean', snapshot: 'SNAPSHOTS/local/lemma.LEAN' }],
  ]
  for (const sourceFiles of invalidManifests) {
    await assert.rejects(store.attachCheck(id, claim.id, receipt(id, claim, { sourceFiles })), hasCode('INVALID_CHECK'))
  }
  assert.equal((await store.read(id)).task.checks.length, 0)
  const accepted = await store.attachCheck(id, claim.id, receipt(id, claim, { sourceFiles: [primary, dependency] }))
  assert.deepEqual(accepted.task.checks[0].sourceFiles, [primary, dependency])
})

test('persisted source manifests are validated without losing legacy strictness', async () => {
  const { io, store, id, claim } = await setup()
  const attached = await store.attachCheck(id, claim.id, receipt(id, claim, { sourceFiles: sourceManifest() }))
  for (const mutate of [
    check => { check.sourceFiles = [] },
    check => { check.sourceFiles[0].snapshot = '../outside.lean' },
    check => { delete check.sourceFiles[0].sha256 },
    check => { check.currentDependencies = true },
  ]) {
    const damaged = structuredClone(attached.task)
    mutate(damaged.checks[0])
    io.put(taskPath(id), JSON.stringify(damaged))
    await assert.rejects(new ResearchStore(io).read(id), hasCode('INVALID_STATE'))
  }
})

test('POSIX workspaces retain distinct case-sensitive local module paths', async () => {
  const { io, id, claim } = await setup()
  io.root = '/test-workspace'
  const upper = addDependency(io, 'Local/Result.lean')
  const lower = addDependency(io, 'Local/result.lean', 'theorem another : True := True.intro\n')
  const view = await new ResearchStore(io).attachCheck(id, claim.id, receipt(id, claim, {
    sourceFiles: [...sourceManifest(), upper, lower],
  }))
  assert.equal(view.checks[0].currentDependencies, true)
  assert.equal(view.checks[0].snapshotIntact, true)
  assert.equal(view.checks[0].applicableToRecordedInputs, true)
})

test('dependency read failures stay execution errors and failed snapshot receipts never become successful evidence', async () => {
  const { io, store, id, claim } = await setup()
  const dependency = addDependency(io)
  const sourceFiles = [...sourceManifest(), dependency]
  await store.attachCheck(id, claim.id, receipt(id, claim, { sourceFiles }))
  io.failRead = dependency.path
  await assert.rejects(store.read(id), hasCode('READ_FAILED'))
  io.failRead = null
  io.files.delete(dependency.snapshot)
  const failed = await store.attachCheck(id, claim.id, receipt(id, claim, {
    id: 'check-failed-snapshot', outcome: 'environment_error', actualType: null, commands: [], sourceFiles,
  }))
  assert.equal(failed.checks.at(-1).snapshotIntact, false)
  assert.equal(failed.checks.at(-1).currentDependencies, true)
  assert.equal(failed.checks.at(-1).check.outcome, 'environment_error')
})

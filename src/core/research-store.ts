import { createHash, randomUUID } from 'node:crypto'
import type {
  CheckOutcome, MathClaim, MaterialSnapshot, NewClaimInput, NewTaskInput, ResearchTask,
  ReviseTaskInput, TaskView, VerificationRecord, WorkspaceIO,
} from '../contracts.js'

const TASK_DIRECTORY = '.dsh/math/tasks'
const ROLES = new Set(['target', 'lemma', 'counterexample', 'conditional', 'observation'])
const OUTCOMES = new Set<CheckOutcome>([
  'verified', 'compile_error', 'target_mismatch', 'unaccepted_axioms', 'environment_error',
  'source_changed', 'cancelled', 'timeout',
])
const CONFLICT_CODES = new Set([
  'VERSION_CONFLICT', 'VERSION_MISMATCH', 'CAS_CONFLICT', 'CAS_MISMATCH', 'WRITE_CONFLICT',
  'WORKSPACE_CONFLICT', 'PRECONDITION_FAILED', 'CONFLICT', 'EEXIST', 'ALREADY_EXISTS',
])

export class ResearchStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'ResearchStoreError'
    this.code = code
  }
}

export interface TaskSummary {
  id: string
  currentRevision: number
  request: string
  goal: string
  createdAt: string
  claimCount: number
  noteCount: number
  checkCount: number
}

type ObjectRecord = Record<string, unknown>
type ValidationCode = 'INVALID_INPUT' | 'INVALID_STATE' | 'INVALID_CHECK'

function invalid(code: ValidationCode, detail: string): never {
  throw new ResearchStoreError(code, detail)
}

function object(value: unknown, fields: readonly string[], label: string, code: ValidationCode, optionalFields: readonly string[] = []): ObjectRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(code, `${label} must be an object`)
  const result = value as ObjectRecord
  const keys = Object.keys(result)
  if (keys.some(key => !fields.includes(key) && !optionalFields.includes(key)) || fields.some(key => !Object.hasOwn(result, key))) {
    invalid(code, `${label} must contain exactly: ${fields.join(', ')}${optionalFields.length ? `; optional: ${optionalFields.join(', ')}` : ''}`)
  }
  return result
}

function text(value: unknown, label: string, code: ValidationCode, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0)) invalid(code, `${label} must be ${empty ? 'a string' : 'a nonempty string'}`)
  return value
}

function array(value: unknown, label: string, code: ValidationCode): unknown[] {
  if (!Array.isArray(value)) invalid(code, `${label} must be an array`)
  return value
}

function texts(value: unknown, label: string, code: ValidationCode, emptyItems = false): string[] {
  const items = array(value, label, code)
  for (const item of items) text(item, label, code, emptyItems)
  return items as string[]
}

function identifier(value: unknown, label: string, code: ValidationCode): string {
  const result = text(value, label, code)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result)) {
    invalid(code, `${label} is not a safe identifier`)
  }
  return result
}

/** Backend-relative paths only; never resolve through the host filesystem. */
function relativePath(value: unknown, label: string, code: ValidationCode): string {
  const result = text(value, label, code).replaceAll('\\', '/')
  if (/^[\/]/.test(result) || /[\u0000-\u001f\u007f<>:"|?*]/.test(result)) invalid(code, `${label} must be a safe workspace-relative path`)
  for (const component of result.split('/')) {
    if (component.length === 0 || component === '.' || component === '..' || /[. ]$/.test(component)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)) {
      invalid(code, `${label} must not contain traversal, empty or reserved path components`)
    }
  }
  return result
}

function positiveInteger(value: unknown, label: string, code: ValidationCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(code, `${label} must be a positive safe integer`)
  return value
}

function timestamp(value: unknown, label: string, code: ValidationCode): string {
  const result = text(value, label, code)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) {
    invalid(code, `${label} must be an ISO timestamp with a timezone`)
  }
  return result
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function digest(value: unknown, label: string, code: ValidationCode): string {
  const result = text(value, label, code)
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(code, `${label} must be a lowercase SHA-256 digest`)
  return result
}

function unique(values: string[], label: string, code: ValidationCode): void {
  if (new Set(values).size !== values.length) invalid(code, `${label} must be unique`)
}

function pathIdentity(value: string, caseInsensitivePaths: boolean): string {
  const normalized = value.replaceAll('\\', '/')
  return caseInsensitivePaths ? normalized.toLowerCase() : normalized
}

function validateCheck(value: unknown, task: ResearchTask, code: ValidationCode, caseInsensitivePaths: boolean): VerificationRecord {
  const check = object(value, [
    'id', 'taskId', 'claimId', 'revision', 'sourcePath', 'sourceSha256', 'sourceSnapshot',
    'declaration', 'expectedType', 'actualType', 'axioms', 'outcome', 'message', 'toolchain',
    'commands', 'startedAt', 'completedAt', 'semanticCorrespondence',
  ], 'check', code, ['sourceFiles'])
  identifier(check.id, 'check.id', code)
  identifier(check.taskId, 'check.taskId', code)
  identifier(check.claimId, 'check.claimId', code)
  positiveInteger(check.revision, 'check.revision', code)
  const sourcePath = relativePath(check.sourcePath, 'check.sourcePath', code)
  const sourceSha256 = text(check.sourceSha256, 'check.sourceSha256', code, true)
  const snapshot = text(check.sourceSnapshot, 'check.sourceSnapshot', code, true)
  if ((sourceSha256 === '') !== (snapshot === '')) invalid(code, 'check snapshot path and hash must both be present or both be empty')
  if (snapshot !== '') {
    relativePath(snapshot, 'check.sourceSnapshot', code)
    digest(sourceSha256, 'check.sourceSha256', code)
  }
  if (Object.hasOwn(check, 'sourceFiles')) {
    const sourceFiles = array(check.sourceFiles, 'check.sourceFiles', code)
    if (sourceFiles.length === 0) invalid(code, 'check.sourceFiles must include the primary source')
    const paths: string[] = [], snapshots: string[] = []
    let primary: ObjectRecord | undefined
    for (const value of sourceFiles) {
      const file = object(value, ['path', 'sha256', 'snapshot'], 'source file snapshot', code)
      const filePath = relativePath(file.path, 'source file.path', code)
      const fileSnapshot = relativePath(file.snapshot, 'source file.snapshot', code)
      digest(file.sha256, 'source file.sha256', code)
      paths.push(pathIdentity(filePath, caseInsensitivePaths))
      snapshots.push(pathIdentity(fileSnapshot, caseInsensitivePaths))
      if (pathIdentity(filePath, caseInsensitivePaths) === pathIdentity(sourcePath, caseInsensitivePaths)) primary = file
    }
    unique(paths, 'check.sourceFiles paths', code)
    unique(snapshots, 'check.sourceFiles snapshot paths', code)
    if (!primary || primary.sha256 !== sourceSha256
      || pathIdentity(primary.snapshot as string, caseInsensitivePaths) !== pathIdentity(snapshot, caseInsensitivePaths)) {
      invalid(code, 'check.sourceFiles must contain the matching primary source path, hash and snapshot')
    }
  }
  text(check.declaration, 'check.declaration', code)
  text(check.expectedType, 'check.expectedType', code)
  if (check.actualType !== null) text(check.actualType, 'check.actualType', code)
  const axioms = texts(check.axioms, 'check.axioms', code)
  if (typeof check.outcome !== 'string' || !OUTCOMES.has(check.outcome as CheckOutcome)) invalid(code, 'check.outcome is unsupported')
  text(check.message, 'check.message', code, true)
  text(check.toolchain, 'check.toolchain', code, true)
  timestamp(check.startedAt, 'check.startedAt', code)
  timestamp(check.completedAt, 'check.completedAt', code)
  if (Date.parse(check.completedAt as string) < Date.parse(check.startedAt as string)) invalid(code, 'check completion precedes its start')
  if (check.semanticCorrespondence !== 'not_automatically_certified') invalid(code, 'a check cannot automatically certify prose correspondence')
  const commands = array(check.commands, 'check.commands', code)
  for (const value of commands) {
    const command = object(value, ['command', 'args', 'cwd', 'exitCode', 'stdoutFile', 'stderrFile'], 'command evidence', code)
    text(command.command, 'command.command', code)
    texts(command.args, 'command.args', code, true)
    text(command.cwd, 'command.cwd', code)
    if (command.exitCode !== null && (typeof command.exitCode !== 'number' || !Number.isSafeInteger(command.exitCode))) invalid(code, 'command.exitCode must be an integer or null')
    relativePath(command.stdoutFile, 'command.stdoutFile', code)
    relativePath(command.stderrFile, 'command.stderrFile', code)
  }
  const claim = task.claims.find(item => item.id === check.claimId)
  if (check.taskId !== task.id || !claim || check.revision !== claim.revision) invalid(code, 'check must reference this task and the recorded claim revision')
  if (claim.formalType === null || check.expectedType !== claim.formalType) invalid(code, 'check expectedType must equal the recorded claim formalType')
  if (check.outcome === 'verified') {
    if (snapshot === '' || check.actualType === null || commands.length === 0 || commands.some(item => (item as ObjectRecord).exitCode !== 0)
      || axioms.includes('sorryAx') || (check.toolchain as string).trim().length === 0) {
      invalid(code, 'verified requires a snapshot path/hash, an actual type, successful command evidence, a toolchain, and no sorryAx')
    }
  }
  return value as VerificationRecord
}

/** Reject damaged or invented state rather than silently upgrading/migrating it. */
function validateTask(value: unknown, expectedId: string, caseInsensitivePaths: boolean): ResearchTask {
  const code = 'INVALID_STATE'
  const task = object(value, ['schemaVersion', 'id', 'createdAt', 'currentRevision', 'revisions', 'claims', 'notes', 'checks'], 'task', code)
  if (task.schemaVersion !== 1) invalid(code, 'unsupported task schemaVersion')
  if (identifier(task.id, 'task.id', code) !== expectedId) invalid(code, 'task id does not match its storage path')
  timestamp(task.createdAt, 'task.createdAt', code)
  const revision = positiveInteger(task.currentRevision, 'task.currentRevision', code)
  const revisions = array(task.revisions, 'task.revisions', code)
  if (revisions.length !== revision) invalid(code, 'revisions must be a complete contiguous history')
  for (const [index, value] of revisions.entries()) {
    const item = object(value, ['number', 'request', 'goal', 'assumptions', 'materials', 'reason', 'createdAt'], 'revision', code)
    if (item.number !== index + 1) invalid(code, 'revision numbers must be contiguous')
    text(item.request, 'revision.request', code)
    text(item.goal, 'revision.goal', code)
    texts(item.assumptions, 'revision.assumptions', code)
    text(item.reason, 'revision.reason', code)
    timestamp(item.createdAt, 'revision.createdAt', code)
    const paths: string[] = []
    for (const value of array(item.materials, 'revision.materials', code)) {
      const material = object(value, ['path', 'sha256'], 'material snapshot', code)
      paths.push(relativePath(material.path, 'material.path', code))
      digest(material.sha256, 'material.sha256', code)
    }
    unique(paths, 'revision material paths', code)
  }
  if ((revisions[0] as ObjectRecord).createdAt !== task.createdAt) invalid(code, 'task creation and first revision timestamps differ')
  const claims = array(task.claims, 'task.claims', code)
  const claimIds: string[] = []
  for (const value of claims) {
    const claim = object(value, ['id', 'revision', 'statement', 'formalType', 'role', 'conditions', 'createdAt'], 'claim', code)
    claimIds.push(identifier(claim.id, 'claim.id', code))
    if (positiveInteger(claim.revision, 'claim.revision', code) > revision) invalid(code, 'claim revision does not exist')
    text(claim.statement, 'claim.statement', code)
    if (claim.formalType !== null) text(claim.formalType, 'claim.formalType', code)
    if (typeof claim.role !== 'string' || !ROLES.has(claim.role)) invalid(code, 'claim.role is unsupported')
    texts(claim.conditions, 'claim.conditions', code)
    timestamp(claim.createdAt, 'claim.createdAt', code)
  }
  unique(claimIds, 'claim ids', code)
  const noteIds: string[] = []
  for (const value of array(task.notes, 'task.notes', code)) {
    const note = object(value, ['id', 'revision', 'text', 'nextStep', 'createdAt'], 'note', code)
    noteIds.push(identifier(note.id, 'note.id', code))
    if (positiveInteger(note.revision, 'note.revision', code) > revision) invalid(code, 'note revision does not exist')
    text(note.text, 'note.text', code)
    text(note.nextStep, 'note.nextStep', code)
    timestamp(note.createdAt, 'note.createdAt', code)
  }
  unique(noteIds, 'note ids', code)
  const checkIds: string[] = []
  for (const value of array(task.checks, 'task.checks', code)) {
    const check = validateCheck(value, task as unknown as ResearchTask, code, caseInsensitivePaths)
    checkIds.push(check.id)
  }
  unique(checkIds, 'check ids', code)
  return value as ResearchTask
}

function goalInput(value: unknown, revised: boolean): NewTaskInput {
  const input = object(value, ['request', 'goal', 'assumptions', 'materials', ...(revised ? ['reason'] : [])], 'goal input', 'INVALID_INPUT')
  const materials = texts(input.materials, 'materials', 'INVALID_INPUT').map(path => relativePath(path, 'material path', 'INVALID_INPUT'))
  unique(materials, 'material paths', 'INVALID_INPUT')
  if (revised) text(input.reason, 'reason', 'INVALID_INPUT')
  return {
    request: text(input.request, 'request', 'INVALID_INPUT'),
    goal: text(input.goal, 'goal', 'INVALID_INPUT'),
    assumptions: [...texts(input.assumptions, 'assumptions', 'INVALID_INPUT')],
    materials,
  }
}

/** Append-only research history. Only the host's verifier integration may call attachCheck. */
export class ResearchStore {
  private readonly caseInsensitivePaths: boolean

  constructor(private readonly io: WorkspaceIO) {
    this.caseInsensitivePaths = /^[a-z]:[\\/]|^\\\\/i.test(io.root)
  }

  async create(input: NewTaskInput): Promise<TaskView> {
    const goal = goalInput(input, false)
    const materials = await this.snapshot(goal.materials)
    const now = new Date().toISOString()
    const task: ResearchTask = {
      schemaVersion: 1, id: `task-${randomUUID()}`, createdAt: now, currentRevision: 1,
      revisions: [{ number: 1, ...goal, materials, reason: 'Initial request', createdAt: now }],
      claims: [], notes: [], checks: [],
    }
    await this.save(task, null)
    return this.view(task)
  }

  async list(): Promise<TaskSummary[]> {
    let entries: string[]
    try { entries = await this.io.list(TASK_DIRECTORY) }
    catch (cause) { throw new ResearchStoreError('LIST_FAILED', 'Could not list stored research tasks', cause) }
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) invalid('INVALID_STATE', 'task directory listing must contain paths')
    const ids: string[] = []
    for (const entry of entries) {
      const path = relativePath(entry, 'listed task path', 'INVALID_STATE')
      if (!path.endsWith('.json')) continue
      const filename = path.startsWith(`${TASK_DIRECTORY}/`) ? path.slice(TASK_DIRECTORY.length + 1) : path
      if (filename.includes('/')) invalid('INVALID_STATE', 'listed task path is outside the flat task directory')
      ids.push(identifier(filename.slice(0, -5), 'listed task id', 'INVALID_STATE'))
    }
    unique(ids, 'listed task ids', 'INVALID_STATE')
    const tasks = await Promise.all(ids.map(async id => (await this.load(id)).task))
    return tasks.map(task => {
      const current = task.revisions[task.currentRevision - 1]!
      return {
        id: task.id, currentRevision: task.currentRevision, request: current.request, goal: current.goal,
        createdAt: task.createdAt, claimCount: task.claims.length, noteCount: task.notes.length, checkCount: task.checks.length,
      }
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
  }

  async read(taskId: string): Promise<TaskView> {
    return this.view((await this.load(taskId)).task)
  }

  async revise(taskId: string, expectedRevision: number, input: ReviseTaskInput): Promise<TaskView> {
    const goal = goalInput(input, true)
    return this.change(taskId, expectedRevision, async task => {
      const materials = await this.snapshot(goal.materials)
      task.currentRevision += 1
      task.revisions.push({ number: task.currentRevision, ...goal, materials, reason: input.reason, createdAt: new Date().toISOString() })
    })
  }

  async addClaim(taskId: string, revision: number, input: NewClaimInput): Promise<TaskView> {
    const value = object(input, ['statement', 'formalType', 'role', 'conditions'], 'claim input', 'INVALID_INPUT')
    const statement = text(value.statement, 'statement', 'INVALID_INPUT')
    const formalType = value.formalType === null ? null : text(value.formalType, 'formalType', 'INVALID_INPUT')
    if (typeof value.role !== 'string' || !ROLES.has(value.role)) invalid('INVALID_INPUT', 'claim role is unsupported')
    const conditions = [...texts(value.conditions, 'conditions', 'INVALID_INPUT')]
    return this.change(taskId, revision, task => {
      task.claims.push({ id: `claim-${randomUUID()}`, revision, statement, formalType, role: input.role, conditions, createdAt: new Date().toISOString() })
    })
  }

  async addNote(taskId: string, revision: number, input: { text: string; nextStep: string }): Promise<TaskView> {
    const value = object(input, ['text', 'nextStep'], 'note input', 'INVALID_INPUT')
    const noteText = text(value.text, 'note.text', 'INVALID_INPUT')
    const nextStep = text(value.nextStep, 'note.nextStep', 'INVALID_INPUT')
    return this.change(taskId, revision, task => {
      task.notes.push({ id: `note-${randomUUID()}`, revision, text: noteText, nextStep, createdAt: new Date().toISOString() })
    })
  }

  /** Persists a trusted verifier receipt; validation alone is not proof of its authenticity. */
  async attachCheck(taskId: string, claimId: string, record: VerificationRecord): Promise<TaskView> {
    identifier(claimId, 'claimId', 'INVALID_INPUT')
    return this.change(taskId, null, async task => {
      if (!task.claims.some(claim => claim.id === claimId)) throw new ResearchStoreError('CLAIM_NOT_FOUND', `Claim not found: ${claimId}`)
      const checked = validateCheck(record, task, 'INVALID_CHECK', this.caseInsensitivePaths)
      if (checked.claimId !== claimId) invalid('INVALID_CHECK', 'check claimId does not match the requested claim')
      if (task.checks.some(check => check.id === checked.id)) invalid('INVALID_CHECK', 'check id already exists; historical receipts cannot be overwritten')
      const saved = {
        ...checked, axioms: [...checked.axioms], commands: checked.commands.map(command => ({ ...command, args: [...command.args] })),
        ...(checked.sourceFiles === undefined ? {} : { sourceFiles: checked.sourceFiles.map(file => ({ ...file })) }),
      }
      if (saved.outcome === 'verified') {
        const sources = saved.sourceFiles ?? [{ path: saved.sourcePath, sha256: saved.sourceSha256, snapshot: saved.sourceSnapshot }]
        for (const file of sources) {
          const snapshot = await this.readText(relativePath(file.snapshot, 'source file.snapshot', 'INVALID_CHECK'))
          if (snapshot === null || hash(snapshot.content) !== file.sha256) {
            invalid('INVALID_CHECK', `verified snapshot file is missing or does not match its recorded digest: ${file.snapshot}`)
          }
        }
      }
      task.checks.push(saved)
    })
  }

  private async change(taskId: string, revision: number | null, mutate: (task: ResearchTask) => void | Promise<void>): Promise<TaskView> {
    if (revision !== null) positiveInteger(revision, 'expected revision', 'INVALID_INPUT')
    const { task, version } = await this.load(taskId)
    if (revision !== null && revision !== task.currentRevision) {
      throw new ResearchStoreError('REVISION_CONFLICT', `Expected goal revision ${revision}; current revision is ${task.currentRevision}. Read the task before updating it.`)
    }
    await mutate(task)
    validateTask(task, taskId, this.caseInsensitivePaths)
    await this.save(task, version)
    return this.view(task)
  }

  private async readText(path: string): Promise<{ content: string; version: string } | null> {
    let stored
    try { stored = await this.io.read(path) }
    catch (cause) { throw new ResearchStoreError('READ_FAILED', `Could not read workspace path: ${path}`, cause) }
    if (stored !== null && (typeof stored !== 'object' || typeof stored.content !== 'string' || typeof stored.version !== 'string')) {
      invalid('INVALID_STATE', `WorkspaceIO returned invalid text/version for ${path}`)
    }
    return stored
  }

  private async load(taskId: string): Promise<{ task: ResearchTask; version: string }> {
    identifier(taskId, 'taskId', 'INVALID_INPUT')
    const stored = await this.readText(`${TASK_DIRECTORY}/${taskId}.json`)
    if (stored === null) throw new ResearchStoreError('TASK_NOT_FOUND', `Research task not found: ${taskId}`)
    let parsed: unknown
    try { parsed = JSON.parse(stored.content) }
    catch (cause) { throw new ResearchStoreError('INVALID_STATE', `Stored task is not valid JSON: ${taskId}`, cause) }
    return { task: validateTask(parsed, taskId, this.caseInsensitivePaths), version: stored.version }
  }

  private async save(task: ResearchTask, version: string | null): Promise<void> {
    validateTask(task, task.id, this.caseInsensitivePaths)
    try { await this.io.write(`${TASK_DIRECTORY}/${task.id}.json`, `${JSON.stringify(task, null, 2)}\n`, version) }
    catch (cause) {
      const conflict = typeof cause === 'object' && cause !== null && 'code' in cause && CONFLICT_CODES.has(String(cause.code))
      throw new ResearchStoreError(conflict ? 'WRITE_CONFLICT' : 'WRITE_FAILED', conflict
        ? 'Task storage version changed or the task already exists. Read again; no overwrite retry was performed.'
        : 'Task write was not acknowledged by the workspace backend; no overwrite retry was performed.', cause)
    }
  }

  private async snapshot(paths: string[]): Promise<MaterialSnapshot[]> {
    return Promise.all(paths.map(async path => {
      const stored = await this.readText(path)
      if (stored === null) throw new ResearchStoreError('MATERIAL_NOT_FOUND', `Material not found: ${path}`)
      return { path, sha256: hash(stored.content) }
    }))
  }

  private async view(task: ResearchTask): Promise<TaskView> {
    const currentReads = new Map<string, Promise<string | null>>()
    const currentHash = (path: string): Promise<string | null> => {
      const normalized = relativePath(path, 'recorded path', 'INVALID_STATE')
      let pending = currentReads.get(normalized)
      if (!pending) {
        pending = this.readText(normalized).then(stored => stored === null ? null : hash(stored.content))
        currentReads.set(normalized, pending)
      }
      return pending
    }
    const checks = await Promise.all(task.checks.map(async check => {
      const revision = task.revisions[check.revision - 1]!
      const currentGoal = check.revision === task.currentRevision
      const currentSource = (await currentHash(check.sourcePath)) === check.sourceSha256
      const currentDependencies = check.sourceFiles === undefined ? null : (await Promise.all(check.sourceFiles
        .filter(file => pathIdentity(file.path, this.caseInsensitivePaths) !== pathIdentity(check.sourcePath, this.caseInsensitivePaths))
        .map(async file => (await currentHash(file.path)) === file.sha256))).every(Boolean)
      const currentMaterials = (await Promise.all(revision.materials.map(async material =>
        (await currentHash(material.path)) === material.sha256))).every(Boolean)
      const snapshotIntact = check.sourceFiles === undefined
        ? check.sourceSnapshot !== '' && (await currentHash(check.sourceSnapshot)) === check.sourceSha256
        : (await Promise.all(check.sourceFiles.map(async file => (await currentHash(file.snapshot)) === file.sha256))).every(Boolean)
      return { check, currentGoal, currentSource, currentDependencies, currentMaterials, snapshotIntact,
        applicableToRecordedInputs: currentGoal && currentSource && currentDependencies !== false && currentMaterials }
    }))
    return { task, checks }
  }
}

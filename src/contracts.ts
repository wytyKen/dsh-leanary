/** Shared prototype contracts. A formal check certifies a claim, never a whole research goal. */
export interface StoredText {
  content: string
  /** Opaque backend version, passed back unchanged on replacement. */
  version: string
}

/** One calling workspace; implementations must preserve its policy and cancellation. */
export interface WorkspaceIO {
  readonly root: string
  read(relativePath: string): Promise<StoredText | null>
  /** null means create-if-absent; a version means replace-if-version. */
  write(relativePath: string, content: string, expectedVersion: string | null): Promise<void>
  list(relativeDirectory: string): Promise<string[]>
}

export interface ProcessRequest {
  command: string
  args: string[]
  cwd: string
  /** Extra environment only; do not explicitly forward the host's secrets. */
  env: Record<string, string>
  signal: AbortSignal
  timeoutMs: number
}

export interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  aborted: boolean
  timedOut: boolean
}

export type CommandRunner = (request: ProcessRequest) => Promise<ProcessResult>

export interface MaterialSnapshot {
  path: string
  sha256: string
}

export interface TaskRevision {
  number: number
  request: string
  goal: string
  /** Active mathematical hypotheses for this revision; earlier goals and methods belong in notes. */
  assumptions: string[]
  materials: MaterialSnapshot[]
  reason: string
  createdAt: string
}

export type ClaimRole = 'target' | 'lemma' | 'counterexample' | 'conditional' | 'observation'

export interface MathClaim {
  id: string
  revision: number
  statement: string
  /** Full closed Lean type proposed by the agent; natural-language fidelity is not automatic. */
  formalType: string | null
  role: ClaimRole
  conditions: string[]
  createdAt: string
}

export interface ProgressNote {
  id: string
  revision: number
  text: string
  nextStep: string
  createdAt: string
}

export type CheckOutcome = 'verified' | 'compile_error' | 'target_mismatch' | 'unaccepted_axioms'
  | 'environment_error' | 'source_changed' | 'cancelled' | 'timeout'

export interface CommandEvidence {
  command: string
  args: string[]
  cwd: string
  exitCode: number | null
  stdoutFile: string
  stderrFile: string
}

/** One workspace source included in an immutable local-module build. */
export interface SourceFileSnapshot {
  path: string
  sha256: string
  snapshot: string
}

export interface VerificationRecord {
  id: string
  taskId: string
  claimId: string
  revision: number
  sourcePath: string
  sourceSha256: string
  /** Workspace-relative archived source path; empty only for a failure before snapshot creation. */
  sourceSnapshot: string
  /** Main source and discovered workspace imports. Absent on legacy single-source receipts. */
  sourceFiles?: SourceFileSnapshot[]
  declaration: string
  expectedType: string
  actualType: string | null
  axioms: string[]
  outcome: CheckOutcome
  message: string
  toolchain: string
  commands: CommandEvidence[]
  startedAt: string
  completedAt: string
  /** No automated assertion that the Lean type faithfully expresses the user's prose. */
  semanticCorrespondence: 'not_automatically_certified'
}

export interface ResearchTask {
  schemaVersion: 1
  id: string
  createdAt: string
  currentRevision: number
  revisions: TaskRevision[]
  claims: MathClaim[]
  notes: ProgressNote[]
  checks: VerificationRecord[]
}

export interface CheckApplicability {
  check: VerificationRecord
  currentGoal: boolean
  currentSource: boolean
  /** Match of recorded local dependency contents; null means a legacy receipt did not track them. */
  currentDependencies: boolean | null
  currentMaterials: boolean
  /** Whether every recorded source snapshot still exists with its recorded content hash. */
  snapshotIntact: boolean
  /** Applicability to recorded goal/source inputs; not a new Lean execution. */
  applicableToRecordedInputs: boolean
}

export interface TaskView {
  task: ResearchTask
  checks: CheckApplicability[]
}

export interface NewTaskInput {
  request: string
  goal: string
  assumptions: string[]
  materials: string[]
}

export interface ReviseTaskInput extends NewTaskInput {
  reason: string
}

export interface NewClaimInput {
  statement: string
  formalType: string | null
  role: ClaimRole
  conditions: string[]
}

export interface VerifyRequest {
  taskId: string
  claimId: string
  revision: number
  sourcePath: string
  declaration: string
  expectedType: string
}

export interface VerifierOptions {
  io: WorkspaceIO
  run: CommandRunner
  signal: AbortSignal
  leanCommand: string
  leanArgs: string[]
  timeoutMs: number
  allowedAxioms: string[]
}

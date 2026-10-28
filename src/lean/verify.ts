import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  CheckOutcome, CommandEvidence, ProcessResult, SourceFileSnapshot, StoredText, VerificationRecord, VerifierOptions, VerifyRequest,
} from '../contracts.js'
import { buildProbe, parseProbe } from './probe.js'
import { buildImportParser, parseImports } from './imports.js'

const standardAxioms = new Set(['propext', 'Quot.sound', 'Classical.choice'])
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function sourceRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || /[\u0000-\u001f«»<>:"|?*]/u.test(normalized) || normalized.startsWith('/')
    || normalized.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/u.test(p)) || !normalized.endsWith('.lean')
    || normalized.endsWith('/.lean') || normalized === '.lean') {
    throw new Error('sourcePath must be a workspace-relative .lean path without traversal.')
  }
  return normalized
}

function importedSourcePath(parts: string[]): string {
  if (parts.some(part => /[\\/]/u.test(part))) throw new Error('Import name components must not contain path separators.')
  return sourceRelativePath(parts.join('/') + '.lean')
}

class StopVerification extends Error {
  constructor(readonly outcome: CheckOutcome, message: string) { super(message) }
}

/** Verify one recorded formal claim. This does not certify its correspondence to human prose. */
export async function verifyLean(request: VerifyRequest, options: VerifierOptions): Promise<VerificationRecord> {
  const id = randomUUID()
  const directory = `.dsh/math/checks/${id}`
  const startedAt = new Date().toISOString()
  const deadline = Date.now() + options.timeoutMs
  const commands: CommandEvidence[] = []
  let hasSnapshot = false
  let changed = false
  let sourcePath: string | null = null
  const sourceFiles: SourceFileSnapshot[] = []
  const foldedPaths = /^[a-z]:[\\/]|^[\\/]{2}/iu.test(options.io.root)
  const pathKey = (value: string): string => foldedPaths ? value.toLowerCase() : value
  const record: VerificationRecord = {
    id, taskId: request.taskId, claimId: request.claimId, revision: request.revision,
    sourcePath: request.sourcePath, sourceSha256: '', sourceSnapshot: '', declaration: request.declaration,
    expectedType: request.expectedType, actualType: null, axioms: [], outcome: 'environment_error',
    message: '', toolchain: '', commands, startedAt, completedAt: startedAt,
    semanticCorrespondence: 'not_automatically_certified',
  }
  const absolute = (relative: string): string => {
    const root = path.resolve(options.io.root)
    const resolved = path.resolve(root, ...relative.split('/'))
    const within = path.relative(root, resolved)
    if (path.isAbsolute(within) || within === '..' || within.startsWith('..' + path.sep)) throw new Error('Path escaped the calling workspace.')
    return resolved
  }
  const write = (relative: string, content: string): Promise<void> => options.io.write(relative, content, null)
  const checkpoint = (): void => {
    if (options.signal.aborted) throw new StopVerification('cancelled', 'Verification cancelled.')
    if (Date.now() >= deadline) throw new StopVerification('timeout', 'Verification time budget exhausted.')
  }
  const inspectCurrentSource = async (): Promise<void> => {
    if (!sourcePath || !hasSnapshot) return
    // Applicability is about source content. Sandboxing may change metadata/version tokens
    // without changing the text; the immutable compiled snapshot still represents that text.
    for (const file of sourceFiles) {
      const current = await options.io.read(file.path)
      if (!current || hash(current.content) !== file.sha256) changed = true
    }
  }
  const run = async (stage: string, args: string[], cwd: string, env: Record<string, string>): Promise<ProcessResult> => {
    checkpoint()
    const evidence: CommandEvidence = {
      command: options.leanCommand, args: [...options.leanArgs, ...args], cwd, exitCode: null,
      stdoutFile: `${directory}/${stage}.stdout.txt`, stderrFile: `${directory}/${stage}.stderr.txt`,
    }
    commands.push(evidence)
    let result: ProcessResult
    try {
      result = await options.run({
        command: evidence.command, args: evidence.args, cwd, env, signal: options.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      })
    } catch (error) {
      const failure = options.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        ? new StopVerification('cancelled', 'Verification cancelled during command execution.')
        : error instanceof Error && error.name === 'TimeoutError'
          ? new StopVerification('timeout', error.message)
          : new StopVerification('environment_error', `Command execution failed: ${errorText(error)}`)
      try {
        await write(evidence.stdoutFile, '')
        await write(evidence.stderrFile, errorText(error))
      } catch (archiveError) {
        failure.message += ` Could not archive command output: ${errorText(archiveError)}`
      }
      throw failure
    }
    evidence.exitCode = result.exitCode
    let archiveError: unknown
    try {
      await write(evidence.stdoutFile, result.stdout)
      await write(evidence.stderrFile, result.stderr)
    } catch (error) { archiveError = error }
    const archiveMessage = archiveError === undefined ? '' : ` Could not archive command output: ${errorText(archiveError)}`
    if (result.timedOut) throw new StopVerification('timeout', 'Lean command timed out.' + archiveMessage)
    if (result.aborted || options.signal.aborted) throw new StopVerification('cancelled', 'Verification cancelled.' + archiveMessage)
    if (archiveError !== undefined) throw archiveError
    await inspectCurrentSource()
    if (changed) throw new StopVerification('source_changed', 'A source or local dependency changed after its recorded snapshot; the result is not a check of the current files.')
    checkpoint()
    return result
  }

  try {
    checkpoint()
    if (!path.isAbsolute(options.io.root) || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0
      || !options.leanCommand || !request.declaration.trim() || !request.expectedType.trim()) {
      throw new Error('Invalid verifier options, declaration, or expected type.')
    }
    sourcePath = sourceRelativePath(request.sourcePath)
    record.sourcePath = sourcePath
    const original = await options.io.read(sourcePath)
    if (!original) throw new Error('Source file does not exist in the calling workspace.')
    record.sourceSha256 = hash(original.content)
    record.sourceSnapshot = `${directory}/snapshot/${sourcePath}`
    sourceFiles.push({ path: sourcePath, sha256: record.sourceSha256, snapshot: record.sourceSnapshot })
    await write(record.sourceSnapshot, original.content)
    hasSnapshot = true
    record.sourceFiles = sourceFiles
    const sourceRoot = absolute(`${directory}/snapshot`)
    // Never resolve project imports through ambient LEAN_PATH or pre-existing .olean files.
    // Local dependencies are rebuilt solely from the archived sources; other libraries come
    // from the configured toolchain. The parser itself cannot be shadowed by local Lean.lean.
    const isolatedEnv = { LEAN_PATH: sourceRoot }
    // An empty LEAN_PATH has cwd semantics in Lean 4.22. Use an explicit unused
    // path under this fresh check instead; builtin toolchain search still follows it.
    const parserEnv = { LEAN_PATH: absolute(`${directory}/helper-library`) }
    const version = await run('version', ['--version'], sourceRoot, parserEnv)
    if (version.exitCode !== 0 || !/^Lean \(version 4\./mu.test(version.stdout)) {
      throw new StopVerification('environment_error', 'The configured command did not report an available Lean 4 toolchain.')
    }
    record.toolchain = version.stdout.trim()
    const importNonce = randomBytes(24).toString('hex')
    const parser = buildImportParser(importNonce)
    const parserPath = `${directory}/imports.lean`
    await write(parserPath, parser.source)
    const discovered = new Map<string, SourceFileSnapshot>([[pathKey(sourcePath), sourceFiles[0]!]])
    const states = new Map<string, 'visiting' | 'done'>()
    const buildOrder: SourceFileSnapshot[] = []
    let reservedRoots: Set<string> | undefined
    let parseIndex = 0
    const visit = async (file: SourceFileSnapshot): Promise<void> => {
      checkpoint()
      const key = pathKey(file.path)
      if (states.get(key) === 'visiting') throw new StopVerification('environment_error', `Cyclic local imports include ${file.path}.`)
      if (states.get(key) === 'done') return
      states.set(key, 'visiting')
      const snapshot = absolute(file.snapshot)
      const parsed = await run(`imports-${parseIndex++}`, ['--run', absolute(parserPath), snapshot], absolute(directory), parserEnv)
      if (parsed.exitCode !== 0) throw new StopVerification('environment_error', 'The Lean header parser failed; no target was certified.')
      const header = parseImports(parsed.stdout, parsed.stderr, parser.marker, importNonce, snapshot)
      const nextRoots = new Set(header.reservedRoots.map(pathKey))
      if (reservedRoots && (reservedRoots.size !== nextRoots.size || [...reservedRoots].some(root => !nextRoots.has(root)))) {
        throw new StopVerification('environment_error', 'The toolchain library roots changed while discovering imports.')
      }
      reservedRoots = nextRoots
      if (reservedRoots.has(pathKey(file.path.split('/')[0]!.replace(/\.lean$/u, '')))) {
        throw new StopVerification('environment_error', `Local source ${file.path} uses a reserved toolchain module root. Shadowing toolchain modules is not supported.`)
      }
      if (header.hasErrors) throw new StopVerification('compile_error', `Lean rejected the import header of ${file.path}.`)
      for (const imported of header.imports) {
        checkpoint()
        if (reservedRoots.has(pathKey(imported.parts[0]!))) {
          if (!imported.builtin) throw new StopVerification('environment_error', `Toolchain module ${imported.parts.join('.')} is unavailable.`)
          continue
        }
        const relative = importedSourcePath(imported.parts)
        const dependencyKey = pathKey(relative)
        let dependency = discovered.get(dependencyKey)
        if (dependency && dependency.path !== relative) {
          throw new StopVerification('environment_error', `Local imports use conflicting path case aliases: ${dependency.path} and ${relative}.`)
        }
        if (!dependency) {
          const input: StoredText | null = await options.io.read(relative)
          if (!input) {
            throw new StopVerification('environment_error', `Local import ${imported.parts.join('.')} requires workspace source ${relative}. External package paths and existing .olean files are not used by this verifier.`)
          }
          dependency = { path: relative, sha256: hash(input.content), snapshot: `${directory}/snapshot/${relative}` }
          discovered.set(dependencyKey, dependency)
          sourceFiles.push(dependency)
          await write(dependency.snapshot, input.content)
        }
        await visit(dependency)
      }
      states.set(key, 'done')
      buildOrder.push(file)
    }
    await visit(sourceFiles[0]!)
    for (let index = 0; index < buildOrder.length; index++) {
      const file = buildOrder[index]!
      const snapshot = absolute(file.snapshot)
      const olean = snapshot.slice(0, -'.lean'.length) + '.olean'
      const compiled = await run(file.path === sourcePath ? 'compile' : `compile-dependency-${index}`, [`--root=${sourceRoot}`, '-o', olean, snapshot], sourceRoot, isolatedEnv)
      if (compiled.exitCode === null) throw new StopVerification('environment_error', 'Lean compilation did not return an exit code.')
      if (compiled.exitCode !== 0) throw new StopVerification('compile_error', `The snapshot ${file.path} did not compile; see the recorded compiler output.`)
    }
    const nonce = randomBytes(24).toString('hex')
    const probe = buildProbe({
      moduleParts: sourcePath.slice(0, -'.lean'.length).split('/'),
      declaration: request.declaration, expectedType: request.expectedType, nonce,
    })
    const probePath = `${directory}/probe.lean`
    await write(probePath, probe.source)
    const probed = await run('probe', [absolute(probePath)], absolute(directory), isolatedEnv)
    if (probed.exitCode !== 0) throw new StopVerification('environment_error', 'The Lean inspection probe failed; no target was certified.')
    const payload = parseProbe(probed.stdout, probed.stderr, probe.marker, nonce, request.declaration)
    record.actualType = payload.actualType
    record.axioms = [...new Set(payload.axioms)].sort()
    if (payload.status === 'target_error') {
      throw new StopVerification('target_mismatch', `The recorded formal_type could not be elaborated in the inspection context. Use fully qualified custom names and explicit binders; source-local namespace, open and notation settings are not assumed. Lean: ${payload.message}`)
    }
    if (payload.status !== 'ok' || !payload.matches || !payload.closed || !payload.actualProp || !payload.expectedProp) {
      throw new StopVerification('target_mismatch', payload.message || 'The declaration is not definitionally equal to the closed expected proposition.')
    }
    const configured = new Set(options.allowedAxioms.filter(name => standardAxioms.has(name)))
    const rejected = record.axioms.filter(name => name === 'sorryAx' || !configured.has(name))
    if (rejected.length) throw new StopVerification('unaccepted_axioms', `Unaccepted transitive axioms: ${rejected.join(', ')}.`)
    record.outcome = 'verified'
    record.message = 'The snapshot declaration matches the closed expected proposition and the configured axiom policy. Correspondence to natural-language intent is not automatically certified.'
  } catch (error) {
    record.outcome = error instanceof StopVerification ? error.outcome : 'environment_error'
    record.message = errorText(error)
  }

  try {
    await inspectCurrentSource()
    if (changed && record.outcome !== 'cancelled' && record.outcome !== 'timeout') {
      record.outcome = 'source_changed'
      record.message = 'A source or local dependency changed after its recorded snapshot; this record does not verify the current files.'
    }
  } catch (error) {
    if (record.outcome === 'verified') {
      record.outcome = 'environment_error'
      record.message = `Could not confirm the current source: ${errorText(error)}`
    }
  }
  record.completedAt = new Date().toISOString()
  try {
    await write(`${directory}/record.json`, JSON.stringify(record, null, 2) + '\n')
  } catch (error) {
    if (record.outcome !== 'cancelled' && record.outcome !== 'timeout') record.outcome = 'environment_error'
    record.message += ` Could not archive the verification record: ${errorText(error)}`
  }
  return record
}

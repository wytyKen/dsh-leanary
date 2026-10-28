import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { classifyRunnerFailure } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CommandRunner, ProcessResult, WorkspaceIO } from '../contracts.js'

export interface HostServices {
  fs: FileSystem
  workingDirectory: Pick<WorkingDirectoryService, 'get'>
  sandboxPolicy: Pick<SandboxPolicyService, 'resolve'>
  sandbox: SandboxProvider
  subprocess: SubprocessRuntime
}

export class HostAdapterError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HostAdapterError' }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

/** A fresh binding per tool call; no cached root or policy from another session. */
export class NativeWorkspaceIO implements WorkspaceIO {
  readonly root: string
  constructor(private readonly fs: FileSystem, private readonly rootTarget: FsTarget,
    private readonly policy: SandboxExecutionPolicy, private readonly signal: AbortSignal) {
    this.root = fs.processPath(rootTarget)
  }

  async target(file: string): Promise<FsTarget> {
    this.signal.throwIfAborted()
    if (!file || file.includes('\0')) throw new HostAdapterError('INVALID_PATH', 'A workspace path is required.')
    const target = await this.fs.resolve(file, { cwd: this.root, signal: this.signal })
    if (!this.fs.contains(this.rootTarget, target)) throw new HostAdapterError('PATH_OUTSIDE_WORKSPACE', 'The path escapes the calling workspace.')
    return target
  }

  async read(file: string) {
    const target = await this.target(file), before = await this.fs.stat(target, this.signal)
    if (!before) return null
    if (before.type !== 'file') throw new HostAdapterError('NOT_A_FILE', 'Expected a regular workspace text file.')
    try {
      const content = await this.fs.readText(target, this.signal), after = await this.fs.stat(target, this.signal)
      if (!after || after.version !== before.version) throw new HostAdapterError('VERSION_CONFLICT', 'The file changed while it was read.')
      return { content, version: before.version }
    } catch (error) { if (errorCode(error) === 'FS_NOT_FOUND') return null; throw error }
  }

  async write(file: string, content: string, expectedVersion: string | null): Promise<void> {
    const target = await this.target(file)
    try {
      await this.fs.writeText(target, content, expectedVersion === null ? { kind: 'createIfAbsent' }
        : { kind: 'replaceIfVersion', version: expectedVersion as FsVersion }, this.signal, this.policy)
    } catch (error) {
      if (['FS_STALE_VERSION', 'FS_NOT_OBSERVED'].includes(errorCode(error) ?? '')) throw new HostAdapterError('VERSION_CONFLICT', 'The workspace file changed; reread before updating it.')
      throw error
    }
  }

  async list(directory: string): Promise<string[]> {
    const target = await this.target(directory), info = await this.fs.stat(target, this.signal)
    if (!info) return []
    if (info.type !== 'directory') throw new HostAdapterError('NOT_A_DIRECTORY', 'Expected a workspace directory.')
    const entries = await this.fs.listDir(target, this.signal)
    const paths = /^[a-z]:[\\/]|^\\\\/i.test(this.root) ? path.win32 : path.posix
    return entries.filter(entry => entry.type === 'file' && this.fs.contains(this.rootTarget, entry.target))
      .map(entry => paths.relative(this.root, this.fs.processPath(entry.target)).replaceAll('\\', '/')).sort()
  }
}

export interface HostBinding { io: NativeWorkspaceIO; run: CommandRunner; policy: SandboxExecutionPolicy }

export async function bindHostCall(ctx: HostServices | Context, exec: Pick<ToolRunContext, 'agent' | 'signal'>): Promise<HostBinding> {
  exec.signal.throwIfAborted()
  const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
  const cwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : policy.workspaceRoot
  const root = await ctx.fs.resolve(cwd, { signal: exec.signal }), info = await ctx.fs.stat(root, exec.signal)
  if (info?.type !== 'directory') throw new HostAdapterError('WORKSPACE_UNAVAILABLE', 'The calling workspace directory is unavailable.')
  if (policy.mode === 'workspace-write') {
    const boundary = await ctx.fs.resolve(policy.workspaceRoot, { signal: exec.signal })
    if (!ctx.fs.contains(boundary, root)) throw new HostAdapterError('WORKSPACE_OUTSIDE_POLICY', 'Current directory is outside the session write boundary.')
  }
  const io = new NativeWorkspaceIO(ctx.fs, root, policy, exec.signal)
  const run: CommandRunner = async request => {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647) throw new HostAdapterError('INVALID_TIMEOUT', 'A finite positive process timeout is required.')
    const directory = await io.target(request.cwd), cwdInfo = await ctx.fs.stat(directory, exec.signal)
    if (cwdInfo?.type !== 'directory') throw new HostAdapterError('WORKSPACE_UNAVAILABLE', 'Process directory is unavailable.')
    const timeout = new AbortController()
    let timedOut = false
    const signal = AbortSignal.any([exec.signal, request.signal, timeout.signal])
    let child: SubprocessHandle | undefined
    const collected = () => {
      const stdout = child?.collected.stdout?.readFrom(0), stderr = child?.collected.stderr?.readFrom(0)
      if (stdout?.lossy || stderr?.lossy) throw new HostAdapterError('OUTPUT_TRUNCATED', 'Process output exceeded the evidence capture limit.')
      return { stdout: stdout?.text ?? '', stderr: stderr?.text ?? '' }
    }
    const timer = setTimeout(() => { timedOut = true; timeout.abort(new Error('Verification process timed out.')) }, request.timeoutMs)
    try {
      signal.throwIfAborted()
      const executable = await ctx.subprocess.resolveExecutable(request.command, request.env, signal)
      const argv = [executable, ...request.args]
      const wrapped = policy.mode === 'danger-full-access' ? null : await ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)
      child = ctx.subprocess.spawn({ argv: wrapped?.argv ?? argv, cwd: ctx.fs.processPath(directory), env: { ...request.env }, signal, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4_194_304 }, stderr: { maxBytes: 4_194_304 } } })
      const outcome = await child.done
      await child.waitForExit()
      const output = collected()
      if (wrapped) {
        const failure = classifyRunnerFailure(outcome.exitCode, output.stderr, wrapped.runnerFailureRules)
        if (failure) throw new HostAdapterError('SANDBOX_EXECUTION_FAILED', failure.detail)
      }
      return { ...output, exitCode: outcome.exitCode, aborted: signal.aborted && !timedOut, timedOut }
    } catch (error) {
      if (child) { child.terminate(); await child.waitForExit() }
      if (signal.aborted) return { ...collected(), exitCode: null, aborted: !timedOut, timedOut } satisfies ProcessResult
      throw error
    } finally { clearTimeout(timer) }
  }
  return { io, run, policy }
}

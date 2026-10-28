import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ResearchStore } from './core/research-store.js'
import { verifyLean } from './lean/verify.js'
import { bindHostCall, HostAdapterError } from './host/adapters.js'
import { RESEARCH_INSTRUCTIONS } from './instructions.js'
import type { ClaimRole } from './contracts.js'

export const name = 'dsh-leanary'
export const inject = ['tools', 'fs', 'workingDirectory', 'sandboxPolicy', 'sandbox', 'subprocess', 'systemPrompt']
export interface Config { leanCommand?: string; leanArgs?: string[]; timeoutMs?: number; allowedAxioms?: string[] }
export const Config = z.object({
  leanCommand: z.string().default('lean'), leanArgs: z.array(z.string()).default([]),
  timeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(60_000),
  allowedAxioms: z.array(z.string()).default(['propext', 'Classical.choice', 'Quot.sound']),
})
type Json = InferValue<{ type: 'json' }>
const json = (value: unknown): Json => value as Json
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: Json) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
const required = (value: string | undefined, field: string): string => {
  if (!value?.trim()) throw new HostAdapterError('INVALID_ARGUMENT', `${field} is required for this action.`)
  return value
}
const revision = (value: number | undefined, field: string): number => {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) throw new HostAdapterError('INVALID_ARGUMENT', `${field} must be a positive revision.`)
  return value as number
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.systemPrompt.section({ name: 'dsh-math:research-workflow', order: 2450, text: RESEARCH_INSTRUCTIONS, interpolate: false })
  ctx.tools.register(defineTool({
    name: 'math_task',
    description: 'Maintain a mathematical research task. Actions: create(request,goal,assumptions?,materials?); list; read(task_id); revise(task_id,expected_revision,request,goal,reason,assumptions?,materials?); claim(task_id,revision,statement,role,formal_type?,conditions?); note(task_id,revision,text,next_step). On revise, assumptions and materials replace the lists; omitted lists are empty. Record only active mathematical hypotheses in assumptions, and historical context or methods in notes. Use fully qualified custom names in formal_type. Historical verified declarations remain evidence for their precise statements; changing the task goal does not refute them or require duplicate registration.',
    parameters: {
      action: { type: 'string', enum: ['create', 'list', 'read', 'revise', 'claim', 'note'], required: true },
      task_id: { type: 'string' }, expected_revision: { type: 'integer' }, revision: { type: 'integer' },
      request: { type: 'string' }, goal: { type: 'string' }, reason: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } }, materials: { type: 'array', items: { type: 'string' } },
      statement: { type: 'string' }, formal_type: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      role: { type: 'string', enum: ['target', 'lemma', 'counterexample', 'conditional', 'observation'] },
      conditions: { type: 'array', items: { type: 'string' } }, text: { type: 'string' }, next_step: { type: 'string' },
    }, output,
    async execute(args, exec) {
      const { io } = await bindHostCall(ctx, exec)
      const store = new ResearchStore(io)
      if (args.action === 'list') return json(await store.list())
      if (args.action === 'create') return json(await store.create({ request: required(args.request, 'request'), goal: required(args.goal, 'goal'), assumptions: args.assumptions ?? [], materials: args.materials ?? [] }))
      const taskId = required(args.task_id, 'task_id')
      if (args.action === 'read') return json(await store.read(taskId))
      if (args.action === 'revise') return json(await store.revise(taskId, revision(args.expected_revision, 'expected_revision'), { request: required(args.request, 'request'), goal: required(args.goal, 'goal'), assumptions: args.assumptions ?? [], materials: args.materials ?? [], reason: required(args.reason, 'reason') }))
      if (args.action === 'claim') return json(await store.addClaim(taskId, revision(args.revision, 'revision'), { statement: required(args.statement, 'statement'), formalType: args.formal_type ?? null, role: required(args.role, 'role') as ClaimRole, conditions: args.conditions ?? [] }))
      return json(await store.addNote(taskId, revision(args.revision, 'revision'), { text: required(args.text, 'text'), nextStep: required(args.next_step, 'next_step') }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'math_verify',
    description: 'Check one Lean declaration against the immutable formal_type and revision of a recorded math_task claim. The expected type is elaborated at top level after importing the source, without its local namespace/open settings; use fully qualified custom names. Snapshot and rebuild supported workspace-local Lean imports without flattening sources. Checks that precise claim only, not automatic correspondence to the prose or completion of the whole task. Historical goal revisions remain historical after a recheck. Uses the caller workspace, sandbox policy and cancellation.',
    parameters: { task_id: { type: 'string', required: true }, claim_id: { type: 'string', required: true }, source_path: { type: 'string', required: true }, declaration: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      const { io, run } = await bindHostCall(ctx, exec)
      const store = new ResearchStore(io), view = await store.read(args.task_id)
      const claim = view.task.claims.find(item => item.id === args.claim_id)
      if (!claim) throw new HostAdapterError('CLAIM_NOT_FOUND', 'The claim does not exist in this task.')
      if (!claim.formalType?.trim()) throw new HostAdapterError('FORMAL_TYPE_REQUIRED', 'Record a complete closed formal_type before requesting Lean verification.')
      const check = await verifyLean({ taskId: view.task.id, claimId: claim.id, revision: claim.revision, sourcePath: args.source_path, declaration: args.declaration, expectedType: claim.formalType }, {
        io, run, signal: exec.signal, leanCommand: config.leanCommand ?? 'lean', leanArgs: config.leanArgs ?? [], timeoutMs: config.timeoutMs ?? 60_000,
        allowedAxioms: config.allowedAxioms ?? ['propext', 'Classical.choice', 'Quot.sound'],
      })
      const attached = await store.attachCheck(view.task.id, claim.id, check)
      const applicability = attached.checks.find(item => item.check.id === check.id)
      return json({ check, applicability: applicability ? { currentGoal: applicability.currentGoal, currentSource: applicability.currentSource, currentDependencies: applicability.currentDependencies, currentMaterials: applicability.currentMaterials, snapshotIntact: applicability.snapshotIntact, applicableToRecordedInputs: applicability.applicableToRecordedInputs } : null })
    },
  }))
}

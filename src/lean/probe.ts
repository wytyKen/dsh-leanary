/** Generate a probe for Lean 4.22's elaborator/kernel environment. No user term is spliced as code. */
export function leanString(value: string): string {
  // JSON's printable strings and standard escapes are also Lean string literals. Forbid the
  // two control escapes which JSON emits but Lean does not use.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new Error('Control characters are not accepted in Lean probe inputs.')
  }
  return JSON.stringify(value)
}

export function buildProbe(input: {
  moduleParts: string[]
  declaration: string
  expectedType: string
  nonce: string
}): { source: string; marker: string } {
  const leanName = (name: string): string => name.split('.').reduce(
    (prefix, part) => `(Lean.Name.str ${prefix} ${leanString(part)})`, 'Lean.Name.anonymous',
  )
  const moduleName = input.moduleParts.map(part => {
    if (!part || /[«»\r\n\u0000]/u.test(part)) throw new Error('Unsupported Lean module path component.')
    return `«${part}»`
  }).join('.')
  const marker = `__DSH_MATH_PROBE_${input.nonce}__`
  const scope = `DshMathProbe_${input.nonce}`
  const source = `import Lean
import ${moduleName}

namespace ${scope}

private def payload (status : String) (actual : Option String) (axioms : Array Lean.Name)
    (typeMatches actualProp expectedProp closed : Bool) (message : String) : Lean.Json :=
  Lean.Json.mkObj [
    ("nonce", Lean.Json.str ${leanString(input.nonce)}),
    ("declaration", Lean.Json.str ${leanString(input.declaration)}),
    ("status", Lean.Json.str status),
    ("actualType", actual.map Lean.Json.str |>.getD Lean.Json.null),
    ("axioms", Lean.Json.arr (axioms.map fun n => Lean.Json.str n.toString)),
    ("matches", Lean.Json.bool typeMatches),
    ("actualProp", Lean.Json.bool actualProp),
    ("expectedProp", Lean.Json.bool expectedProp),
    ("closed", Lean.Json.bool closed),
    ("message", Lean.Json.str message)]

private def closedExpr (e : Lean.Expr) : Bool :=
  !e.hasMVar && !e.hasLevelMVar && !e.hasFVar && !e.hasLooseBVars

run_cmd do
  let result ← Lean.Elab.Command.liftTermElabM do
    let env ← Lean.getEnv
    let name := ${leanName(input.declaration)}
    match env.find? name with
    | none =>
      return payload "missing_declaration" none #[] false false false false "Declaration not found."
    | some info =>
      let actual ← Lean.instantiateMVars info.type
      let actualText ← Lean.withOptions (fun o => o.setBool ${leanName('pp.explicit')} true |>.setBool ${leanName('pp.fullNames')} true) do
        return (← Lean.Meta.ppExpr actual).pretty
      let axioms ← Lean.collectAxioms name
      let actualProp ← Lean.Meta.isProp actual
      unless closedExpr actual && actualProp do
        return payload "target_mismatch" (some actualText) axioms false actualProp false false
          "The declaration must have a closed proposition as its type."
      try
        let stx ← match Lean.Parser.runParserCategory env (Lean.Name.str Lean.Name.anonymous "term") ${leanString(input.expectedType)} with
          | .ok stx => pure stx
          | .error message => throwError "{message}"
        let expected ← Lean.Elab.Term.withoutErrToSorry <| Lean.Elab.Term.withoutAutoBoundImplicit <|
          Lean.Elab.Term.elabType stx
        Lean.Elab.Term.synthesizeSyntheticMVarsNoPostponing
        let expected ← Lean.instantiateMVars expected
        let expectedProp ← Lean.Meta.isProp expected
        unless closedExpr expected && expectedProp do
          return payload "target_mismatch" (some actualText) axioms false actualProp expectedProp false
            "The expected type must be a closed proposition, with no remaining metavariables."
        let sameType ← Lean.Meta.isDefEq actual expected
        Lean.Elab.Term.synthesizeSyntheticMVarsNoPostponing
        let actual ← Lean.instantiateMVars actual
        let expected ← Lean.instantiateMVars expected
        let closed := closedExpr actual && closedExpr expected
        return payload "ok" (some actualText) axioms sameType actualProp expectedProp closed ""
      catch error =>
        return payload "target_error" (some actualText) axioms false actualProp false false
          (← error.toMessageData.toString)
  Lean.logInfo m!"{${leanString(marker)}}{result.compress}"

end ${scope}
`
  return { source, marker }
}

export interface ProbeResult {
  nonce: string
  declaration: string
  status: 'ok' | 'missing_declaration' | 'target_mismatch' | 'target_error'
  actualType: string | null
  axioms: string[]
  matches: boolean
  actualProp: boolean
  expectedProp: boolean
  closed: boolean
  message: string
}

/** A random marker binds this response to this host-created probe, not to source output. */
export function parseProbe(stdout: string, stderr: string, marker: string, nonce: string, declaration: string): ProbeResult {
  const count = (stdout.split(marker).length - 1) + (stderr.split(marker).length - 1)
  if (count !== 1 || stderr.includes(marker)) throw new Error('Expected exactly one probe marker in stdout.')
  const at = stdout.indexOf(marker)
  const line = stdout.slice(at + marker.length).split(/\r?\n/u, 1)[0] ?? ''
  const value: unknown = JSON.parse(line)
  if (!value || typeof value !== 'object') throw new Error('Invalid Lean probe response.')
  const p = value as Record<string, unknown>
  if (p.nonce !== nonce || p.declaration !== declaration
    || !['ok', 'missing_declaration', 'target_mismatch', 'target_error'].includes(String(p.status))
    || !(p.actualType === null || typeof p.actualType === 'string')
    || !Array.isArray(p.axioms) || !p.axioms.every(a => typeof a === 'string')
    || typeof p.matches !== 'boolean' || typeof p.actualProp !== 'boolean'
    || typeof p.expectedProp !== 'boolean' || typeof p.closed !== 'boolean' || typeof p.message !== 'string') {
    throw new Error('Invalid Lean probe payload or host nonce.')
  }
  return p as unknown as ProbeResult
}

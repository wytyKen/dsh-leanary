import { leanString } from './probe.js'

export interface ParsedImport {
  parts: string[]
  builtin: boolean
}

export interface ParsedHeader {
  imports: ParsedImport[]
  reservedRoots: string[]
  hasErrors: boolean
}

/**
 * Lean's own header parser handles comments, prelude, multiline imports and quoted
 * name components. This program parses source text without elaborating it. It is
 * run with an isolated, nonempty LEAN_PATH so the caller's current directory and
 * ambient package paths cannot supply libraries for the parser itself.
 */
export function buildImportParser(nonce: string): { source: string; marker: string } {
  const marker = `__DSH_MATH_IMPORTS_${nonce}__`
  const source = `import Lean

private def moduleParts (n : Lean.Name) : Array Lean.Json :=
  n.components.toArray.map fun part =>
    match part with
    | .str .anonymous s => Lean.Json.str s
    | _ => Lean.Json.null

def main (args : List String) : IO UInt32 := do
  let file := args.head!
  let content ← IO.FS.readFile file
  let (imports, _, messages) ← Lean.Elab.parseImports content (some file)
  for message in messages.toList do
    IO.eprintln (← message.toString)
  let library ← Lean.getLibDir (← Lean.getBuildDir)
  let mut roots : Array Lean.Json := #[]
  for entry in (← library.readDir) do
    if (← entry.path.isDir) then
      roots := roots.push (Lean.Json.str entry.fileName)
    else if entry.path.extension == some "olean" then
      roots := roots.push (Lean.Json.str entry.path.fileStem.get!)
  let mut found : Array Lean.Json := #[]
  for dep in (if messages.hasErrors then #[] else imports) do
    let builtin ← try
      (← Lean.findOLean dep.module).pathExists
    catch _ => pure false
    found := found.push (Lean.Json.mkObj [
      ("parts", Lean.Json.arr (moduleParts dep.module)),
      ("builtin", Lean.Json.bool builtin)])
  let result := Lean.Json.mkObj [
    ("nonce", Lean.Json.str ${leanString(nonce)}),
    ("file", Lean.Json.str file),
    ("imports", Lean.Json.arr found),
    ("reservedRoots", Lean.Json.arr roots),
    ("hasErrors", Lean.Json.bool messages.hasErrors)]
  IO.println (${leanString(marker)} ++ result.compress)
  pure 0
`
  return { source, marker }
}

export function parseImports(
  stdout: string, stderr: string, marker: string, nonce: string, file: string,
): ParsedHeader {
  if ((stdout.split(marker).length - 1) + (stderr.split(marker).length - 1) !== 1 || stderr.includes(marker)) {
    throw new Error('Expected exactly one import-parser marker in stdout.')
  }
  const line = stdout.slice(stdout.indexOf(marker) + marker.length).split(/\r?\n/u, 1)[0] ?? ''
  const value: unknown = JSON.parse(line)
  if (!value || typeof value !== 'object') throw new Error('Invalid import-parser response.')
  const p = value as Record<string, unknown>
  if (p.nonce !== nonce || p.file !== file || typeof p.hasErrors !== 'boolean'
    || !Array.isArray(p.reservedRoots) || p.reservedRoots.length === 0
    || !p.reservedRoots.every(root => typeof root === 'string' && root.length > 0)
    || !Array.isArray(p.imports) || !p.imports.every(entry => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Record<string, unknown>
      return typeof item.builtin === 'boolean' && Array.isArray(item.parts) && item.parts.length > 0
        && item.parts.every(part => typeof part === 'string' && part.length > 0)
    })) {
    throw new Error('Invalid import-parser payload or host nonce.')
  }
  return {
    imports: p.imports as ParsedImport[], reservedRoots: [...new Set(p.reservedRoots as string[])], hasErrors: p.hasErrors,
  }
}

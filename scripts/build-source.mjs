// Export only reviewed source paths into a new local artifact. Never stages Git,
// moves original files, reads ignored run logs, or publishes anything.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const outputParent = path.join(root, 'artifacts/source')
const spec = JSON.parse(await fs.readFile(path.join(root, 'source-release.json'), 'utf8'))
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const files = new Set()

async function target(relative) {
  assert.ok(typeof relative === 'string' && relative && !relative.includes('\\')
    && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe source release path.')
  const full = path.resolve(root, relative)
  const resolved = await fs.realpath(full)
  const inside = path.relative(await fs.realpath(root), resolved)
  assert.ok(inside && !inside.startsWith('..' + path.sep) && inside !== '..' && !path.isAbsolute(inside), 'Source release path escaped the project.')
  assert.equal((await fs.lstat(full)).isSymbolicLink(), false, 'Source release paths cannot be links.')
  return full
}

async function collect(relative) {
  const full = await target(relative)
  for (const entry of await fs.readdir(full, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'A source release tree contains a link.')
    const file = relative + '/' + entry.name
    if (entry.isDirectory()) await collect(file)
    else { assert.equal(entry.isFile(), true); files.add(file) }
  }
}

for (const relative of spec.files) { assert.equal((await fs.stat(await target(relative))).isFile(), true); files.add(relative) }
for (const relative of spec.trees) await collect(relative)

const contents = new Map()
const privatePrefix = os.homedir().replaceAll('\\', '/').toLowerCase()
const projectPrefix = root.replaceAll('\\', '/').toLowerCase()
for (const file of [...files].sort()) {
  assert.ok(!file.split('/').some(part => ['.git', '.dsh', '.cache', 'node_modules', 'dist', 'artifacts'].includes(part)), 'Generated or private path selected.')
  assert.ok(!/\.(?:olean|tgz|zip|log)$|(?:^|\/)\.env(?:\.|$)|credentials/iu.test(file), 'Private/generated file selected.')
  const bytes = await fs.readFile(await target(file)), text = bytes.toString('utf8')
  const normalized = text.replaceAll('\\\\', '\\').replaceAll('\\', '/').toLowerCase()
  assert.ok(!normalized.includes(privatePrefix) && !normalized.includes(projectPrefix), `Machine-specific path selected in ${file}`)
  assert.ok(!/\bsk-[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/u.test(text), `Credential-shaped content selected in ${file}`)
  contents.set(file, bytes)
}
for (const [file, bytes] of contents) {
  if (!file.endsWith('.md')) continue
  for (const link of bytes.toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:|#)/i.test(link[1])) continue
    const linked = path.posix.normalize(path.posix.join(path.posix.dirname(file), link[1].split('#')[0]))
    assert.ok(contents.has(linked), `Unexported documentation link in ${file}: ${link[1]}`)
  }
}
await fs.mkdir(outputParent, { recursive: true })
const build = await fs.mkdtemp(path.join(outputParent, 'candidate-'))
const name = manifest.name.replace(/[^A-Za-z0-9_.-]/g, '-') + '-' + manifest.version + '-source'
const sourceRoot = path.join(build, name)
await fs.mkdir(sourceRoot)
const hashes = {}
for (const [relative, bytes] of contents) {
  const destination = path.join(sourceRoot, relative)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, bytes, { flag: 'wx' })
  hashes[relative] = digest(bytes)
}
const archive = path.join(build, name + '.zip')
const result = spawnSync('tar', ['-a', '-cf', archive, '-C', build, name], { encoding: 'utf8', windowsHide: true, shell: false })
if (result.error) throw result.error
assert.equal(result.status, 0, 'Source ZIP creation failed; original source and candidate directory were preserved.')
const report = { version: manifest.version, sourceRoot, archive, archiveSha256: digest(await fs.readFile(archive)), files: contents.size, hashes,
  scope: 'Reviewed local source candidate. Historical research archives and third-party adaptation experiments remain local.', gitChanged: false, published: false, modelRequests: 0 }
await fs.writeFile(path.join(build, 'source-result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, hashes: undefined }, null, 2))

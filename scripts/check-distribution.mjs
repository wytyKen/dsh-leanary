// Read a prepared package only. This command never packs, installs or extracts files to disk.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const maxBuffer = 8 * 1024 * 1024
const privatePaths = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), os.homedir(), process.env.DSH_RUNTIME, process.env.DSH_HOME]
  .filter(value => typeof value === 'string' && value.length > 1)
  .map(value => value.replaceAll('\\', '/').toLowerCase())
const runtimeModules = ['contracts', 'index', 'instructions', 'core/research-store', 'host/adapters', 'lean/imports', 'lean/probe', 'lean/verify']
const required = [
  'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'docs/QUICKSTART.md', 'docs/DEVELOPMENT.md',
  ...runtimeModules.flatMap(module => [`dist/${module}.js`, `dist/${module}.d.ts`]),
]
const installHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish', 'dependencies']

function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', windowsHide: true, maxBuffer, shell: false })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `tar failed: ${String(result.stderr).trim()}`)
  return result.stdout
}

function allowedFile(relative) {
  if (['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'docs/QUICKSTART.md', 'docs/DEVELOPMENT.md'].includes(relative)) return true
  if (runtimeModules.some(module => ['.js', '.d.ts', '.js.map'].some(extension => relative === `dist/${module}${extension}`))) return true
  return /^examples\/order-bound\/(?:[A-Za-z0-9_-]+\.(?:lean|md)|lean-toolchain)$/u.test(relative)
}

function archiveTarget(target) {
  assert.equal(typeof target, 'string', 'Package entry targets must be strings.')
  assert.ok(target.startsWith('./'), `Package entry must be relative: ${target}`)
  const relative = target.slice(2)
  assert.ok(relative && !relative.includes('\\') && path.posix.normalize(relative) === relative
    && !relative.startsWith('../') && !path.posix.isAbsolute(relative), 'Package entry escaped its root.')
  return 'package/' + relative
}

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Unexpected exports shape.')
  return Object.values(value).flatMap(exportTargets)
}

/** Inventory, entry-point, local-link and accidental-content checks for the actual release tarball. */
export async function checkDistribution(filename) {
  const archive = path.resolve(filename)
  assert.ok(/\.(?:tgz|tar\.gz)$/iu.test(archive), 'Expected a prepared .tgz or .tar.gz package.')
  assert.ok((await fs.stat(archive)).isFile(), 'The archive must be a regular file.')
  const paths = tar(['-tf', archive]).split(/\r?\n/u).filter(Boolean).map(value => value.replace(/^\.\//u, ''))
  assert.ok(paths.length, 'The archive is empty.')
  const seen = new Set()
  for (const item of paths) {
    const relative = item.replace(/\/$/u, '')
    assert.ok(relative === 'package' || relative.startsWith('package/'), 'Archive entries must remain under package/.')
    assert.ok(!item.includes('\\') && !/[\u0000-\u001f]/u.test(item)
      && path.posix.normalize(relative) === relative && !relative.split('/').includes('..'), 'Unsafe archive member path.')
    assert.ok(!seen.has(relative.toLowerCase()), 'Duplicate or case-aliased archive path.')
    seen.add(relative.toLowerCase())
  }
  // Reject links and other special members; reading their targets would not validate install contents.
  for (const line of tar(['-tvf', archive]).split(/\r?\n/u).filter(Boolean)) {
    assert.ok(/^[-d]/u.test(line), 'The distribution must contain only regular files and directories.')
  }
  const files = paths.filter(item => !item.endsWith('/'))
  for (const item of files) assert.ok(allowedFile(item.slice('package/'.length)), `Unexpected distribution member: ${item}`)
  const members = new Set(files)
  for (const item of required) assert.ok(members.has('package/' + item), `Required distribution member is missing: ${item}`)
  assert.ok(files.some(item => /^package\/examples\/order-bound\/.+\.lean$/u.test(item)), 'The trial example must contain Lean source.')
  assert.ok(members.has('package/examples/order-bound/lean-toolchain'), 'The example must pin its Lean toolchain.')
  assert.ok(files.some(item => /^package\/examples\/order-bound\/.+\.md$/u.test(item)), 'The trial example must explain the problem.')

  const contents = new Map(files.map(item => [item, tar(['-xOf', archive, item])]))
  for (const [item, content] of contents) {
    const normalized = content.replaceAll('\\\\', '\\').replaceAll('\\', '/').toLowerCase()
    assert.ok(!/\bsk-[A-Za-z0-9_-]{16,}\b/u.test(content), `Possible API credential in ${item}`)
    assert.ok(!/\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/iu.test(content), `Possible bearer credential in ${item}`)
    assert.ok(!/[?&](?:token|api_key|access_token|auth_token)=[A-Za-z0-9._~+\/%-]{24,}/iu.test(content), `Possible URL credential in ${item}`)
    assert.ok(privatePaths.every(prefix => !normalized.includes(prefix)), `Development-machine path in ${item}`)
  }
  const manifest = JSON.parse(contents.get('package/package.json'))
  assert.equal(manifest.name, 'dsh-leanary')
  assert.equal(manifest.private, true, 'The local trial remains private until the user chooses publication.')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines?.dsh, '0.2.1-rc.3')
  assert.equal(manifest.engines?.node, '>=24.0.0')
  for (const target of [manifest.main, manifest.types, ...exportTargets(manifest.exports), manifest.dsh?.bundle?.patch]) {
    assert.ok(members.has(archiveTarget(target)), `Published entry target is missing: ${target}`)
  }
  for (const hook of installHooks) assert.ok(!manifest.scripts?.[hook], `Unexpected install lifecycle hook: ${hook}`)
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      assert.ok(typeof range === 'string' && !/^(?:file:|link:|workspace:|[A-Za-z]:[\\/]|\.?[\\/])/u.test(range), `Development dependency path in ${group}.${name}`)
    }
  }
  for (const name of ['@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-working-directory']) {
    assert.equal(manifest.peerDependencies?.[name], '0.2.1-rc.3', `Incorrect host peer version: ${name}`)
  }
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/cordis'], '~4.0.5')
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/schemastery'], '~3.18.5')

  let checkedImports = 0, checkedLinks = 0
  for (const [item, content] of contents) {
    if (/\.js$|\.d\.ts$/u.test(item)) {
      for (const match of content.matchAll(/^\s*(?:import|export)\s+(?:[^'";\r\n]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/gmu)) {
        const target = match[2]
        if (target.startsWith('.')) {
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(item), target))
          assert.ok(resolved.startsWith('package/') && members.has(resolved), `Unresolved package import in ${item}: ${target}`)
        } else if (!target.startsWith('node:')) {
          const name = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0]
          assert.ok(manifest.peerDependencies?.[name] || manifest.dependencies?.[name], `Undeclared runtime/type dependency in ${item}: ${name}`)
        }
        checkedImports++
      }
    }
    if (item.endsWith('.js.map')) {
      const map = JSON.parse(content)
      assert.ok(!map.sourceRoot || (!path.posix.isAbsolute(map.sourceRoot) && !path.win32.isAbsolute(map.sourceRoot)), `Absolute source map root in ${item}`)
      assert.ok(map.sources.every(source => !path.posix.isAbsolute(source) && !path.win32.isAbsolute(source)), `Absolute source map input in ${item}`)
    }
    if (['package/README.md', 'package/docs/QUICKSTART.md', 'package/docs/DEVELOPMENT.md'].includes(item)) {
      for (const match of content.matchAll(/\]\(([^)]+)\)/gu)) {
        const value = match[1].trim()
        const target = value.startsWith('<') ? value.slice(1, value.indexOf('>')) : value.split(/\s/u)[0]
        if (/^(?:https?:|mailto:|#)/iu.test(target)) continue
        assert.ok(!/^[A-Za-z][A-Za-z0-9+.-]*:|^[\\/]/u.test(target), `Absolute local documentation link in ${item}`)
        const relative = decodeURIComponent(target.split(/[?#]/u)[0])
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(item), relative))
        assert.ok(members.has(resolved) || files.some(file => file.startsWith(resolved.replace(/\/$/u, '') + '/')), `Unbundled local documentation link in ${item}: ${target}`)
        checkedLinks++
      }
    }
  }
  return {
    passed: true, archive, name: manifest.name, version: manifest.version,
    sha256: createHash('sha256').update(await fs.readFile(archive)).digest('hex'),
    files: files.map(item => item.slice('package/'.length)).sort(), checkedImports, checkedLinks,
    installHooks: installHooks.filter(hook => manifest.scripts?.[hook]), prepackInPackedManifest: Boolean(manifest.scripts?.prepack),
    scope: 'Actual tar inventory, entry points, imports, local documentation links, private paths and credential patterns; no install, model call or proof validation.',
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/check-distribution.mjs <prepared-package.tgz>')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(await checkDistribution(process.argv[2]), null, 2)) }
    catch (error) { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1 }
  }
}

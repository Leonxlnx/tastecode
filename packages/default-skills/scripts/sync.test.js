import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { digestFiles, readManifest, skillFiles, syncBundle, verifyBundle } from './sync.js'

function header(name, size, type) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  block.fill(' ', 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

function tar(entries) {
  const blocks = []
  for (const [name, content, type = '0'] of entries) {
    const body = Buffer.from(content)
    blocks.push(
      header(name, body.length, type),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
    )
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const skill = {
  folder: 'demo',
  repository: 'example/demo',
  commit: 'abc',
  path: 'skills/demo',
  licenseFile: 'LICENSE',
  exclude: ['README.md'],
}

const archive = tar([
  ['demo-abc/', '', '5'],
  ['demo-abc/LICENSE', 'MIT text'],
  ['demo-abc/README.md', 'repo readme'],
  ['demo-abc/skills/demo/SKILL.md', '---\nname: demo\n---\n'],
  ['demo-abc/skills/demo/README.md', 'excluded'],
  ['demo-abc/skills/demo/refs/a.md', 'a'],
  ['demo-abc/skills/demo/.DS_Store', 'junk'],
  ['demo-abc/skills/demo/__pycache__/x.pyc', 'junk'],
  ['demo-abc/skills/other/SKILL.md', 'not this one'],
])

test('takes only the skill folder, drops stray files and adds the licence', () => {
  const files = skillFiles(archive, skill)
  assert.deepEqual([...files.keys()].sort(), ['LICENSE', 'SKILL.md', 'refs/a.md'])
  assert.equal(files.get('LICENSE').toString(), 'MIT text')
})

test('refuses links and missing skills', () => {
  assert.throws(
    () => skillFiles(tar([['demo-abc/skills/demo/SKILL.md', 'x', '2']]), skill),
    /type 2/,
  )
  assert.throws(() => skillFiles(tar([['demo-abc/LICENSE', 'x']]), skill), /no SKILL\.md/)
})

test('syncs, verifies, and rejects an archive that does not match its pin', async () => {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), 'default-skills-')), 'bundle')
  const gz = gzipSync(archive)
  const fetchImpl = async () => new Response(gz)
  const manifest = {
    plugin: { name: 'tastecode' },
    skills: [{ ...skill, archiveSha256: '', treeSha256: '', files: 0, bytes: 0 }],
  }
  try {
    const pinned = await syncBundle(manifest, { root, fetchImpl, update: true, log: () => {} })
    assert.deepEqual(await verifyBundle(pinned, root), [])
    assert.equal(
      await readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
      '{\n  "name": "tastecode"\n}\n',
    )
    await writeFile(path.join(root, 'skills', 'demo', 'SKILL.md'), 'changed')
    assert.match((await verifyBundle(pinned, root)).join('\n'), /demo differs/)
    const tampered = { ...pinned, skills: [{ ...pinned.skills[0], archiveSha256: '0'.repeat(64) }] }
    await assert.rejects(
      syncBundle(tampered, { root, fetchImpl, log: () => {} }),
      /does not match the pinned/,
    )
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true })
  }
})

test('the committed manifest pins full commits and measured hashes', async () => {
  const manifest = await readManifest()
  assert.equal(manifest.plugin.name, 'tastecode')
  for (const entry of manifest.skills) {
    assert.match(entry.commit, /^[0-9a-f]{40}$/)
    assert.match(entry.archiveSha256, /^[0-9a-f]{64}$/)
    assert.match(entry.treeSha256, /^[0-9a-f]{64}$/)
    assert.ok(entry.files > 0 && entry.bytes > 0)
    assert.ok(entry.summary.length <= 60, entry.folder)
  }
  assert.equal(digestFiles(new Map()).files, 0)
})

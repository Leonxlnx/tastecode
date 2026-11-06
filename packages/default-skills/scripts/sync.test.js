import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { omitFiles } from './skill-media.mjs'
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

const patchedSkill = {
  folder: 'demo',
  repository: 'example/demo',
  commit: 'abc',
  path: 'skills/demo',
  licenseFile: 'LICENSE',
  omit: { paths: ['assets/photos/', 'assets/_demo/'] },
  patch: { files: { 'SKILL.md': '', 'scripts/photos.mjs': '' } },
}

const patchedArchive = tar([
  ['demo-abc/LICENSE', 'MIT text'],
  ['demo-abc/skills/demo/SKILL.md', '---\nname: demo\n---\nUse the photo library.\n'],
  ['demo-abc/skills/demo/scripts/photos.mjs', 'fetch the library'],
  ['demo-abc/skills/demo/assets/photos/photos.json', '{"photos":1}'],
  ['demo-abc/skills/demo/assets/photos/img/a.webp', 'webp'],
  ['demo-abc/skills/demo/assets/_demo/page.html', '<p>demo</p>'],
  ['demo-abc/skills/demo/assets/_demo/b.jpg', 'jpg'],
])

/** A temp folder with TasteCode's copies of the patched files, and the bundle synced from them. */
async function patchedFixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'default-skills-patch-'))
  const root = path.join(temp, 'bundle')
  const patches = path.join(temp, 'patches')
  await mkdir(path.join(patches, 'demo', 'scripts'), { recursive: true })
  await writeFile(path.join(patches, 'demo', 'SKILL.md'), '---\nname: demo\n---\nUse your own.\n')
  await writeFile(path.join(patches, 'demo', 'scripts', 'photos.mjs'), 'switched off')
  const manifest = {
    plugin: { name: 'tastecode' },
    skills: [{ ...patchedSkill, archiveSha256: '', treeSha256: '', files: 0, bytes: 0 }],
  }
  const fetchImpl = async () => new Response(gzipSync(patchedArchive))
  const options = { root, patches, fetchImpl, log: () => {} }
  const pinned = await syncBundle(manifest, { ...options, update: true })
  return { temp, root, patches, pinned, options }
}

test('leaves the omitted pictures and credits out, and keeps pages in the same folders', () => {
  const files = omitFiles(skillFiles(patchedArchive, patchedSkill), patchedSkill.omit)
  assert.deepEqual([...files.keys()].sort(), [
    'LICENSE',
    'SKILL.md',
    'assets/_demo/page.html',
    'scripts/photos.mjs',
  ])
})

test('leaves out the files a pattern names, with * inside one path segment', () => {
  const files = new Map(
    [
      'assets/objects/print-cup/fallback-dark.png',
      'assets/objects/print-cup/object.js',
      'assets/objects/print-cup/meta.json',
      'assets/objects/product-turntable/fallback-camera-light.png',
      'assets/objects/print-cup/deeper/fallback.png',
    ].map((name) => [name, Buffer.from(name)]),
  )
  const kept = omitFiles(files, { paths: ['assets/objects/*/fallback*.png'] })
  assert.deepEqual([...kept.keys()].sort(), [
    'assets/objects/print-cup/deeper/fallback.png',
    'assets/objects/print-cup/meta.json',
    'assets/objects/print-cup/object.js',
  ])
})

test('ships TasteSkill with no picture of its own', async () => {
  const manifest = await readManifest()
  const skill = manifest.skills.find((entry) => entry.folder === 'design-taste-frontend')
  for (const sample of [
    'assets/objects/print-cup/fallback-render.png',
    'assets/objects/product-turntable/fallback-chair-dark.png',
    'assets/objects/product-render/specs/city-bike.json',
    'assets/objects/product-render/specs/robot-arm.fallback.png',
    'assets/photos/img/photo-326-1200.webp',
  ])
    assert.equal(
      omitFiles(new Map([[sample, Buffer.alloc(0)]]), skill.omit).size,
      0,
      `${sample} is bundled`,
    )
})

test('bundles the patched copies, no library, and nothing that fetches one', async () => {
  const { temp, root, patches, pinned } = await patchedFixture()
  try {
    const skillDir = path.join(root, 'skills', 'demo')
    assert.deepEqual(await verifyBundle(pinned, root, patches), [])
    assert.equal(
      await readFile(path.join(skillDir, 'SKILL.md'), 'utf8'),
      '---\nname: demo\n---\nUse your own.\n',
    )
    assert.equal(
      await readFile(path.join(skillDir, 'scripts', 'photos.mjs'), 'utf8'),
      'switched off',
    )
    assert.equal(
      await readFile(path.join(skillDir, 'assets', '_demo', 'page.html'), 'utf8'),
      '<p>demo</p>',
    )
    await assert.rejects(stat(path.join(skillDir, 'assets', 'photos')))
    await assert.rejects(stat(path.join(skillDir, 'assets', '_demo', 'b.jpg')))
    assert.match(pinned.skills[0].patch.files['SKILL.md'], /^[0-9a-f]{64}$/)

    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo\n---\nUse the photo library.\n',
    )
    assert.match(
      (await verifyBundle(pinned, root, patches)).join('\n'),
      /SKILL\.md is not TasteCode's patched copy/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('refuses to build when an upstream file changed under its patch', async () => {
  const { temp, root, patches, pinned, options } = await patchedFixture()
  try {
    const moved = structuredClone(pinned)
    moved.skills[0].patch.files['SKILL.md'] = '0'.repeat(64)
    await rm(root, { recursive: true, force: true })
    await assert.rejects(
      syncBundle(moved, options),
      /upstream SKILL\.md changed .*carry patches\/demo\/SKILL\.md over/,
    )
    await assert.rejects(stat(root))
    assert.deepEqual(await verifyBundle(pinned, root, patches), [
      `${root} is missing; run pnpm --filter @harness/default-skills sync`,
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
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
    for (const base of Object.values(entry.patch?.files ?? {})) assert.match(base, /^[0-9a-f]{64}$/)
    assert.equal(entry.media, undefined, 'nothing is fetched after install')
  }
  assert.equal(digestFiles(new Map()).files, 0)
})

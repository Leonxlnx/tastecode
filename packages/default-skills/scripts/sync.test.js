import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { ensureMedia, MediaUnavailable, mediaCacheRoot, splitMedia } from './skill-media.mjs'
import {
  digestFiles,
  mediaLoaderPath,
  readManifest,
  skillFiles,
  syncBundle,
  verifyBundle,
} from './sync.js'

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

// The original script reads the media relative to itself, as taste-skill's photos.mjs does.
const original = [
  "import { readFileSync } from 'node:fs'",
  "const library = readFileSync(new URL('../assets/photos/photos.json', import.meta.url), 'utf8')",
  "console.log(`${library.trim()} ${process.argv.slice(2).join(' ')}`)",
].join('\n')

const mediaSkill = {
  folder: 'demo',
  repository: 'example/demo',
  commit: 'abc',
  path: 'skills/demo',
  licenseFile: 'LICENSE',
  media: { loader: 'scripts/photos.mjs', paths: ['assets/photos/', 'assets/_demo/'] },
}

const mediaArchive = tar([
  ['demo-abc/LICENSE', 'MIT text'],
  ['demo-abc/skills/demo/SKILL.md', '---\nname: demo\n---\n'],
  ['demo-abc/skills/demo/scripts/photos.mjs', original],
  ['demo-abc/skills/demo/assets/photos/photos.json', '{"photos":1}'],
  ['demo-abc/skills/demo/assets/photos/img/a.webp', 'webp'],
  ['demo-abc/skills/demo/assets/_demo/page.html', '<p>demo</p>'],
  ['demo-abc/skills/demo/assets/_demo/b.jpg', 'jpg'],
])

/** A temp folder, the bundle synced from mediaArchive, and the pinned manifest. */
async function mediaFixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'default-skills-media-'))
  const root = path.join(temp, 'bundle')
  const manifest = {
    plugin: { name: 'tastecode' },
    skills: [{ ...mediaSkill, archiveSha256: '', treeSha256: '', files: 0, bytes: 0 }],
  }
  const fetchImpl = async () => new Response(gzipSync(mediaArchive))
  const pinned = await syncBundle(manifest, { root, fetchImpl, update: true, log: () => {} })
  return { temp, root, pinned, skill: pinned.skills[0], fetchImpl }
}

const offline = async () => {
  throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
}

test('ships pages and scripts, and leaves the media and the original script to the loader', () => {
  const files = skillFiles(mediaArchive, mediaSkill)
  const { shipped, fetched } = splitMedia(files, mediaSkill.media)
  assert.deepEqual([...shipped.keys()].sort(), ['LICENSE', 'SKILL.md', 'assets/_demo/page.html'])
  assert.deepEqual([...fetched.keys()].sort(), [
    'assets/_demo/b.jpg',
    'assets/photos/img/a.webp',
    'assets/photos/photos.json',
    'scripts/photos.mjs',
  ])
})

test('the bundle carries the loader in place of the original script, and no media', async () => {
  const { temp, root, pinned } = await mediaFixture()
  try {
    const skillDir = path.join(root, 'skills', 'demo')
    assert.deepEqual(await verifyBundle(pinned, root), [])
    assert.deepEqual(
      await readFile(path.join(skillDir, 'scripts', 'photos.mjs')),
      await readFile(mediaLoaderPath),
    )
    await assert.rejects(stat(path.join(skillDir, 'assets', 'photos')))
    await assert.rejects(stat(path.join(skillDir, 'assets', '_demo', 'b.jpg')))
    assert.equal(pinned.skills[0].media.files, 4)
    await writeFile(path.join(skillDir, 'scripts', 'photos.mjs'), original)
    assert.match((await verifyBundle(pinned, root)).join('\n'), /not TasteCode's media loader/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('loads the media once, then works offline from the cache', async () => {
  const { temp, skill, fetchImpl } = await mediaFixture()
  try {
    const cacheRoot = path.join(temp, 'cache')
    let downloads = 0
    const counting = async (url) => {
      downloads += 1
      assert.equal(url, 'https://codeload.github.com/example/demo/tar.gz/abc')
      return fetchImpl()
    }
    const dir = await ensureMedia(skill, { cacheRoot, fetchImpl: counting, log: () => {} })
    assert.equal(dir, path.join(cacheRoot, 'demo', 'abc'))
    assert.equal(
      await readFile(path.join(dir, 'assets', 'photos', 'img', 'a.webp'), 'utf8'),
      'webp',
    )
    assert.equal(await readFile(path.join(dir, 'scripts', 'photos.mjs'), 'utf8'), original)
    assert.equal(await ensureMedia(skill, { cacheRoot, fetchImpl: offline, log: () => {} }), dir)
    assert.equal(downloads, 1)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('keeps nothing when the download does not match its pin', async () => {
  const { temp, skill, fetchImpl } = await mediaFixture()
  try {
    const cacheRoot = path.join(temp, 'cache')
    const options = { cacheRoot, fetchImpl, log: () => {} }
    const wrongArchive = { ...skill, archiveSha256: '0'.repeat(64) }
    await assert.rejects(ensureMedia(wrongArchive, options), (error) => {
      assert.ok(error instanceof MediaUnavailable)
      assert.match(error.message, /sha256 [0-9a-f]{64} does not match the pinned 0{64}/)
      return true
    })
    const wrongMedia = { ...skill, media: { ...skill.media, treeSha256: '1'.repeat(64) } }
    await assert.rejects(ensureMedia(wrongMedia, options), /do not match the pinned 4 files/)
    await assert.rejects(stat(cacheRoot))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('without network it says what is missing and what to do, and writes nothing', async () => {
  const { temp, skill } = await mediaFixture()
  try {
    const cacheRoot = path.join(temp, 'cache')
    await assert.rejects(
      ensureMedia(skill, { cacheRoot, fetchImpl: offline, log: () => {} }),
      (error) => {
        assert.ok(error instanceof MediaUnavailable)
        assert.match(error.message, /not on this computer yet: the download failed \(ENOTFOUND\)/)
        assert.match(error.message, /Connect to the internet and run the command again/)
        assert.ok(error.message.includes(path.join(cacheRoot, 'demo', 'abc')))
        return true
      },
    )
    await assert.rejects(stat(cacheRoot))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('the shipped loader runs the original script from the cached media', async () => {
  const { temp, root, skill, fetchImpl } = await mediaFixture()
  try {
    const cacheRoot = path.join(temp, 'cache')
    await ensureMedia(skill, { cacheRoot, fetchImpl, log: () => {} })
    const loader = path.join(root, 'skills', 'demo', 'scripts', 'photos.mjs')
    const result = spawnSync(process.execPath, [loader, 'list', '--trade', 'cafe'], {
      encoding: 'utf8',
      env: { ...process.env, TASTECODE_SKILL_MEDIA_DIR: cacheRoot },
    })
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, '{"photos":1} list --trade cafe\n')
    assert.equal(result.status, 0)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('keeps the media in a per-user data folder on each platform', () => {
  assert.equal(
    mediaCacheRoot({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'),
    path.join('C:\\Users\\a\\AppData\\Local', 'TasteCode', 'skill-media'),
  )
  assert.equal(
    mediaCacheRoot({}, 'darwin', '/Users/a'),
    path.join('/Users/a', 'Library', 'Application Support', 'TasteCode', 'skill-media'),
  )
  assert.equal(
    mediaCacheRoot({}, 'linux', '/home/a'),
    path.join('/home/a', '.local', 'share', 'TasteCode', 'skill-media'),
  )
  assert.equal(
    mediaCacheRoot({ TASTECODE_SKILL_MEDIA_DIR: 'media' }, 'linux', '/home/a'),
    path.resolve('media'),
  )
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
    if (entry.media) {
      assert.match(entry.media.treeSha256, /^[0-9a-f]{64}$/)
      assert.ok(entry.media.files > 0 && entry.media.bytes > 0)
    }
  }
  assert.equal(digestFiles(new Map()).files, 0)
})

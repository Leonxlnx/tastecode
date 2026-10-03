import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prepareDmgUpdate } from './dmg-update.js'

const exec = promisify(execFile)
let root = ''

type AppFixture = { id?: string; version?: string; sign?: boolean; tamper?: boolean }

async function makeApp(folder: string, name: string, app: AppFixture = {}) {
  const bundle = path.join(folder, name)
  await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(
    path.join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TasteCode</string>
<key>CFBundleIdentifier</key><string>${app.id ?? 'dev.tastecode.desktop'}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${app.version ?? '0.1.3'}</string>
</dict></plist>
`,
  )
  const executable = path.join(bundle, 'Contents', 'MacOS', 'TasteCode')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  if (app.sign ?? true) await exec('/usr/bin/codesign', ['--force', '--sign', '-', bundle])
  if (app.tamper) await writeFile(executable, '#!/bin/sh\nexit 1\n')
}

// Each DMG takes hdiutil a few seconds to create, so all are built at once.
const fixtures = {
  valid: (folder) => makeApp(folder, 'Taste Code.app'),
  otherApp: (folder) => makeApp(folder, 'Taste Code.app', { id: 'com.example.other' }),
  otherVersion: (folder) => makeApp(folder, 'Taste Code.app', { version: '0.1.2' }),
  unsigned: (folder) => makeApp(folder, 'Taste Code.app', { sign: false }),
  tampered: (folder) => makeApp(folder, 'Taste Code.app', { tamper: true }),
  empty: async () => {},
  twoApps: async (folder) => {
    await makeApp(folder, 'Taste Code.app')
    await makeApp(folder, 'Taste Code 2.app')
  },
  link: async (folder) => {
    await makeApp(path.dirname(folder), `${path.basename(folder)}-elsewhere.app`)
    await symlink(
      path.join(path.dirname(folder), `${path.basename(folder)}-elsewhere.app`),
      path.join(folder, 'Taste Code.app'),
    )
  },
} satisfies Record<string, (folder: string) => Promise<unknown>>
const dmgs = new Map<string, string>()

async function prepare(name: keyof typeof fixtures, signal?: AbortSignal) {
  const work = await mkdtemp(path.join(root, 'work-'))
  try {
    return { work, zip: await prepareDmgUpdate(dmgs.get(name)!, work, '0.1.3', signal) }
  } finally {
    // Whatever happened, the update image must not stay mounted.
    expect((await stat(path.join(work, 'volume'))).dev).toBe((await stat(work)).dev)
  }
}

describe.skipIf(process.platform !== 'darwin')('DMG update preparation', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-dmg-'))
    await Promise.all(
      Object.entries(fixtures).map(async ([name, fill]) => {
        const folder = path.join(root, name)
        await mkdir(folder)
        await fill(folder)
        const dmg = path.join(root, `${name}.dmg`)
        dmgs.set(name, dmg)
        await exec('/usr/bin/hdiutil', [
          'create',
          '-quiet',
          '-fs',
          'HFS+',
          '-format',
          'UDZO',
          '-volname',
          'TasteCode',
          '-srcfolder',
          folder,
          dmg,
        ])
      }),
    )
  }, 120_000)

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it.concurrent(
    'turns a signed TasteCode DMG into the ZIP Squirrel installs',
    async () => {
      const { work, zip } = await prepare('valid')
      expect(zip).toBe(path.join(work, 'update.zip'))
      const unpacked = path.join(work, 'unpacked')
      await exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
      await exec('/usr/bin/codesign', [
        '--verify',
        '--deep',
        '--strict',
        path.join(unpacked, 'Taste Code.app'),
      ])
    },
    60_000,
  )

  it.concurrent.each([
    ['another app', 'otherApp', /different app/],
    ['another version', 'otherVersion', /version does not match/],
    ['an unsigned app', 'unsigned', /not signed/],
    ['an app changed after signing', 'tampered', /modified|invalid|failed/i],
    ['a DMG with no app', 'empty', /exactly one app/],
    ['a DMG with two apps', 'twoApps', /exactly one app/],
    ['an app that is only a link', 'link', /real directory/],
  ])(
    'refuses %s',
    async (_label, fixture, error) => {
      await expect(prepare(fixture)).rejects.toThrow(error)
    },
    60_000,
  )

  it.concurrent(
    'stops when the update is cancelled and leaves nothing mounted',
    async () => {
      const abort = new AbortController()
      abort.abort()
      await expect(prepare('valid', abort.signal)).rejects.toThrow()
    },
    60_000,
  )
})

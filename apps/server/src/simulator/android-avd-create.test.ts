import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Every avdmanager run: its arguments. It behaves as the real one does with an existing name. */
const avdmanager = vi.hoisted(() => ({ runs: [] as string[][], home: '' }))

vi.mock('@harness/proc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@harness/proc')>()
  return {
    ...actual,
    spawnCli: (_command: string, args: string[]) => {
      avdmanager.runs.push(args)
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
      })
      const name = args[args.indexOf('-n') + 1]!
      const exists = existsSync(path.join(avdmanager.home, `${name}.ini`))
      queueMicrotask(() => {
        if (exists && !args.includes('--force')) {
          child.stderr.end(`Error: Android Virtual Device '${name}' already exists.\n`)
          child.stdout.end()
          child.emit('close', 1)
          return
        }
        void (async () => {
          await mkdir(path.join(avdmanager.home, `${name}.avd`), { recursive: true })
          await writeFile(path.join(avdmanager.home, `${name}.ini`), 'target=new\n')
          await writeFile(path.join(avdmanager.home, `${name}.avd`, 'config.ini'), 'image=new\n')
          child.stdout.end()
          child.stderr.end()
          child.emit('close', 0)
        })()
      })
      return child
    },
  }
})

const { avdmanagerBinaryPath, createAndroidAvd } = await import('./android-sdk.js')

const roots: string[] = []
afterEach(async () => {
  avdmanager.runs.length = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('creating an Android emulator', () => {
  it('never replaces an existing emulator of the same name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-avd-create-'))
    roots.push(root)
    const sdkRoot = path.join(root, 'sdk')
    avdmanager.home = path.join(root, 'avd')
    const binary = avdmanagerBinaryPath(sdkRoot)
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, '')
    // Made outside TasteCode for another Android version, under the suggested name.
    await mkdir(path.join(avdmanager.home, 'Pixel_9.avd'), { recursive: true })
    await writeFile(path.join(avdmanager.home, 'Pixel_9.ini'), 'target=android-35\n')
    await writeFile(path.join(avdmanager.home, 'Pixel_9.avd', 'config.ini'), 'image=android-35\n')

    await expect(
      createAndroidAvd({
        sdkRoot,
        name: 'Pixel 9',
        packageId: 'system-images;android-36;google_apis;x86_64',
        deviceProfile: 'pixel_9',
        env: { ANDROID_AVD_HOME: avdmanager.home },
      }),
    ).rejects.toThrow(/already exists/)

    expect(avdmanager.runs).toHaveLength(1)
    expect(avdmanager.runs[0]).not.toContain('--force')
    expect(await readFile(path.join(avdmanager.home, 'Pixel_9.avd', 'config.ini'), 'utf8')).toBe(
      'image=android-35\n',
    )
  })
})

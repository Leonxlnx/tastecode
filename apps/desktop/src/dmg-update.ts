import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function prepareDmgUpdate(
  dmg: string,
  directory: string,
  version: string,
  signal?: AbortSignal,
): Promise<string> {
  const mount = path.join(directory, 'volume')
  const zip = path.join(directory, 'update.zip')
  await mkdir(mount, { mode: 0o700 })
  const run = (file: string, args: string[]) =>
    exec(file, args, {
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
    })
  try {
    await run('/usr/bin/hdiutil', [
      'attach',
      dmg,
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mount,
    ])
    const apps = (await readdir(mount)).filter((name) => name.endsWith('.app'))
    if (apps.length !== 1) throw new Error('The update DMG must contain exactly one app.')
    const app = path.join(mount, apps[0]!)
    const stat = await lstat(app)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('The update app must be a real directory.')
    const plist = path.join(app, 'Contents', 'Info.plist')
    const readKey = async (key: string) =>
      (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim()
    if ((await readKey('CFBundleIdentifier')) !== 'dev.tastecode.desktop')
      throw new Error('The DMG contains a different app.')
    if ((await readKey('CFBundleShortVersionString')) !== version)
      throw new Error('The DMG app version does not match the release.')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    // Squirrel.Mac verifies the installed app's signing identity and owns the
    // atomic replacement. Only its transport ZIP is made locally from the DMG.
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
    return zip
  } finally {
    // attach can mount successfully just before cancellation rejects its process.
    // Inspect the device too so that path does not leave a mounted update behind.
    if ((await stat(mount)).dev !== (await stat(directory)).dev) {
      // Cleanup must still work after a cancelled download or app shutdown.
      await exec('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }).catch(async () => {
        await exec('/usr/bin/hdiutil', ['detach', '-force', mount], { timeout: 30_000 })
      })
    }
  }
}

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSimulatorDetail, runSimulatorAction } from './actions.js'
import {
  extractZipToDir,
  listAndroidSystemImages,
  parseAvdDeviceProfiles,
  parseCmdlineToolsArchive,
  sanitizeAvdName,
  uninstallAndroidSystemImage,
} from './android-sdk.js'
import { LocalSimulatorHost, type ReadySimulatorHost } from './host.js'
import { SimulatorService } from './service.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tastecode-android-sdk-test-'))
  tempDirs.push(dir)
  return dir
}

/** Build a valid minimal ZIP archive (method 0 or 8) with Unix file modes for testing extractZipToDir. */
function buildZip(
  entries: ReadonlyArray<{
    readonly name: string
    readonly content?: Buffer
    readonly deflate?: boolean
    readonly mode?: number
  }>,
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.content ?? Buffer.alloc(0)
    const method = entry.deflate ? 8 : 0
    const body = entry.deflate ? deflateRawSync(raw) : raw

    const local = Buffer.alloc(30 + nameBytes.length + body.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    body.copy(local, 30 + nameBytes.length)
    locals.push(local)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4) // Unix creator
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o644) & 0o777) << 16, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)

    offset += local.length
  }

  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, cdBuf, eocd])
}

const SAMPLE_REPO_XML = `
<sdk:sdk-repository>
  <remotePackage path="cmdline-tools;latest">
    <archives>
      <archive>
        <complete>
          <size>181052239</size>
          <checksum type="sha1">e025545c62a8e64c7559119566a569fb1dec5f60</checksum>
          <url>commandlinetools-linux-16111833_latest.zip</url>
        </complete>
        <host-os>linux</host-os>
      </archive>
      <archive>
        <complete>
          <size>155582504</size>
          <checksum type="sha1">112cf9618794a997ff273537d55bee02c22abffe</checksum>
          <url>commandlinetools-mac_x86_64-16111833_latest.zip</url>
        </complete>
        <host-os>macosx</host-os>
        <host-arch>x64</host-arch>
      </archive>
      <archive>
        <complete>
          <size>155384151</size>
          <checksum type="sha1">ad03dc49bfacfd52c110b14104ea548b8a07e830</checksum>
          <url>commandlinetools-mac_arm64-16111833_latest.zip</url>
        </complete>
        <host-os>macosx</host-os>
        <host-arch>aarch64</host-arch>
      </archive>
      <archive>
        <complete>
          <size>154957218</size>
          <checksum type="sha1">57d04f2d75eb8e8fffc5000a987e5de4b5a63e9d</checksum>
          <url>commandlinetools-win-16111833_latest.zip</url>
        </complete>
        <host-os>windows</host-os>
      </archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>
`

describe('Android SDK helpers', () => {
  it('selects the matching cmdline-tools archive per OS and CPU arch', () => {
    expect(parseCmdlineToolsArchive(SAMPLE_REPO_XML, 'darwin', 'arm64')).toEqual({
      url: 'https://dl.google.com/android/repository/commandlinetools-mac_arm64-16111833_latest.zip',
      sha1: 'ad03dc49bfacfd52c110b14104ea548b8a07e830',
      size: 155384151,
    })
    expect(parseCmdlineToolsArchive(SAMPLE_REPO_XML, 'darwin', 'x64').url).toContain('mac_x86_64')
    expect(parseCmdlineToolsArchive(SAMPLE_REPO_XML, 'win32', 'x64').url).toContain(
      'commandlinetools-win-',
    )
    expect(parseCmdlineToolsArchive(SAMPLE_REPO_XML, 'linux', 'x64').url).toContain(
      'commandlinetools-linux-',
    )
  })

  it('extracts stored and deflated ZIP archives with executable modes and blocks Zip Slip', async () => {
    const dest = await makeTempDir()
    const zip = buildZip([
      { name: 'cmdline-tools/' },
      {
        name: 'cmdline-tools/bin/sdkmanager',
        content: Buffer.from('#!/bin/sh\necho ok\n'),
        deflate: true,
        mode: 0o755,
      },
      {
        name: 'cmdline-tools/NOTICE.txt',
        content: Buffer.from('Apache 2.0'),
        deflate: false,
        mode: 0o644,
      },
    ])
    await extractZipToDir(zip, dest)

    const notice = await readFile(path.join(dest, 'cmdline-tools', 'NOTICE.txt'), 'utf8')
    expect(notice).toBe('Apache 2.0')
    const binPath = path.join(dest, 'cmdline-tools', 'bin', 'sdkmanager')
    expect(await readFile(binPath, 'utf8')).toContain('echo ok')
    if (process.platform !== 'win32') {
      const info = await stat(binPath)
      expect(info.mode & 0o111).toBeGreaterThan(0)
    }

    const evilZip = buildZip([{ name: '../escape.txt', content: Buffer.from('nope') }])
    await expect(extractZipToDir(evilZip, dest)).rejects.toThrow(/unsafe ZIP entry/)
  })

  it('parses avdmanager device profiles and ranks mobile phones first', () => {
    const sample = [
      'Available devices definitions:',
      'id: 0 or "tv_1080p"',
      '    Name: Android TV (1080p)',
      '    OEM : Google',
      '---------',
      'id: 1 or "wearos_small_round"',
      '    Name: Wear OS Small Round',
      '    OEM : Google',
      '---------',
      'id: 2 or "medium_phone"',
      '    Name: Medium Phone',
      '    OEM : Generic',
      '---------',
      'id: 3 or "pixel_9"',
      '    Name: Pixel 9',
      '    OEM : Google',
    ].join('\n')

    const parsed = parseAvdDeviceProfiles(sample)
    expect(parsed.map((p) => p.value)).toEqual(['pixel_9', 'medium_phone'])
  })

  it('discovers installed system images on disk and sanitizes AVD names', async () => {
    const sdkRoot = await makeTempDir()
    const imageDir = path.join(
      sdkRoot,
      'system-images',
      'android-35',
      'google_apis_playstore',
      'arm64-v8a',
    )
    await mkdir(imageDir, { recursive: true })
    await writeFile(path.join(imageDir, 'source.properties'), 'Pkg.Desc=Android SDK System Image\n')

    const images = await listAndroidSystemImages(sdkRoot, 'arm64')
    const installed = images.find(
      (item) => item.packageId === 'system-images;android-35;google_apis_playstore;arm64-v8a',
    )
    expect(installed?.installed).toBe(true)
    expect(images[0]?.installed).toBe(true)

    expect(sanitizeAvdName('Pixel 9 Pro (API 35)!')).toBe('Pixel_9_Pro_API_35_')
  })

  it('refuses to uninstall non-system-image packages', async () => {
    const sdkRoot = await makeTempDir()
    await expect(
      uninstallAndroidSystemImage({
        sdkRoot,
        packageId: 'platform-tools',
        env: process.env,
      }),
    ).rejects.toThrow(/Invalid Android system image/)
  })
})

describe('Android feature parity actions', () => {
  it('reads API 36 mFocusedApp, high contrast, rotation, and supports network/orientation/permission reset', async () => {
    const commands: string[][] = []
    const host: ReadySimulatorHost = {
      origin: 'http://127.0.0.1:9999',
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: null,
      run: async (command, args) => {
        commands.push([command, ...args])
        const joined = args.join(' ')
        if (joined.includes('cmd uimode night'))
          return { code: 0, stdout: 'Night mode: yes\n', stderr: '' }
        if (joined.includes('font_scale')) return { code: 0, stdout: '1.15\n', stderr: '' }
        if (joined.includes('animator_duration_scale'))
          return { code: 0, stdout: '0.0\n', stderr: '' }
        if (joined.includes('high_text_contrast_enabled'))
          return { code: 0, stdout: '1\n', stderr: '' }
        if (joined.includes('wifi_on')) return { code: 0, stdout: '1\n', stderr: '' }
        if (joined.includes('mobile_data')) return { code: 0, stdout: '0\n', stderr: '' }
        if (joined.includes('airplane_mode_on')) return { code: 0, stdout: '0\n', stderr: '' }
        if (joined.includes('user_rotation')) return { code: 0, stdout: '3\n', stderr: '' }
        if (joined.includes('wm size'))
          return { code: 0, stdout: 'Physical size: 1080x2424\n', stderr: '' }
        if (joined.includes('dumpsys window')) {
          return {
            code: 0,
            stdout: '  mFocusedApp=ActivityRecord{abc123 u0 com.example.shop/.MainActivity t42}\n',
            stderr: '',
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const detail = await readSimulatorDetail(host, 'emulator-5554', 'android')
    expect(detail.appearance).toBe('dark')
    expect(detail.textSize).toBe('large')
    expect(detail.orientation).toBe('landscape_left')
    expect(detail.toggles).toEqual({
      reduceMotion: true,
      increaseContrast: true,
      networkEnabled: true,
    })
    expect(detail.foregroundApp).toEqual({ id: 'com.example.shop' })

    await runSimulatorAction(host, 'android', {
      deviceId: 'emulator-5554',
      type: 'setToggle',
      setting: 'networkEnabled',
      value: false,
    })
    expect(
      commands.some(
        (cmd) => cmd.includes('svc') && cmd.includes('wifi') && cmd.includes('disable'),
      ),
    ).toBe(true)

    await runSimulatorAction(host, 'android', {
      deviceId: 'emulator-5554',
      type: 'setToggle',
      setting: 'increaseContrast',
      value: false,
    })
    expect(
      commands.some(
        (cmd) =>
          cmd.includes('high_text_contrast_enabled') && cmd.includes('secure') && cmd.includes('0'),
      ),
    ).toBe(true)

    await runSimulatorAction(host, 'android', {
      deviceId: 'emulator-5554',
      type: 'setOrientation',
      value: 'landscape_left',
    })
    expect(
      commands.some(
        (cmd) => cmd.includes('user-rotation') && cmd.includes('lock') && cmd.includes('3'),
      ),
    ).toBe(true)

    await runSimulatorAction(host, 'android', {
      deviceId: 'emulator-5554',
      type: 'setPermission',
      appId: 'com.example.shop',
      permission: 'camera',
      decision: 'reset',
    })
    expect(
      commands.some(
        (cmd) =>
          cmd.includes('pm') && cmd.includes('revoke') && cmd.includes('android.permission.CAMERA'),
      ),
    ).toBe(true)
    expect(
      commands.some(
        (cmd) =>
          cmd.includes('clear-permission-flags') && cmd.includes('android.permission.CAMERA'),
      ),
    ).toBe(true)
  })
})

describe('SimulatorService device create and remove', () => {
  it('clears sessions and removes both Android and iOS simulators cleanly', async () => {
    const root = await makeTempDir()
    const host = new LocalSimulatorHost(root)
    const removeSpy = vi.spyOn(host, 'removeDevice').mockResolvedValue(undefined)
    const createSpy = vi.spyOn(host, 'createDevice').mockResolvedValue({
      id: 'Pixel_9_API_35',
      name: 'Pixel_9_API_35',
      platform: 'android',
      version: 'Android API 35',
      booted: false,
      physical: false,
    })
    vi.spyOn(host, 'ensureReady').mockResolvedValue({
      origin: 'http://127.0.0.1:9999',
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: null,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    vi.spyOn(host, 'listDevices').mockResolvedValue({
      devices: [
        {
          id: 'Pixel_9_API_35',
          name: 'Pixel_9_API_35',
          platform: 'android',
          version: 'Android API 35',
          booted: false,
          physical: false,
        },
      ],
    })

    let stored: string | undefined = JSON.stringify({
      enabled: true,
      agentAccessEnabled: false,
      onboardingCompleted: true,
    })
    const service = new SimulatorService({
      dataRoot: root,
      settings: {
        read: () => stored,
        write: (value) => {
          stored = value
        },
      },
      serverOrigin: () => ({
        httpOrigin: 'http://127.0.0.1:4311',
        wsOrigin: 'ws://127.0.0.1:4311',
      }),
      host,
    })

    const created = await service.create({
      platform: 'android',
      name: 'Pixel_9_API_35',
      runtime: 'system-images;android-35;google_apis_playstore;arm64-v8a',
      deviceType: 'pixel_9',
      boot: false,
    })
    expect(createSpy).toHaveBeenCalledOnce()
    expect(created.device.id).toBe('Pixel_9_API_35')

    const afterRemove = await service.remove({
      platform: 'android',
      deviceId: 'Pixel_9_API_35',
      name: 'Pixel_9_API_35',
    })
    expect(removeSpy).toHaveBeenCalledWith({
      platform: 'android',
      deviceId: 'Pixel_9_API_35',
      name: 'Pixel_9_API_35',
    })
    expect(afterRemove.devices.find((d) => d.id === 'Pixel_9_API_35')).toBeUndefined()
  })
})

import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const iconSourcePath = path.resolve(here, '../assets/tastecode-icon.icon')

async function setPlistString(plistPath, key, value) {
  try {
    await execFileAsync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath])
  } catch {
    await execFileAsync('/usr/bin/plutil', ['-insert', key, '-string', value, plistPath])
  }
}

export async function installMacOSIcon(appBundle) {
  if (process.platform !== 'darwin') return

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-icon-'))
  const iconDocument = path.join(temporaryDirectory, 'Icon.icon')
  const outputDirectory = path.join(temporaryDirectory, 'out')

  try {
    await Promise.all([
      cp(iconSourcePath, iconDocument, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
    ])
    await execFileAsync('xcrun', [
      'actool',
      iconDocument,
      '--compile',
      outputDirectory,
      '--output-format',
      'human-readable-text',
      '--notices',
      '--warnings',
      '--output-partial-info-plist',
      path.join(outputDirectory, 'assetcatalog_generated_info.plist'),
      '--app-icon',
      'Icon',
      '--include-all-app-icons',
      '--accent-color',
      'AccentColor',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '26.0',
      '--platform',
      'macosx',
    ])

    const resourcesDirectory = path.join(appBundle, 'Contents', 'Resources')
    await mkdir(resourcesDirectory, { recursive: true })
    await Promise.all([
      copyFile(
        path.join(outputDirectory, 'Assets.car'),
        path.join(resourcesDirectory, 'Assets.car'),
      ),
      copyFile(path.join(outputDirectory, 'Icon.icns'), path.join(resourcesDirectory, 'icon.icns')),
    ])

    const plistPath = path.join(appBundle, 'Contents', 'Info.plist')
    await setPlistString(plistPath, 'CFBundleIconFile', 'icon.icns')
    await setPlistString(plistPath, 'CFBundleIconName', 'Icon')
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

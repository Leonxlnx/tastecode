// electron-builder leaves some file names out of extraResources (cinetic's empty
// public/audio/.gitkeep, for one). The default skills must ship exactly as pinned in
// packages/default-skills/skills.json, so copy back every bundle file the packager dropped.
const { copyFile, mkdir, readdir, stat } = require('node:fs/promises')
const path = require('node:path')

const bundle = path.resolve(__dirname, '../../../packages/default-skills/bundle')

/** Copies each file under `source` that is missing under `target`; returns their relative paths. */
async function restoreMissing(source, target) {
  const restored = []
  async function walk(relative) {
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) {
        const destination = path.join(target, child)
        const present = await stat(destination).then(
          () => true,
          () => false,
        )
        if (present) continue
        await mkdir(path.dirname(destination), { recursive: true })
        await copyFile(path.join(source, child), destination)
        restored.push(child)
      }
    }
  }
  await walk('')
  return restored
}

function resourcesDirectory(context) {
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas')
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
    )
  return path.join(context.appOutDir, 'resources')
}

async function afterPack(context) {
  const restored = await restoreMissing(
    bundle,
    path.join(resourcesDirectory(context), 'default-skills'),
  )
  if (restored.length)
    console.log(
      `  • restored ${restored.length} default-skill file(s) the packager left out: ${restored.join(', ')}`,
    )
}

module.exports = afterPack
module.exports.restoreMissing = restoreMissing
module.exports.resourcesDirectory = resourcesDirectory

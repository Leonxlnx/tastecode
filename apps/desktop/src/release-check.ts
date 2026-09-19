// Dependency-free GitHub release facts shared by the electron-updater provider
// and the deb (manual) update check. This module must not import electron or
// electron-updater: the manual path runs in packages that never load them.

export const releaseRepository = 'Leonxlnx/tastecode'

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/

export function versionFromTag(tag: string): string | undefined {
  const version = tag.replace(/^v/, '')
  const match = semverPattern.exec(version)
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) return undefined
  return version
}

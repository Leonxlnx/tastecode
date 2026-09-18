import { describe, expect, it } from 'vitest'
import {
  appImageUserNamespaceBlocked,
  dbusNamesIncludeStatusNotifierWatcher,
  probeLinuxTrayHost,
  shouldHideWindowOnClose,
  type LinuxTrayHostProbeRun,
} from './background-lifecycle.js'

describe('desktop background lifecycle', () => {
  it('keeps the host alive behind a hidden window on Windows', () => {
    expect(shouldHideWindowOnClose('win32', false)).toBe(true)
    expect(shouldHideWindowOnClose('win32', false, true)).toBe(true)
  })

  it('hides the last Linux window only when a tray icon exists', () => {
    expect(shouldHideWindowOnClose('linux', false, true)).toBe(true)
    expect(shouldHideWindowOnClose('linux', false)).toBe(false)
  })

  it('uses native macOS window closing and never blocks a real app quit', () => {
    expect(shouldHideWindowOnClose('darwin', false)).toBe(false)
    expect(shouldHideWindowOnClose('darwin', false, true)).toBe(false)
    expect(shouldHideWindowOnClose('win32', true, true)).toBe(false)
    expect(shouldHideWindowOnClose('linux', true, true)).toBe(false)
  })
})

describe('dbusNamesIncludeStatusNotifierWatcher', () => {
  it('finds the watcher in a busctl --user list table', () => {
    const listing = [
      'NAME                                PID PROCESS         USER',
      'org.freedesktop.DBus                  1 dbus-broker     user',
      'org.kde.StatusNotifierWatcher      2401 cosmic-panel    user',
      ':1.42                                2401 cosmic-panel    user',
    ].join('\n')
    expect(dbusNamesIncludeStatusNotifierWatcher(listing)).toBe(true)
  })

  it('finds the watcher in dbus-send ListNames output', () => {
    const listing = [
      'method return time=1.0 sender=org.freedesktop.DBus -> destination=:1.9',
      '   array [',
      '      string "org.freedesktop.DBus"',
      '      string "org.kde.StatusNotifierWatcher"',
      '      string ":1.42"',
      '   ]',
    ].join('\n')
    expect(dbusNamesIncludeStatusNotifierWatcher(listing)).toBe(true)
  })

  it('does not match a partial name or unrelated output', () => {
    expect(dbusNamesIncludeStatusNotifierWatcher('org.kde.StatusNotifierWatcher2\n')).toBe(false)
    expect(
      dbusNamesIncludeStatusNotifierWatcher('string "org.kde.StatusNotifierItem-1-1"'),
    ).toBe(false)
    expect(dbusNamesIncludeStatusNotifierWatcher('total garbage')).toBe(false)
    expect(dbusNamesIncludeStatusNotifierWatcher('')).toBe(false)
  })
})

describe('probeLinuxTrayHost', () => {
  const listingWithWatcher = 'org.kde.StatusNotifierWatcher 2401 cosmic-panel user\n'
  const listingWithoutWatcher = 'org.freedesktop.DBus 1 dbus-broker user\n'

  it('reports a host when the session bus lists StatusNotifierWatcher', async () => {
    const run: LinuxTrayHostProbeRun = async () => ({ code: 0, stdout: listingWithWatcher })
    await expect(probeLinuxTrayHost({ run })).resolves.toBe(true)
  })

  it('falls back to dbus-send when busctl cannot list the bus', async () => {
    const commands: string[] = []
    const run: LinuxTrayHostProbeRun = async (command) => {
      commands.push(command)
      if (command === 'busctl') return { code: 1, stdout: '' }
      return { code: 0, stdout: `string "org.kde.StatusNotifierWatcher"\n` }
    }
    await expect(probeLinuxTrayHost({ run })).resolves.toBe(true)
    expect(commands).toEqual(['busctl', 'dbus-send'])
  })

  it('reports no host when the watcher is absent from every listing', async () => {
    const run: LinuxTrayHostProbeRun = async () => ({ code: 0, stdout: listingWithoutWatcher })
    await expect(probeLinuxTrayHost({ run })).resolves.toBe(false)
  })

  it('reports no host when every tool fails or times out', async () => {
    const run: LinuxTrayHostProbeRun = async () => {
      throw new Error('spawn busctl ENOENT')
    }
    await expect(probeLinuxTrayHost({ run })).resolves.toBe(false)
  })
})

describe('appImageUserNamespaceBlocked', () => {
  it('flags only an enabled restriction', () => {
    expect(appImageUserNamespaceBlocked('1\n')).toBe(true)
    expect(appImageUserNamespaceBlocked('0\n')).toBe(false)
    expect(appImageUserNamespaceBlocked(undefined)).toBe(false)
    expect(appImageUserNamespaceBlocked('')).toBe(false)
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  argvSpecifiesOzonePlatform,
  linuxDisplayEnv,
  ozonePlatformForLinux,
} from './ozone-platform.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRuntimeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ozone-platform-'))
  dirs.push(dir)
  return dir
}

describe('ozonePlatformForLinux', () => {
  it('picks wayland when WAYLAND_DISPLAY survives without session hints', () => {
    // The stripped-env bug: SSH, cron, systemd units and `env -i` launchers
    // keep WAYLAND_DISPLAY but drop XDG_SESSION_TYPE and DISPLAY.
    expect(
      ozonePlatformForLinux({
        waylandDisplay: 'wayland-1',
        display: undefined,
        xdgSessionType: undefined,
        hasWaylandSocket: false,
      }),
    ).toBe('wayland')
  })

  it('prefers wayland over XWayland when both displays are exported', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: 'wayland-1',
        display: ':0',
        xdgSessionType: undefined,
        hasWaylandSocket: false,
      }),
    ).toBe('wayland')
  })

  it('honours a wayland session hint even without WAYLAND_DISPLAY', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: undefined,
        display: undefined,
        xdgSessionType: 'wayland',
        hasWaylandSocket: true,
      }),
    ).toBe('wayland')
  })

  it('honours an x11 session hint even when WAYLAND_DISPLAY lingers', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: 'wayland-1',
        display: ':0',
        xdgSessionType: 'x11',
        hasWaylandSocket: false,
      }),
    ).toBe('x11')
  })

  it('falls back to x11 when a wayland session hint names nothing reachable', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: undefined,
        display: ':0',
        xdgSessionType: 'wayland',
        hasWaylandSocket: false,
      }),
    ).toBe('x11')
  })

  it('falls back to wayland when an x11 session hint names nothing reachable', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: 'wayland-1',
        display: undefined,
        xdgSessionType: 'x11',
        hasWaylandSocket: false,
      }),
    ).toBe('wayland')
  })

  it('picks x11 when only DISPLAY is present', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: undefined,
        display: ':0',
        xdgSessionType: undefined,
        hasWaylandSocket: false,
      }),
    ).toBe('x11')
  })

  it('treats an unknown session hint as absent', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: 'wayland-1',
        display: undefined,
        xdgSessionType: 'tty',
        hasWaylandSocket: false,
      }),
    ).toBe('wayland')
  })

  it('treats empty display variables as absent', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: '',
        display: '',
        xdgSessionType: undefined,
        hasWaylandSocket: false,
      }),
    ).toBeUndefined()
  })

  it('returns undefined when no display is reachable', () => {
    expect(
      ozonePlatformForLinux({
        waylandDisplay: undefined,
        display: undefined,
        xdgSessionType: 'wayland',
        hasWaylandSocket: false,
      }),
    ).toBeUndefined()
    expect(
      ozonePlatformForLinux({
        waylandDisplay: undefined,
        display: undefined,
        xdgSessionType: undefined,
        hasWaylandSocket: false,
      }),
    ).toBeUndefined()
  })
})

describe('linuxDisplayEnv', () => {
  it('reads the display variables from the given environment', async () => {
    const env = linuxDisplayEnv({
      WAYLAND_DISPLAY: 'wayland-1',
      DISPLAY: ':0',
      XDG_SESSION_TYPE: 'wayland',
    })
    expect(env).toEqual({
      waylandDisplay: 'wayland-1',
      display: ':0',
      xdgSessionType: 'wayland',
      hasWaylandSocket: false,
    })
  })

  it('detects the default wayland socket under XDG_RUNTIME_DIR', async () => {
    const dir = await tempRuntimeDir()
    await writeFile(path.join(dir, 'wayland-0'), '')
    expect(linuxDisplayEnv({ XDG_RUNTIME_DIR: dir }).hasWaylandSocket).toBe(true)
    expect(linuxDisplayEnv({ XDG_RUNTIME_DIR: path.join(dir, 'missing') }).hasWaylandSocket).toBe(
      false,
    )
    expect(linuxDisplayEnv({}).hasWaylandSocket).toBe(false)
  })
})

describe('argvSpecifiesOzonePlatform', () => {
  it('detects both flag spellings', () => {
    expect(argvSpecifiesOzonePlatform(['electron', '--ozone-platform=wayland'])).toBe(true)
    expect(argvSpecifiesOzonePlatform(['electron', '--ozone-platform', 'x11'])).toBe(true)
  })

  it('ignores other switches and missing flags', () => {
    expect(argvSpecifiesOzonePlatform(['electron', '--ozone-platform-hint=auto'])).toBe(false)
    expect(argvSpecifiesOzonePlatform(['electron', '.', '--no-sandbox'])).toBe(false)
  })
})

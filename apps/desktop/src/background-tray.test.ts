import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  type MenuItem = { label?: string; type?: string; click?: () => void }

  const tray = {
    destroy: vi.fn(),
    on: vi.fn((_event: string, _handler: () => void) => undefined),
    setContextMenu: vi.fn((_menu: MenuItem[]) => undefined),
    setToolTip: vi.fn((_value: string) => undefined),
  }
  const resizedIcon = { isEmpty: vi.fn(() => false) }
  const image = {
    resize: vi.fn((_size: { width: number; height: number }) => resizedIcon),
  }

  return {
    tray,
    image,
    resizedIcon,
    buildFromTemplate: vi.fn((template: MenuItem[]) => template),
    createFromPath: vi.fn((_path: string) => image),
    Tray: vi.fn(function Tray() {
      return tray
    }),
  }
})

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  nativeImage: { createFromPath: electron.createFromPath },
  Tray: electron.Tray,
}))

import { tryCreateBackgroundTray } from './background-tray.js'

describe('background tray', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electron.tray.setContextMenu.mockImplementation(() => undefined)
  })

  it('creates one recovery tray wired to open and quit', () => {
    const onOpen = vi.fn()
    const onQuit = vi.fn()

    const tray = tryCreateBackgroundTray({
      appName: 'Taste Code',
      iconPath: '/product-icon.png',
      onOpen,
      onQuit,
      onUnavailable: vi.fn(),
    })

    expect(tray).toBe(electron.tray)
    expect(electron.createFromPath).toHaveBeenCalledWith('/product-icon.png')
    expect(electron.image.resize).toHaveBeenCalledWith({ width: 20, height: 20 })
    expect(electron.tray.setToolTip).toHaveBeenCalledWith('Taste Code')
    const menu = electron.buildFromTemplate.mock.calls[0]?.[0]
    expect(menu?.map(({ label, type }) => ({ label, type }))).toEqual([
      { label: 'Open Taste Code', type: undefined },
      { label: undefined, type: 'separator' },
      { label: 'Quit Taste Code', type: undefined },
    ])

    electron.tray.on.mock.calls[0]?.[1]()
    menu?.[0]?.click?.()
    menu?.[2]?.click?.()
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('destroys a partial tray and reports the creation failure', () => {
    const failure = new Error('menu unavailable')
    const onUnavailable = vi.fn()
    electron.tray.setContextMenu.mockImplementationOnce(() => {
      throw failure
    })

    const tray = tryCreateBackgroundTray({
      appName: 'Taste Code',
      iconPath: '/product-icon.png',
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      onUnavailable,
    })

    expect(tray).toBeUndefined()
    expect(electron.tray.destroy).toHaveBeenCalledOnce()
    expect(onUnavailable).toHaveBeenCalledWith(failure)
  })

  it('reports an unreadable tray icon instead of hiding without a host', () => {
    electron.resizedIcon.isEmpty.mockReturnValueOnce(true)
    const onUnavailable = vi.fn()

    const tray = tryCreateBackgroundTray({
      appName: 'Taste Code',
      iconPath: '/product-icon.png',
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      onUnavailable,
    })

    expect(tray).toBeUndefined()
    expect(electron.Tray).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledOnce()
    expect(String(onUnavailable.mock.calls[0]?.[0])).toMatch(/tray icon/)
  })
})

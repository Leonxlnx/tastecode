import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Rectangle } from 'electron'

export type MainWindowState = {
  version: 1
  bounds: Rectangle
  fullScreen: boolean
  maximized: boolean
}

export type RestoredMainWindowState = {
  bounds: Rectangle | Pick<Rectangle, 'width' | 'height'>
  fullScreen: boolean
  maximized: boolean
}

export type MainWindowStatePersistence = {
  saveAndStop: () => void
  stop: () => void
}

type WindowSize = Pick<Rectangle, 'width' | 'height'>
type MainWindowStateTarget = {
  getNormalBounds: () => Rectangle
  on(event: 'move', listener: () => void): void
  on(event: 'resize', listener: () => void): void
  on(event: 'enter-full-screen', listener: () => void): void
  on(event: 'leave-full-screen', listener: () => void): void
  on(event: 'maximize', listener: () => void): void
  on(event: 'unmaximize', listener: () => void): void
  on(event: 'close', listener: () => void): void
  off(event: 'move', listener: () => void): void
  off(event: 'resize', listener: () => void): void
  off(event: 'enter-full-screen', listener: () => void): void
  off(event: 'leave-full-screen', listener: () => void): void
  off(event: 'maximize', listener: () => void): void
  off(event: 'unmaximize', listener: () => void): void
  off(event: 'close', listener: () => void): void
}

const SAVE_DELAY_MS = 200

export function parseMainWindowState(value: unknown): MainWindowState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const bounds = candidate['bounds']
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) return undefined
  const rectangle = bounds as Record<string, unknown>
  const x = rectangle['x']
  const y = rectangle['y']
  const width = rectangle['width']
  const height = rectangle['height']
  if (
    candidate['version'] !== 1 ||
    typeof candidate['fullScreen'] !== 'boolean' ||
    typeof candidate['maximized'] !== 'boolean' ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0
  ) {
    return undefined
  }
  return {
    version: 1,
    bounds: {
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
    },
    fullScreen: candidate['fullScreen'],
    maximized: candidate['maximized'],
  }
}

export function loadMainWindowState(filePath: string): MainWindowState | undefined {
  try {
    return parseMainWindowState(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return undefined
  }
}

export function saveMainWindowState(filePath: string, state: MainWindowState): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function restoreMainWindowState(
  state: MainWindowState | undefined,
  workArea: Rectangle | undefined,
  fallbackSize: WindowSize,
  minimumSize: WindowSize,
): RestoredMainWindowState {
  if (!state || !workArea) {
    return { bounds: fallbackSize, fullScreen: false, maximized: false }
  }

  const maximumWidth = Math.max(minimumSize.width, workArea.width)
  const maximumHeight = Math.max(minimumSize.height, workArea.height)
  const width = Math.min(Math.max(state.bounds.width, minimumSize.width), maximumWidth)
  const height = Math.min(Math.max(state.bounds.height, minimumSize.height), maximumHeight)
  const maximumX = workArea.x + Math.max(0, workArea.width - width)
  const maximumY = workArea.y + Math.max(0, workArea.height - height)

  return {
    bounds: {
      x: Math.min(Math.max(state.bounds.x, workArea.x), maximumX),
      y: Math.min(Math.max(state.bounds.y, workArea.y), maximumY),
      width,
      height,
    },
    fullScreen: state.fullScreen,
    maximized: state.maximized,
  }
}

export function persistMainWindowState(
  window: MainWindowStateTarget,
  initialState: RestoredMainWindowState,
  save: (state: MainWindowState) => void,
  onError: (error: unknown) => void = () => undefined,
): MainWindowStatePersistence {
  let state: MainWindowState = {
    version: 1,
    bounds: window.getNormalBounds(),
    fullScreen: initialState.fullScreen,
    maximized: initialState.maximized,
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const saveNow = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    try {
      save(state)
    } catch (error) {
      onError(error)
    }
  }
  const saveSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS)
  }
  const updateBounds = (): void => {
    state = { ...state, bounds: window.getNormalBounds() }
  }
  const onMoveOrResize = (): void => {
    updateBounds()
    saveSoon()
  }
  const onEnterFullScreen = (): void => {
    updateBounds()
    state = { ...state, fullScreen: true }
    saveSoon()
  }
  const onLeaveFullScreen = (): void => {
    updateBounds()
    state = { ...state, fullScreen: false }
    saveSoon()
  }
  const onMaximize = (): void => {
    updateBounds()
    state = { ...state, maximized: true }
    saveSoon()
  }
  const onUnmaximize = (): void => {
    updateBounds()
    state = { ...state, maximized: false }
    saveSoon()
  }
  const onClose = (): void => {
    updateBounds()
    saveNow()
  }

  window.on('move', onMoveOrResize)
  window.on('resize', onMoveOrResize)
  window.on('enter-full-screen', onEnterFullScreen)
  window.on('leave-full-screen', onLeaveFullScreen)
  window.on('maximize', onMaximize)
  window.on('unmaximize', onUnmaximize)
  window.on('close', onClose)

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (saveTimer) clearTimeout(saveTimer)
    window.off('move', onMoveOrResize)
    window.off('resize', onMoveOrResize)
    window.off('enter-full-screen', onEnterFullScreen)
    window.off('leave-full-screen', onLeaveFullScreen)
    window.off('maximize', onMaximize)
    window.off('unmaximize', onUnmaximize)
    window.off('close', onClose)
  }
  const saveAndStop = (): void => {
    if (stopped) return
    updateBounds()
    saveNow()
    stop()
  }
  return { saveAndStop, stop }
}

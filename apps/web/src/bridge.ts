/**
 * The native bridge, when one exists.
 *
 * The same UI runs in a browser during development and in Electron in
 * production, so every native call has to degrade rather than crash. Anything
 * that cannot work without the bridge is hidden, not shown broken.
 */
type Bridge = {
  pickFolder: () => Promise<string | undefined>
  pickSkillFolder: () => Promise<string | undefined>
  pickFiles: () => Promise<string[]>
  savePastedImage: (image: { type: string; bytes: ArrayBuffer }) => Promise<string>
  isDesktop: true
}

const bridge = (globalThis as { harness?: Bridge }).harness

export const isDesktop = bridge?.isDesktop === true

export function isMacOS(): boolean {
  return navigator.platform.startsWith('Mac')
}

export async function pickFolder(): Promise<string | undefined> {
  if (bridge) return bridge.pickFolder()
  return window.prompt('Folder to work in')?.trim() || undefined
}

export async function pickSkillFolder(): Promise<string | undefined> {
  if (bridge) return bridge.pickSkillFolder()
  return window.prompt('Full path of an Agent Skill folder')?.trim() || undefined
}

export async function pickFiles(): Promise<string[]> {
  if (bridge) return bridge.pickFiles()
  const typed = window.prompt('Full path of a file to attach')?.trim()
  return typed ? [typed] : []
}

export async function savePastedImage(file: File): Promise<string | undefined> {
  if (!bridge) return undefined
  return bridge.savePastedImage({ type: file.type, bytes: await file.arrayBuffer() })
}

/**
 * Dictation, only where the platform actually provides it. Chromium's
 * SpeechRecognition needs a speech service that unbranded Electron builds do
 * not ship with, so this is checked rather than assumed — a mic button that
 * silently does nothing is worse than no mic button.
 */
type SpeechCtor = new () => SpeechLike
type SpeechLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

const SpeechRecognition =
  (globalThis as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor })
    .SpeechRecognition ??
  (globalThis as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition

export const canDictate = SpeechRecognition !== undefined

export function startDictation(handlers: {
  onText: (text: string) => void
  onEnd: () => void
}): () => void {
  if (!SpeechRecognition) return () => {}
  const recognition = new SpeechRecognition()
  recognition.continuous = true
  recognition.interimResults = false
  recognition.lang = navigator.language
  recognition.onresult = (event) => {
    const last = event.results[event.results.length - 1]
    const first = last?.[0]
    if (first) handlers.onText(first.transcript)
  }
  recognition.onend = handlers.onEnd
  recognition.onerror = handlers.onEnd
  recognition.start()
  return () => recognition.stop()
}

const SEED_KEY = 'harness.profile.defaultAvatarSeed'
const AVATAR_KEY = 'harness.profile.defaultAvatarData'
const AVATAR_DATA_URL = /^data:image\/svg\+xml;charset=utf-8,/u
const WORKER_TIMEOUT_MS = 10_000

let memoryCache: { seed: string; dataUrl: string } | undefined
const pending = new Map<string, Promise<string>>()

export function normalizeDefaultProfileAvatarSeed(seed: string): string {
  return seed.trim() || 'TasteCode'
}

export function readDefaultProfileAvatar(seed: string): string | undefined {
  const normalized = normalizeDefaultProfileAvatarSeed(seed)
  if (memoryCache?.seed === normalized) return memoryCache.dataUrl

  try {
    if (localStorage.getItem(SEED_KEY) !== normalized) return undefined
    const dataUrl = localStorage.getItem(AVATAR_KEY)
    if (!dataUrl || !AVATAR_DATA_URL.test(dataUrl)) return undefined
    memoryCache = { seed: normalized, dataUrl }
    return dataUrl
  } catch {
    return undefined
  }
}

export function loadDefaultProfileAvatar(seed: string): Promise<string> {
  const normalized = normalizeDefaultProfileAvatarSeed(seed)
  const cached = readDefaultProfileAvatar(normalized)
  if (cached) return Promise.resolve(cached)

  const active = pending.get(normalized)
  if (active) return active

  const request = renderAvatar(normalized)
    .then((dataUrl) => {
      if (!AVATAR_DATA_URL.test(dataUrl))
        throw new Error('The avatar renderer returned invalid data.')
      writeCache(normalized, dataUrl)
      return dataUrl
    })
    .finally(() => pending.delete(normalized))
  pending.set(normalized, request)
  return request
}

function renderAvatar(seed: string): Promise<string> {
  if (typeof Worker === 'undefined') {
    return Promise.reject(new Error('This browser does not support avatar workers.'))
  }
  return renderInWorker(seed)
}

function renderInWorker(seed: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./default-profile-avatar.worker.js', import.meta.url), {
      type: 'module',
    })
    let settled = false
    const finish = (result: string | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.terminate()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timeout = setTimeout(
      () => finish(new Error('The avatar worker timed out.')),
      WORKER_TIMEOUT_MS,
    )
    worker.onmessage = (event: MessageEvent<unknown>) => {
      finish(typeof event.data === 'string' ? event.data : new Error('Invalid avatar response.'))
    }
    worker.onerror = () => finish(new Error('The avatar worker failed.'))
    worker.postMessage(seed)
  })
}

function writeCache(seed: string, dataUrl: string): void {
  memoryCache = { seed, dataUrl }
  try {
    localStorage.setItem(SEED_KEY, seed)
    localStorage.setItem(AVATAR_KEY, dataUrl)
  } catch {
    // The current renderer can still reuse the in-memory value.
  }
}

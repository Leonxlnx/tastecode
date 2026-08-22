import { useEffect, useState } from 'react'
import {
  loadDefaultProfileAvatar,
  normalizeDefaultProfileAvatarSeed,
  readDefaultProfileAvatar,
} from './default-profile-avatar.js'

type ResolvedAvatar = { seed: string; dataUrl: string | undefined }

export function useDefaultProfileAvatar(seed: string): string | undefined {
  const normalized = normalizeDefaultProfileAvatarSeed(seed)
  const [resolved, setResolved] = useState<ResolvedAvatar>(() => ({
    seed: normalized,
    dataUrl: readDefaultProfileAvatar(normalized),
  }))
  const visible =
    resolved.seed === normalized ? resolved.dataUrl : readDefaultProfileAvatar(normalized)

  useEffect(() => {
    let active = true
    const cached = readDefaultProfileAvatar(normalized)
    if (cached) {
      setResolved((current) =>
        current.seed === normalized && current.dataUrl === cached
          ? current
          : { seed: normalized, dataUrl: cached },
      )
      return () => {
        active = false
      }
    }

    setResolved((current) =>
      current.seed === normalized && current.dataUrl === undefined
        ? current
        : { seed: normalized, dataUrl: undefined },
    )
    const load = () => {
      void loadDefaultProfileAvatar(normalized).then(
        (dataUrl) => {
          if (active) setResolved({ seed: normalized, dataUrl })
        },
        () => undefined,
      )
    }
    const idle = globalThis.requestIdleCallback?.(load, { timeout: 1_500 })
    const timer = idle === undefined ? window.setTimeout(load, 0) : undefined
    return () => {
      active = false
      if (idle !== undefined) globalThis.cancelIdleCallback(idle)
      window.clearTimeout(timer)
    }
  }, [normalized])

  return visible
}

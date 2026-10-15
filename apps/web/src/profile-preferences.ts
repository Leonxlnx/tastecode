export type ProfileIdentityPreferences = {
  displayName: string
  avatarDataUrl?: string | undefined
  /** The word the generated picture is struck from, when it is not the name. */
  avatarSeed?: string | undefined
}

/** The fallback name and picture of a profile nobody has named yet. */
export const FALLBACK_PROFILE_NAME = 'Local profile'

/** What the generated picture is struck from: the chosen word, else the name. */
export function avatarSeedName(identity: ProfileIdentityPreferences | undefined): string {
  return identity?.avatarSeed?.trim() || identity?.displayName.trim() || FALLBACK_PROFILE_NAME
}

export const PROFILE_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'
export const PROFILE_IMAGE_MAX_BYTES = 1024 * 1024

const DISPLAY_NAME_KEY = 'harness.profile.displayName'
const AVATAR_KEY = 'harness.profile.avatar'
const AVATAR_SEED_KEY = 'harness.profile.avatarSeed'
const IMAGE_TYPES = new Set(PROFILE_IMAGE_ACCEPT.split(','))
const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/u

export function readProfileIdentityPreferences(): ProfileIdentityPreferences {
  try {
    const displayName = localStorage.getItem(DISPLAY_NAME_KEY)?.trim().slice(0, 64) ?? ''
    const avatarDataUrl = localStorage.getItem(AVATAR_KEY) ?? undefined
    const avatarSeed = localStorage.getItem(AVATAR_SEED_KEY)?.trim().slice(0, 64)
    return {
      displayName,
      ...(avatarDataUrl && DATA_URL.test(avatarDataUrl) ? { avatarDataUrl } : {}),
      ...(avatarSeed ? { avatarSeed } : {}),
    }
  } catch {
    return { displayName: '' }
  }
}

export function writeProfileIdentityPreferences(identity: ProfileIdentityPreferences): void {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, identity.displayName.trim().slice(0, 64))
    if (identity.avatarDataUrl) localStorage.setItem(AVATAR_KEY, identity.avatarDataUrl)
    else localStorage.removeItem(AVATAR_KEY)
    const avatarSeed = identity.avatarSeed?.trim().slice(0, 64)
    if (avatarSeed) localStorage.setItem(AVATAR_SEED_KEY, avatarSeed)
    else localStorage.removeItem(AVATAR_SEED_KEY)
  } catch {
    // The current session can still use the preference when storage is unavailable.
  }
}

export async function readProfileImage(file: File): Promise<string> {
  if (!IMAGE_TYPES.has(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.')
  if (file.size > PROFILE_IMAGE_MAX_BYTES) throw new Error('Choose an image smaller than 1 MB.')
  if (!(await hasExpectedSignature(file))) throw new Error('This file is not a valid image.')

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Read failed.'))
    })
    reader.addEventListener('error', () => reject(new Error('The image could not be read.')))
    reader.readAsDataURL(file)
  })
  if (!DATA_URL.test(dataUrl)) throw new Error('This file is not a valid image.')
  return dataUrl
}

async function hasExpectedSignature(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (file.type === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  }
  if (file.type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return (
    file.type === 'image/webp' &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
}

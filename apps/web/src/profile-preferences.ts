export type ProfileIdentityPreferences = {
  displayName: string
  avatarDataUrl?: string | undefined
}

export const PROFILE_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'
export const PROFILE_IMAGE_MAX_BYTES = 1024 * 1024

const DISPLAY_NAME_KEY = 'harness.profile.displayName'
const AVATAR_KEY = 'harness.profile.avatar'
const IMAGE_TYPES = new Set(PROFILE_IMAGE_ACCEPT.split(','))
const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/u

export function readProfileIdentityPreferences(): ProfileIdentityPreferences {
  const displayName = read(DISPLAY_NAME_KEY)?.trim().slice(0, 64) ?? ''
  const avatarDataUrl = read(AVATAR_KEY)
  return {
    displayName,
    ...(avatarDataUrl && DATA_URL.test(avatarDataUrl) ? { avatarDataUrl } : {}),
  }
}

export function writeProfileIdentityPreferences(identity: ProfileIdentityPreferences): void {
  write(DISPLAY_NAME_KEY, identity.displayName.trim().slice(0, 64))
  write(AVATAR_KEY, identity.avatarDataUrl)
}

export async function readProfileImage(file: File): Promise<string> {
  if (!IMAGE_TYPES.has(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.')
  if (file.size > PROFILE_IMAGE_MAX_BYTES) throw new Error('Choose an image smaller than 1 MB.')
  if (!(await hasExpectedSignature(file))) throw new Error('This file is not a valid image.')

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Read failed.')),
    )
    reader.addEventListener('error', () => reject(new Error('The image could not be read.')))
    reader.readAsDataURL(file)
  })
  if (!DATA_URL.test(dataUrl)) throw new Error('This file is not a valid image.')
  return dataUrl
}

export function profileInitials(value: string): string {
  const words = value.trim().split(/\s+/u).filter(Boolean)
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => Array.from(word)[0])
          .join('')
      : Array.from(words[0] ?? '')
          .slice(0, 2)
          .join('')
  return initials.toUpperCase() || 'P'
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

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: string | undefined): void {
  try {
    value ? localStorage.setItem(key, value) : localStorage.removeItem(key)
  } catch {
    // The current session can still use the preference when storage is unavailable.
  }
}

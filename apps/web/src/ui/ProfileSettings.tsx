import { useEffect, useRef, useState } from 'react'
import type { Account } from '@harness/contracts'
import { ImagePlus, Trash2 } from 'lucide-react'
import {
  PROFILE_IMAGE_ACCEPT,
  readProfileImage,
  type ProfileIdentityPreferences,
} from '../profile-preferences.js'
import { useDefaultProfileAvatar } from '../use-default-profile-avatar.js'

export function ProfileSettings(props: {
  account: Account | undefined
  providerName: string
  identity?: ProfileIdentityPreferences | undefined
  onIdentityChange?: ((updates: Partial<ProfileIdentityPreferences>) => void) | undefined
}) {
  const [imageError, setImageError] = useState<string>()
  const imageRequest = useRef(0)

  const chooseImage = async (file: File | undefined) => {
    if (!file) return
    const request = ++imageRequest.current
    setImageError(undefined)
    try {
      const avatarDataUrl = await readProfileImage(file)
      if (request === imageRequest.current) props.onIdentityChange?.({ avatarDataUrl })
    } catch (requestError) {
      if (request === imageRequest.current) {
        setImageError(requestError instanceof Error ? requestError.message : String(requestError))
      }
    }
  }

  useEffect(() => () => void (imageRequest.current += 1), [])

  const identity = profileIdentity(props.account, props.providerName, props.identity?.displayName)
  const avatarSeed =
    props.identity?.displayName.trim() || props.account?.email || props.providerName
  const defaultAvatar = useDefaultProfileAvatar(avatarSeed)
  const avatarFallback = avatarSeed.trim().charAt(0).toLocaleUpperCase() || 'T'

  return (
    <section className="profile-page" aria-labelledby="profile-title">
      <header className="profile-page__header">
        <h1 id="profile-title">Profile</h1>
      </header>
      <section className="profile-identity" aria-label="Profile identity">
        <div className="profile-identity__avatar" aria-hidden>
          {props.identity?.avatarDataUrl ? (
            <img src={props.identity.avatarDataUrl} alt="" />
          ) : defaultAvatar ? (
            <img src={defaultAvatar} alt="" />
          ) : (
            avatarFallback
          )}
        </div>
        <h2>{identity.name}</h2>
        <div className="profile-identity__meta">
          <span>{identity.handle}</span>
          {props.account?.plan ? (
            <span className="profile-identity__plan">{props.account.plan}</span>
          ) : null}
        </div>
        <div className="profile-identity__editor">
          <label className="profile-identity__field">
            <span>Display name</span>
            <input
              type="text"
              maxLength={64}
              value={props.identity?.displayName ?? ''}
              placeholder={identity.name}
              onChange={(event) => props.onIdentityChange?.({ displayName: event.target.value })}
            />
          </label>
          <div className="profile-identity__photo-actions">
            <label className="settings__action profile-identity__photo">
              <ImagePlus size={14} aria-hidden />
              <span>{props.identity?.avatarDataUrl ? 'Change photo' : 'Add photo'}</span>
              <input
                className="visually-hidden"
                type="file"
                accept={PROFILE_IMAGE_ACCEPT}
                onChange={(event) => {
                  void chooseImage(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
            </label>
            {props.identity?.avatarDataUrl ? (
              <button
                className="settings__action profile-identity__remove-photo"
                type="button"
                onClick={() => {
                  imageRequest.current += 1
                  setImageError(undefined)
                  props.onIdentityChange?.({ avatarDataUrl: undefined })
                }}
              >
                <Trash2 size={14} aria-hidden />
                <span>Remove</span>
              </button>
            ) : null}
          </div>
          <p className="profile-identity__photo-note">PNG, JPEG, or WebP · 1 MB maximum</p>
          {imageError ? (
            <p className="profile-identity__photo-error" role="alert">
              {imageError}
            </p>
          ) : null}
        </div>
      </section>
    </section>
  )
}

function profileIdentity(
  account: Account | undefined,
  providerName: string,
  displayName: string | undefined,
) {
  const localPart = account?.email?.split('@')[0]?.trim()
  const name = displayName?.trim() || (localPart ? titleCase(localPart) : 'Local profile')
  return {
    name,
    handle: localPart ? `@${localPart}` : providerName,
  }
}

function titleCase(value: string): string {
  return value.replace(/[._-]+/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}

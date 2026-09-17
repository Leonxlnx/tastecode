import { useEffect, useRef, useState } from 'react'
import type { Account } from '@harness/contracts'
import { IconPencil as Pencil, IconTrash as Trash2 } from '@tabler/icons-react'
import {
  PROFILE_IMAGE_ACCEPT,
  readProfileImage,
  type ProfileIdentityPreferences,
} from '../profile-preferences.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'

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

  const name = props.identity?.displayName?.trim() || 'Local profile'
  const hasPhoto = Boolean(props.identity?.avatarDataUrl)

  return (
    <section className="profile-page" aria-labelledby="profile-title">
      <header className="profile-page__header">
        <h1 id="profile-title">Profile</h1>
      </header>
      <section className="profile-identity" aria-label="Profile identity">
        <div className="profile-identity__portrait">
          <div className="profile-identity__avatar" aria-hidden>
            {props.identity?.avatarDataUrl ? (
              <img src={props.identity.avatarDataUrl} alt="" />
            ) : (
              <GeneratedAvatar name={name} />
            )}
          </div>
          <label
            className="profile-identity__edit"
            title={hasPhoto ? 'Change photo' : 'Upload photo'}
          >
            <Pencil size={13} aria-hidden />
            <span className="visually-hidden">{hasPhoto ? 'Change photo' : 'Upload photo'}</span>
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
        </div>
        <h2>{name}</h2>
        {props.account?.plan ? (
          <div className="profile-identity__meta">
            <span>{props.account.plan}</span>
          </div>
        ) : null}
        <div className="profile-identity__editor">
          <label className="profile-identity__field">
            <span>Display name</span>
            <input
              type="text"
              maxLength={64}
              value={props.identity?.displayName ?? ''}
              placeholder={name}
              onChange={(event) => props.onIdentityChange?.({ displayName: event.target.value })}
            />
          </label>
          {hasPhoto ? (
            <div className="profile-identity__photo-actions">
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
                <span>Remove photo</span>
              </button>
            </div>
          ) : null}
          <p className="profile-identity__photo-note">
            {hasPhoto
              ? 'Remove the photo to go back to the picture generated from your name.'
              : 'Generated from your name. Use the pencil to upload your own photo.'}
            <br />
            PNG, JPEG, or WebP · 1 MB maximum
          </p>
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

import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { Account } from '@harness/contracts'
import { IconDice5 as Dice } from '@tabler/icons-react'
import {
  FALLBACK_PROFILE_NAME,
  PROFILE_IMAGE_ACCEPT,
  readProfileImage,
  type ProfileIdentityPreferences,
} from '../profile-preferences.js'
import { ProfileCoin, useStruckName, type CoinSide } from './ProfileCoin.js'
import { SealGuideToggle, SealNotes } from './SealGuide.js'
import { Skeleton, SkeletonStatus } from './Skeleton.js'
import { isConfirmEnter } from '../shortcuts.js'
import '../styles/profile-settings.css'

// Words to strike a seal from when experimenting: concrete, varied in
// length and sound, so each roll looks clearly different.
const TRIAL_WORDS = [
  'harbor',
  'ember',
  'quartz',
  'lantern',
  'orbit',
  'fjord',
  'meadow',
  'cobalt',
  'juniper',
  'atlas',
  'saffron',
  'tundra',
  'willow',
  'comet',
  'basalt',
  'marlin',
  'sorrel',
  'glacier',
  'copper',
  'nimbus',
  'thistle',
  'onyx',
  'delta',
  'fable',
  'kestrel',
  'lumen',
  'mosaic',
  'prairie',
  'ripple',
  'sable',
  'tidal',
  'umber',
  'vesper',
  'zephyr',
  'cinder',
  'halcyon',
  'indigo',
  'larkspur',
  'monsoon',
  'obsidian',
] as const

function rollWord(current: string): string {
  const choices = TRIAL_WORDS.filter((word) => word !== current.trim().toLowerCase())
  return choices[Math.floor(Math.random() * choices.length)] ?? TRIAL_WORDS[0]
}

/** "JPEG, 12 KB", read from the data URL itself. */
function photoFacts(photo: string): string {
  const type = /^data:image\/(png|jpeg|webp);base64,/u.exec(photo)?.[1]
  const label = type === 'png' ? 'PNG' : type === 'jpeg' ? 'JPEG' : 'WebP'
  const base64 = photo.slice(photo.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = Math.max(0, (base64.length * 3) / 4 - padding)
  return `${label}, ${bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`}`
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

/**
 * Profile is one coin. Its two faces are the two pictures: the seal struck
 * from your name, and your photo. Turning it over is how the picture changes.
 */
export function ProfileSettings(props: {
  account: Account | undefined
  accountLoading?: boolean | undefined
  providerName: string
  identity?: ProfileIdentityPreferences | undefined
  onIdentityChange?: ((updates: Partial<ProfileIdentityPreferences>) => void) | undefined
}) {
  const [imageError, setImageError] = useState<string>()
  // The photo last turned away from, so turning over brings it back this
  // session without choosing the file again.
  const [setAside, setSetAside] = useState<string>()
  // Turned to the photo face before there is a photo on it.
  const [turned, setTurned] = useState(false)
  const [dropping, setDropping] = useState(false)
  const imageRequest = useRef(0)
  const drags = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => void (imageRequest.current += 1), [])

  const photo = props.identity?.avatarDataUrl
  // A refused file's error belongs to the picture it failed to replace.
  const [errorPhoto, setErrorPhoto] = useState(photo)
  if (errorPhoto !== photo) {
    setErrorPhoto(photo)
    setImageError(undefined)
  }
  const name = props.identity?.displayName?.trim() || FALLBACK_PROFILE_NAME
  const seed = props.identity?.avatarSeed?.trim() || undefined
  // A word being tried on the seal; empty means your name. Nothing is kept
  // until Keep this seal.
  const [trial, setTrial] = useState<string>()
  const trialId = useId()
  const notesId = useId()
  // The notes show while the "?" is hovered or focused, or after a click pins them.
  const [guideHovered, setGuideHovered] = useState(false)
  const [guidePinned, setGuidePinned] = useState(false)
  const trying = trial !== undefined
  const struck = useStruckName((trying ? trial.trim() : seed) || name)
  const guideOpen = trying && (guideHovered || guidePinned)
  const side: CoinSide = photo || turned || dropping ? 'photo' : 'seal'

  const chooseImage = async (file: File | undefined) => {
    if (!file) return
    const request = ++imageRequest.current
    setImageError(undefined)
    try {
      const avatarDataUrl = await readProfileImage(file)
      if (request !== imageRequest.current) return
      setSetAside(undefined)
      setTurned(false)
      props.onIdentityChange?.({ avatarDataUrl })
    } catch (requestError) {
      if (request === imageRequest.current) {
        setImageError(requestError instanceof Error ? requestError.message : String(requestError))
      }
    }
  }

  const turnOver = () => {
    if (setAside) {
      setSetAside(undefined)
      props.onIdentityChange?.({ avatarDataUrl: setAside })
      return
    }
    setTurned(true)
    fileInput.current?.click()
  }
  const turnBack = () => {
    imageRequest.current += 1
    setImageError(undefined)
    setTurned(false)
    if (!photo) return
    setSetAside(photo)
    props.onIdentityChange?.({ avatarDataUrl: undefined })
  }

  const keepTrial = () => {
    if (trial === undefined) return
    props.onIdentityChange?.({ avatarSeed: trial.trim() || undefined })
    setTrial(undefined)
  }
  const onTrialKey = (event: ReactKeyboardEvent) => {
    if (isConfirmEnter(event)) keepTrial()
    if (event.key !== 'Escape') return
    // Leave the trial, not Settings.
    event.preventDefault()
    setTrial(undefined)
  }

  const facts = imageError
    ? undefined
    : side === 'seal'
      ? seed
        ? `Struck from \u201c${seed}\u201d`
        : 'Struck from your name'
      : photo
        ? `Your photo · ${photoFacts(photo)}`
        : 'PNG, JPEG or WebP up to 1 MB'
  const plan = props.account?.plan ? (
    <span className="profile__plan">{props.account.plan} plan</span>
  ) : props.accountLoading && !props.account ? (
    <SkeletonStatus label="Loading account plan…" className="profile__plan">
      <Skeleton width={52} height={9} />
    </SkeletonStatus>
  ) : null

  return (
    <section
      className="settings__panel profile"
      aria-labelledby="settings-profile"
      onDragEnter={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        drags.current += 1
        setDropping(true)
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return
        drags.current = Math.max(0, drags.current - 1)
        if (drags.current === 0) setDropping(false)
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        drags.current = 0
        setDropping(false)
        setTurned(true)
        void chooseImage(event.dataTransfer.files[0])
      }}
    >
      <h1 className="settings__title" id="settings-profile">
        Profile
      </h1>
      {trying ? (
        <SealGuideToggle
          open={guideOpen}
          pinned={guidePinned}
          notesId={notesId}
          onHover={setGuideHovered}
          onPin={setGuidePinned}
        />
      ) : null}
      <div className="profile__stage">
        <div className="profile__coin">
          <ProfileCoin
            name={struck}
            // A photo turned away from stays on its face, so it is still there
            // while the coin turns back and when it turns over again.
            photo={photo ?? setAside}
            side={side}
            dropping={dropping}
            explain={guideOpen}
            label={side === 'seal' ? 'Turn over for a photo' : 'Turn back to the seal'}
            onTurn={side === 'seal' ? turnOver : turnBack}
          />
          {guideOpen ? <SealNotes id={notesId} word={struck} /> : null}
        </div>
        <input
          className="profile__name"
          type="text"
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          aria-label="Display name"
          value={props.identity?.displayName ?? ''}
          placeholder={FALLBACK_PROFILE_NAME}
          onChange={(event) => props.onIdentityChange?.({ displayName: event.target.value })}
        />
        {trying ? (
          <p className="profile__facts profile__facts--trying">
            <label htmlFor={trialId}>Struck from</label>
            <input
              id={trialId}
              className="profile__word"
              type="text"
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              value={trial}
              placeholder={name}
              onChange={(event) => setTrial(event.target.value)}
              onKeyDown={onTrialKey}
            />
            <button
              className="profile__roll"
              type="button"
              aria-label="Another word"
              title="Another word"
              onClick={(event) => {
                setTrial(rollWord(trial))
                // The die tumbles a half turn with each roll.
                event.currentTarget
                  .querySelector('svg')
                  ?.animate?.([{ rotate: '0deg' }, { rotate: '180deg' }], {
                    duration: 360,
                    easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
                  })
              }}
            >
              <Dice size={15} stroke={1.6} aria-hidden />
            </button>
          </p>
        ) : (
          <p className="profile__facts">
            {imageError ? (
              <span className="profile__error" role="alert">
                {imageError}
              </span>
            ) : (
              <span>{dropping ? 'Drop to use this photo' : facts}</span>
            )}
            {plan ? <span aria-hidden>·</span> : null}
            {plan}
          </p>
        )}
        <p className="profile__actions">
          {trying ? (
            <>
              <button className="profile__keep" type="button" onClick={keepTrial}>
                Keep this seal
              </button>
              <button type="button" onClick={() => setTrial(undefined)}>
                Cancel
              </button>
            </>
          ) : side === 'seal' ? (
            <>
              <button type="button" onClick={turnOver}>
                {setAside ? 'Turn over to your photo' : 'Turn over for a photo'}
              </button>
              <button type="button" onClick={() => setTrial(seed ?? '')}>
                Strike from a word
              </button>
              {seed ? (
                <button
                  type="button"
                  onClick={() => props.onIdentityChange?.({ avatarSeed: undefined })}
                >
                  Back to your name
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" onClick={() => fileInput.current?.click()}>
                {photo ? 'Replace' : 'Choose a photo'}
              </button>
              <button type="button" onClick={turnBack}>
                Turn back
              </button>
            </>
          )}
        </p>
      </div>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        tabIndex={-1}
        aria-hidden
        accept={PROFILE_IMAGE_ACCEPT}
        onChange={(event) => {
          void chooseImage(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </section>
  )
}

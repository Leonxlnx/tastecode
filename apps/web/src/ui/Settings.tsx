import { useState, type ReactNode } from 'react'
import type { Account, ProviderId } from '@harness/contracts'
import {
  ArrowLeft,
  Blocks,
  Database,
  Info,
  LogOut,
  Palette,
  RotateCcw,
  UserRound,
} from 'lucide-react'
import { isDesktop } from '../bridge.js'
import type { Transport } from '../transport.js'
import type { ThemePreference } from '../theme.js'
import { SkillsSettings } from './SkillsSettings.js'

type SettingsSection = 'account' | 'skills' | 'appearance' | 'data' | 'about'

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string }>

/**
 * Settings stays intentionally small: the sidebar reorganizes the decisions
 * the app already exposes without inventing preferences for their own sake.
 */
export function Settings(props: {
  provider: ProviderId
  providerName: string
  transport: Transport
  projectPath: string | undefined
  projectName: string | undefined
  account: Account | undefined
  projectCount: number
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
  onSignOut: () => void
  onReset: () => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SettingsSection>('account')

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings__titlebar" aria-hidden />

      <aside className="settings__sidebar">
        <button className="settings__back" type="button" onClick={props.onClose}>
          <ArrowLeft size={14} aria-hidden />
          <span>Back to app</span>
        </button>

        <p className="settings__nav-label">Settings</p>
        <nav className="settings__nav" aria-label="Settings categories">
          <SettingsNavItem
            active={section === 'account'}
            icon={<UserRound size={15} aria-hidden />}
            label="Account"
            onClick={() => setSection('account')}
          />
          <SettingsNavItem
            active={section === 'skills'}
            icon={<Blocks size={15} aria-hidden />}
            label="Skills"
            onClick={() => setSection('skills')}
          />
          <SettingsNavItem
            active={section === 'appearance'}
            icon={<Palette size={15} aria-hidden />}
            label="Appearance"
            onClick={() => setSection('appearance')}
          />
          <SettingsNavItem
            active={section === 'data'}
            icon={<Database size={15} aria-hidden />}
            label="Data"
            onClick={() => setSection('data')}
          />
          <SettingsNavItem
            active={section === 'about'}
            icon={<Info size={15} aria-hidden />}
            label="About"
            onClick={() => setSection('about')}
          />
        </nav>
      </aside>

      <main className="settings__main">
        <div className="settings__content">
          {section === 'account' ? <AccountSettings {...props} /> : null}
          {section === 'skills' ? <SkillsSettings {...props} /> : null}
          {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
          {section === 'data' ? <DataSettings {...props} /> : null}
          {section === 'about' ? <AboutSettings /> : null}
        </div>
      </main>
    </div>
  )
}

function SettingsNavItem(props: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`settings__nav-item${props.active ? ' is-active' : ''}`}
      type="button"
      aria-current={props.active ? 'page' : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}

function AccountSettings(props: {
  providerName: string
  account: Account | undefined
  onSignOut: () => void
}) {
  const accountStatus = props.account?.signedIn
    ? [props.account.email, props.account.plan].filter(Boolean).join(' · ') || 'Signed in'
    : 'Not signed in'

  return (
    <SettingsPanel title="Account" groupTitle="Provider">
      <SettingsRow title={props.providerName} note={accountStatus}>
        {props.account?.signedIn ? (
          <button className="settings__action" type="button" onClick={props.onSignOut}>
            <LogOut size={13} aria-hidden />
            <span>Sign out</span>
          </button>
        ) : null}
      </SettingsRow>
      <p className="settings__group-note">
        Signing out is handled by {props.providerName} itself. Personal Harness holds no credential
        to discard.
      </p>
    </SettingsPanel>
  )
}

function AppearanceSettings(props: {
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
}) {
  return (
    <SettingsPanel title="Appearance" groupTitle="Theme" groupClassName="settings__group--plain">
      <ThemePicker value={props.themePreference} onChange={props.onThemePreferenceChange} />
      {props.showMacOSFontSmoothing ? (
        <div className="appearance__text">
          <h2 className="settings__group-title">Text</h2>
          <div className="settings__group">
            <SettingsRow
              title="Font smoothing"
              note="Use macOS antialiasing for lighter, crisper text."
            >
              <button
                className={`switch${props.macOSFontSmoothing ? ' is-on' : ''}`}
                type="button"
                role="switch"
                aria-label="Font smoothing"
                aria-checked={props.macOSFontSmoothing}
                onClick={() => props.onMacOSFontSmoothingChange(!props.macOSFontSmoothing)}
              >
                <span className="switch__thumb" />
              </button>
            </SettingsRow>
          </div>
        </div>
      ) : null}
    </SettingsPanel>
  )
}

function ThemePicker(props: {
  value: ThemePreference
  onChange: (theme: ThemePreference) => void
}) {
  return (
    <fieldset className="theme-picker">
      <legend className="visually-hidden">Theme</legend>
      {THEME_OPTIONS.map((option) => {
        const selected = props.value === option.value

        return (
          <label className={`theme-option${selected ? ' is-selected' : ''}`} key={option.value}>
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={selected}
              onChange={() => props.onChange(option.value)}
            />
            <span className={`theme-preview theme-preview--${option.value}`} aria-hidden>
              <span className="theme-preview__header" />
              <span className="theme-preview__subhead" />
              <span className="theme-preview__panel">
                <span className="theme-preview__row">
                  <span className="theme-preview__row-title" />
                  <span className="theme-preview__row-copy" />
                </span>
                <span className="theme-preview__row">
                  <span className="theme-preview__row-title" />
                  <span className="theme-preview__row-copy" />
                </span>
              </span>
            </span>
            <span className="theme-option__label">{option.label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function DataSettings(props: { projectCount: number; onReset: () => void }) {
  const projectLabel = `${props.projectCount} ${props.projectCount === 1 ? 'project' : 'projects'} on this machine`

  return (
    <SettingsPanel title="Data" groupTitle="Local data">
      <SettingsRow
        title={projectLabel}
        note="Stored locally. Nothing is uploaded anywhere, by us or on your behalf."
      >
        <button className="settings__action" type="button" onClick={props.onReset}>
          <RotateCcw size={13} aria-hidden />
          <span>Reset app</span>
        </button>
      </SettingsRow>
    </SettingsPanel>
  )
}

function AboutSettings() {
  return (
    <SettingsPanel title="About" groupTitle="Personal Harness">
      <SettingsRow
        title="Personal Harness"
        note={`${isDesktop ? 'Desktop' : 'Browser'} · pre-release`}
      />
      <p className="settings__group-note">Open source, and built to be forked.</p>
    </SettingsPanel>
  )
}

function SettingsPanel(props: {
  title: string
  groupTitle: string
  groupClassName?: string
  children: ReactNode
}) {
  return (
    <section className="settings__panel" aria-labelledby={`settings-${props.title.toLowerCase()}`}>
      <h1 className="settings__title" id={`settings-${props.title.toLowerCase()}`}>
        {props.title}
      </h1>
      <h2 className="settings__group-title">{props.groupTitle}</h2>
      <div className={`settings__group${props.groupClassName ? ` ${props.groupClassName}` : ''}`}>
        {props.children}
      </div>
    </section>
  )
}

function SettingsRow(props: { title: string; note: string; children?: ReactNode }) {
  return (
    <div className="settings__row">
      <div className="settings__row-copy">
        <p className="settings__row-title">{props.title}</p>
        <p className="settings__row-note">{props.note}</p>
      </div>
      {props.children ? <div className="settings__row-control">{props.children}</div> : null}
    </div>
  )
}

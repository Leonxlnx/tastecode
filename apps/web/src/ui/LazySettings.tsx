import { lazy } from 'react'
import type { SettingsProps } from './Settings.js'

const Settings = lazy(() =>
  import('./Settings.js').then((module) => ({
    default: module.Settings,
  })),
)

export function LazySettings(props: SettingsProps) {
  return <Settings {...props} />
}

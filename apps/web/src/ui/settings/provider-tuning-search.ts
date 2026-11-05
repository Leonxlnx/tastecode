import {
  DEFAULT_ACCOUNT_ID,
  type Account,
  type ProviderAccount,
  type ProviderStatus,
} from '@harness/contracts'
import type { SettingsSearchEntry } from './settings-search.js'

/** These labels are shared with the rows they describe. */
export const TUNING_LABELS = {
  model: 'Model',
  access: 'Access',
  context: 'Context',
  runtime: 'Runtime',
} as const
/** The executable path control's label, shared with its search entry. */
export const EXECUTABLE_PATH_LABEL = 'Executable path'
export function executablePathSearchId(source: string): string {
  return `provider:${source}:executable-path`
}
/** Every provider row that runs its own CLI shows where that CLI is found. */
export function executablePathEntries(statuses: readonly ProviderStatus[]): SettingsSearchEntry[] {
  return statuses
    .filter((status) => status.id !== 'api' && status.id !== 'acp')
    .map((status) => ({
      id: executablePathSearchId(status.id),
      section: 'providers' as const,
      title: `${status.displayName} ${EXECUTABLE_PATH_LABEL}`,
      keywords: 'cli binary command location custom path',
    }))
}
export function tuningSearchId(provider: string, name: string, label: string): string {
  return `provider:${provider}:${name}:${label}`
}
export function providerTuningEntries(
  statuses: readonly ProviderStatus[],
  accounts: readonly ProviderAccount[],
  signedIn: ReadonlyMap<string, Account>,
): SettingsSearchEntry[] {
  return statuses.flatMap((status) => {
    const own = accounts.filter((account) => account.provider === status.id)
    const defaultAccount =
      own.length > 1 ? own.find((account) => account.id === DEFAULT_ACCOUNT_ID) : undefined
    const defaultName = defaultAccount
      ? `${status.displayName} · ${defaultAccount.label}`
      : status.displayName
    const names = [
      ...(signedIn.get(status.id)?.signedIn ? [{ name: defaultName, runtime: true }] : []),
      ...(status.installed && status.capabilities?.multipleAccounts === true ? own : [])
        .filter(
          (account) =>
            account.id !== DEFAULT_ACCOUNT_ID &&
            (account.email !== undefined || account.plan !== undefined),
        )
        .map((account) => ({ name: `${status.displayName} · ${account.label}`, runtime: false })),
    ]
    return names.flatMap(({ name, runtime }) =>
      [
        TUNING_LABELS.model,
        TUNING_LABELS.access,
        ...(status.capabilities?.context ? [TUNING_LABELS.context] : []),
        ...(runtime && (status.capabilities?.runtimes?.length ?? 0) > 1
          ? [TUNING_LABELS.runtime]
          : []),
      ].map((label) => ({
        id: tuningSearchId(status.id, name, label),
        section: 'providers' as const,
        title: `${name} ${label}`,
        keywords: 'provider defaults new chat',
      })),
    )
  })
}

import type { ProviderId, ProviderUpdate } from '@harness/contracts'
import { commandVersion, isInstalled } from '@harness/proc/cli'
import { cliVersion, isNewerVersion } from '@harness/proc/updates'
import { providerUpdateSources } from './providers.js'

type Sources = ReturnType<typeof providerUpdateSources>
type CheckResult = { update: ProviderUpdate; command?: string | undefined }
const CACHE_MS = 60 * 60_000

export class ProviderUpdateService {
  #cached = new Map<ProviderId, { result: CheckResult; expires: number }>()
  #pending = new Map<ProviderId, Promise<CheckResult>>()

  constructor(
    private sources: Sources = providerUpdateSources(),
    private system = { isInstalled, version: commandVersion },
  ) {}

  async list(refresh = false): Promise<ProviderUpdate[]> {
    return Promise.all(
      this.sources.map(async (source) => (await this.#check(source, refresh)).update),
    )
  }

  async commandFor(provider: ProviderId): Promise<string> {
    const source = this.sources.find((entry) => entry.provider === provider)
    if (!source) throw new Error('This provider does not support updates.')
    const { update, command } = await this.#check(source, true)
    if (update.error) throw new Error(update.error)
    if (!update.updateAvailable)
      throw new Error(`${source.displayName} has no newer version available.`)
    if (!command) throw new Error(`Update ${source.displayName} through its setup guide.`)
    return command
  }

  #check(source: Sources[number], refresh: boolean): Promise<CheckResult> {
    const pending = this.#pending.get(source.provider)
    // A verification requested after an update must not reuse a version read
    // that began while the installer was still running in another client.
    if (pending) return refresh ? pending.then(() => this.#check(source, true)) : pending
    const cached = this.#cached.get(source.provider)
    if (!refresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.result)
    const request = this.#probe(source)
      .then((result) => {
        this.#cached.set(source.provider, {
          result,
          expires: Date.now() + (result.update.error ? 60_000 : CACHE_MS),
        })
        return result
      })
      .finally(() => this.#pending.delete(source.provider))
    this.#pending.set(source.provider, request)
    return request
  }

  async #probe(source: Sources[number]): Promise<CheckResult> {
    const update: ProviderUpdate = {
      provider: source.provider,
      displayName: source.displayName,
      updateUrl: source.updater.url,
      updateAvailable: false,
      canUpdate: false,
    }
    try {
      if (!(await this.system.isInstalled(source.updater.command))) return { update }
      const current = await this.system.version(source.updater.command)
      const currentVersion = current && cliVersion(current)
      if (!currentVersion) throw new Error('Could not read the installed version. Try again later.')
      update.currentVersion = currentVersion
      const result = await source.updater.check(currentVersion)
      const latestVersion = cliVersion(result.latestVersion)
      if (!latestVersion) throw new Error('Could not read the latest release version.')
      return {
        update: {
          ...update,
          latestVersion,
          updateAvailable: isNewerVersion(currentVersion, latestVersion),
          canUpdate: Boolean(result.command),
        },
        command: result.command,
      }
    } catch (error) {
      return {
        update: {
          ...update,
          error: error instanceof Error ? error.message : 'Could not check for updates.',
        },
      }
    }
  }
}

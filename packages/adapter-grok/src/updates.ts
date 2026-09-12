import { runCli } from '@harness/proc/cli'
import { cliVersion, type CliUpdateSource } from '@harness/proc/updates'

export const GROK_UPDATES: CliUpdateSource = {
  command: 'grok',
  url: 'https://docs.x.ai/build/cli/reference',
  async check() {
    // The CLI owns channel selection and installer detection. This check never installs.
    const result = await runCli('grok', ['update', '--check', '--json'], 10_000)
    if (result.code !== 0) throw new Error('Could not check Grok updates. Try again later.')
    const data: unknown = JSON.parse(result.stdout)
    if (
      !data ||
      typeof data !== 'object' ||
      !('latestVersion' in data) ||
      typeof data.latestVersion !== 'string' ||
      !cliVersion(data.latestVersion) ||
      ('error' in data && data.error)
    ) {
      throw new Error('Grok did not return a release version. Try again later.')
    }
    return { latestVersion: data.latestVersion, command: 'grok update' }
  },
}

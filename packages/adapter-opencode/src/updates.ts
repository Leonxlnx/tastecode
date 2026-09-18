import { latestNpmVersion, type CliUpdateSource } from '@harness/proc/updates'

/** `opencode upgrade` detects the install layout itself — npm, brew, or the
 *  install script — so it is the right update command however the binary got
 *  onto PATH. The npm release is the canonical latest-version signal. */
export const OPENCODE_UPDATES: CliUpdateSource = {
  command: 'opencode',
  url: 'https://opencode.ai/en/docs/cli/',
  async check() {
    return { latestVersion: await latestNpmVersion('opencode-ai'), command: 'opencode upgrade' }
  },
}

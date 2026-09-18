import type { Account, ProviderStatus } from '@harness/contracts'
import { runCli } from '@harness/proc/cli'

type AuthStatus = ProviderStatus['auth']
type AuthRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr?: string | undefined }>

/** What `opencode auth list` reported — never the credential file itself. */
export type OpenCodeAuthList = {
  /** Display names listed under Credentials, in table order. */
  names: string[]
  /** Stored credentials the table footer reports. */
  credentials: number
}

// `auth list` draws a bordered table even without a TTY, so it has to be read
// after stripping terminal control bytes.
const ANSI =
  // oxlint-disable-next-line no-control-regex, no-useless-escape -- ANSI parsing requires control bytes.
  /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g

const SECTION_HEADER = /┌/
const SECTION_FOOTER = /└\s*(\d+)\s+(\S+)/
const CREDENTIAL_ENTRY = /^●\s+(.+?)\s+\S+\s*$/

/**
 * Read the table `opencode auth list` prints. Entries under Credentials carry
 * a display name and a credential type ("OpenRouter api"); the footer reports
 * the count. Environment entries are ambient variables, not sign-ins OpenCode
 * manages, so they are deliberately not counted as credentials here.
 *
 * Returns undefined when the output does not contain the credentials table at
 * all — a caller must not turn "we could not read it" into "not signed in".
 */
export function parseOpenCodeAuthList(output: string): OpenCodeAuthList | undefined {
  const text = output.replace(ANSI, '')
  let section: 'credentials' | 'other' | undefined
  let footerCount = 0
  let answered = false
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (SECTION_HEADER.test(line)) {
      section = /credentials/i.test(line) ? 'credentials' : 'other'
      continue
    }
    const footer = SECTION_FOOTER.exec(line)
    if (footer) {
      if (section === 'credentials' && /^credentials?$/i.test(footer[2] ?? '')) {
        answered = true
        footerCount = Math.max(footerCount, Number(footer[1]))
      }
      section = 'other'
      continue
    }
    if (section !== 'credentials') continue
    const entry = CREDENTIAL_ENTRY.exec(line.trimEnd())
    if (entry?.[1]) {
      answered = true
      names.add(entry[1].trim())
    }
  }
  if (!answered) return undefined
  return { names: [...names], credentials: Math.max(footerCount, names.size) }
}

/**
 * Whether OpenCode reports itself usable. A clean `auth list` means the agent
 * runs: its free tier needs no stored credential, so this is not a claim that
 * the user signed in — `openCodeAccount` reports that narrower state.
 */
export async function openCodeLoginStatus(run: AuthRunner = runCli): Promise<AuthStatus> {
  try {
    const result = await run('opencode', ['auth', 'list'])
    return result.code === 0 && parseOpenCodeAuthList(`${result.stdout}\n${result.stderr ?? ''}`)
      ? 'authenticated'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Whether OpenCode holds stored credentials, as its own CLI reports it. */
export async function openCodeAccount(run: AuthRunner = runCli): Promise<Account> {
  const result = await run('opencode', ['auth', 'list'])
  const listed = parseOpenCodeAuthList(`${result.stdout}\n${result.stderr ?? ''}`)
  if (!listed) {
    throw new Error(
      result.code === 0
        ? 'opencode auth list did not report credentials'
        : `opencode auth list exited with code ${result.code ?? 'unknown'}`,
    )
  }
  return { signedIn: listed.credentials > 0 }
}

/**
 * Sign out by asking the CLI to drop each credential it listed. `auth logout`
 * reports failures inside a zero-exit table, so the text is checked too.
 * Environment-variable credentials are ambient and cannot be removed here.
 */
export async function signOutOpenCode(run: AuthRunner = runCli): Promise<void> {
  const listed = parseOpenCodeAuthList(`${(await run('opencode', ['auth', 'list'])).stdout}\n`)
  if (!listed) throw new Error('OpenCode could not read its credentials.')
  for (const name of listed.names) {
    const result = await run('opencode', ['auth', 'logout', name])
    const output = `${result.stdout}\n${result.stderr ?? ''}`.replace(ANSI, '')
    if (result.code !== 0 || /\berror\b/i.test(output)) {
      throw new Error(`OpenCode could not sign out ${name}.`)
    }
  }
}

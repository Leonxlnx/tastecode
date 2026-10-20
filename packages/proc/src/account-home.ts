/**
 * How a provider CLI keeps one sign-in apart from another: each account is a
 * config folder of its own, selected by a variable the vendor documents. An
 * adapter that declares `multipleAccounts` exports one of these and applies it
 * to every process it starts for an account; shared code hands it an
 * account's folder and never names the variable itself.
 *
 * The CLI writes its credentials into that folder. Nothing here reads them
 * (rules/security.md).
 */
export type AccountHomeSource = {
  /** The folder the default account uses: the CLI's own, as the given environment selects it. */
  defaultHome(environment?: NodeJS.ProcessEnv): string
  /** The variables that point the CLI at `home`, to lay over the inherited environment. */
  environment(home: string): NodeJS.ProcessEnv
  /**
   * Settings a new account's folder starts with, as paths relative to the
   * default folder. Only non-secret configuration, never a sign-in or token file.
   */
  seedFiles: readonly string[]
  /**
   * Entries only a folder this CLI has used holds, relative to it. Checked for
   * existence alone, never opened, to offer folders already on the machine as
   * further accounts.
   */
  markers?: readonly string[]
}

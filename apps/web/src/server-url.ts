/** Where the renderer finds the local core server. */
export function serverBaseUrl(envUrl: string | undefined): string {
  return envUrl ?? 'ws://127.0.0.1:4311'
}

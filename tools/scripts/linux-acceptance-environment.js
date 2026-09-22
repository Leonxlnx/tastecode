import path from 'node:path'

export function acceptanceLaunchEnvironment(profile) {
  return {
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_STATE_HOME: path.join(profile, 'state'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    HARNESS_CONFIG_DIR: path.join(profile, 'server-config'),
  }
}

import { renderDefaultProfileAvatar } from './default-profile-avatar-renderer.js'

globalThis.addEventListener('message', (event: MessageEvent<string>) => {
  globalThis.postMessage(renderDefaultProfileAvatar(event.data))
  globalThis.close()
})

import { useEffect } from 'react'
import { Alert, Linking } from 'react-native'
import { Host } from '@expo/ui/swift-ui'
import { TasteApp } from '../../modules/tastecode-ui'
import { startBridge } from '../bridge'
import { pairWith, startLink } from '../state/app'

export function App() {
  useEffect(() => {
    startBridge()
    startLink()
    // The system camera opens tastecode://pair links straight into the app.
    const open = (url: string | null | undefined) => {
      if (!url?.startsWith('tastecode://pair')) return
      try {
        pairWith(url)
      } catch (error) {
        Alert.alert('Could not pair', error instanceof Error ? error.message : String(error))
      }
    }
    void Linking.getInitialURL().then(open)
    const subscription = Linking.addEventListener('url', ({ url }) => open(url))
    return () => subscription.remove()
  }, [])

  return (
    <Host style={{ flex: 1 }}>
      <TasteApp />
    </Host>
  )
}

import { useEffect, useState } from 'react'
import { Alert, Linking } from 'react-native'
import { Host, TabView } from '@expo/ui/swift-ui'
import { tint } from '@expo/ui/swift-ui/modifiers'
import { pairing, pairWith, startLink } from '../state/app'
import { useStore } from '../store'
import { ChatsScreen } from './ChatsScreen'
import { ComputerTab } from './ComputerScreen'
import { PairingScreen } from './PairingScreen'
import { Stack } from './navigation'
import { ProjectsScreen } from './ProjectsScreen'
import { ACCENT } from './theme'

export function App() {
  const paired = useStore(pairing)
  const [tab, setTab] = useState('chats')

  useEffect(() => {
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

  // Until the first link confirms the pairing, the phone is still pairing.
  const ready = paired !== undefined && paired.secret === undefined
  return (
    <Host style={{ flex: 1 }} seedColor={ACCENT}>
      {ready ? (
        <TabView selection={tab} onSelectionChange={setTab} modifiers={[tint(ACCENT)]}>
          <TabView.Tab value="chats" label="Chats" systemImage="bubble.left.and.text.bubble.right">
            <Stack>
              <ChatsScreen />
            </Stack>
          </TabView.Tab>
          <TabView.Tab value="projects" label="Projects" systemImage="folder">
            <Stack>
              <ProjectsScreen />
            </Stack>
          </TabView.Tab>
          <TabView.Tab value="computer" label="Computer" systemImage="laptopcomputer">
            <ComputerTab />
          </TabView.Tab>
        </TabView>
      ) : (
        <PairingScreen />
      )}
    </Host>
  )
}

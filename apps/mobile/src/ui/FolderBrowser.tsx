import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import * as Haptics from 'expo-haptics'
import type { ProjectBrowseResult } from '@harness/contracts'
import {
  Button,
  ContentUnavailableView,
  HStack,
  Image,
  List,
  Menu,
  NavigationDestination,
  NavigationLink,
  NavigationStack,
  ProgressView,
  Section,
  Spacer,
  Text,
  Toolbar,
  ToolbarItem,
} from '@expo/ui/swift-ui'
import {
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
} from '@expo/ui/swift-ui/modifiers'
import { connection, projects } from '../state/app'
import { message } from '../state/thread-session'
import { navigationSubtitle } from '../../modules/tastecode-ui'

/**
 * Choosing a project on the computer's disk, folder by folder, the way its
 * own folder picker would. Folders with a git repository are marked.
 */
export function FolderBrowserSheet(props: {
  onAdded: (path: string) => void
  onClose: () => void
}) {
  const [path, setPath] = useState<string[]>([])
  return (
    <NavigationStack
      path={path}
      onPathChange={setPath}
      modifiers={[presentationDetents(['large'])]}
    >
      <FolderList
        onAdded={props.onAdded}
        onClose={props.onClose}
        onJump={(target) => setPath([target])}
      />
      {path.map((folder) => (
        <NavigationDestination key={folder} value={folder}>
          <FolderList
            folder={folder}
            onAdded={props.onAdded}
            onClose={props.onClose}
            onJump={(target) => setPath([target])}
          />
        </NavigationDestination>
      ))}
    </NavigationStack>
  )
}

function FolderList(props: {
  folder?: string
  onAdded: (path: string) => void
  onClose: () => void
  onJump: (path: string) => void
}) {
  const [listing, setListing] = useState<ProjectBrowseResult>()
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    connection
      .request('projects.browse', props.folder ? { path: props.folder } : {})
      .then((result) => !cancelled && setListing(result))
      .catch((cause: unknown) => !cancelled && setError(message(cause)))
    return () => {
      cancelled = true
    }
  }, [props.folder])

  const add = async () => {
    if (!listing) return
    setAdding(true)
    try {
      await projects.add(listing.path)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      props.onAdded(listing.path)
    } catch (cause) {
      setAdding(false)
      Alert.alert('Could not add the project', message(cause))
    }
  }

  const title = listing
    ? listing.path === listing.home
      ? 'Home'
      : (listing.path.split(/[\\/]/).filter(Boolean).at(-1) ?? listing.path)
    : 'Choose a Folder'
  return (
    <Toolbar>
      <List
        modifiers={[
          navigationTitle(title),
          navigationBarTitleDisplayMode('inline'),
          navigationSubtitle(listing?.path ?? ''),
        ]}
      >
        {error ? (
          <ContentUnavailableView
            title="Cannot Open"
            systemImage="folder.badge.questionmark"
            description={error}
          />
        ) : null}
        {!listing && !error ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[foregroundStyle('secondary')]}>Reading folders…</Text>
          </HStack>
        ) : null}
        {listing && listing.folders.length === 0 ? (
          <Text modifiers={[foregroundStyle('secondary')]}>No folders inside.</Text>
        ) : null}
        {listing ? (
          <Section
            footer={listing.truncated ? <Text>Only the first folders are listed.</Text> : undefined}
          >
            {listing.folders.map((folder) => (
              <NavigationLink key={folder.path} value={folder.path}>
                <HStack spacing={12}>
                  <Image
                    systemName={folder.repository ? 'arrow.triangle.branch' : 'folder'}
                    modifiers={[foregroundStyle(folder.repository ? 'primary' : 'secondary')]}
                  />
                  <Text modifiers={[font({ textStyle: 'body' })]}>{folder.name}</Text>
                  <Spacer />
                  {folder.added ? (
                    <Text
                      modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}
                    >
                      Added
                    </Text>
                  ) : null}
                </HStack>
              </NavigationLink>
            ))}
          </Section>
        ) : null}
      </List>
      <Toolbar.Content>
        <ToolbarItem placement="cancellationAction">
          <Button role="close" onPress={props.onClose} />
        </ToolbarItem>
        {listing && listing.roots.length > 1 ? (
          <ToolbarItem placement="topBarLeading">
            <Menu label={<Image systemName="externaldrive" />}>
              {listing.roots.map((root) => (
                <Button key={root.path} label={root.name} onPress={() => props.onJump(root.path)} />
              ))}
            </Menu>
          </ToolbarItem>
        ) : null}
        <ToolbarItem placement="confirmationAction">
          <Button
            label="Add"
            onPress={() => void add()}
            modifiers={[buttonStyle('glassProminent'), disabled(!listing || adding)]}
          />
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  )
}

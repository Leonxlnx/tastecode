import { useMemo, useState } from 'react'
import {
  BottomSheet,
  Button,
  ContentUnavailableView,
  HStack,
  Image,
  List,
  NavigationLink,
  Section,
  Spacer,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui'
import {
  font,
  foregroundStyle,
  lineLimit,
  navigationBarTitleDisplayMode,
  navigationTitle,
  refreshable,
} from '@expo/ui/swift-ui/modifiers'
import { projects } from '../state/app'
import { isArchived, isWorking, lastActivity, needsYou } from '../state/projects'
import { useStore } from '../store'
import { ChatRow, LinkStatusRow } from './ChatsScreen'
import { FolderBrowserSheet } from './FolderBrowser'
import { route, useNavigator } from './nav'
import { ATTENTION } from './theme'

export function ProjectsScreen() {
  const navigator = useNavigator()
  const state = useStore(projects.state)
  const [browsing, setBrowsing] = useState(false)
  const sorted = useMemo(
    () =>
      [...state.projects].sort((left, right) =>
        left.pinned === right.pinned
          ? newest(right, state.activity) - newest(left, state.activity)
          : left.pinned
            ? -1
            : 1,
      ),
    [state.projects, state.activity],
  )
  return (
    <Toolbar>
      <ZStack>
        <List modifiers={[navigationTitle('Projects'), refreshable(() => projects.refresh())]}>
          <LinkStatusRow />
          {sorted.length === 0 && state.status === 'ready' ? (
            <ContentUnavailableView
              title="No Projects"
              systemImage="folder"
              description="Add a folder from your computer to start chats in it."
            />
          ) : null}
          {sorted.map((project) => {
            const active = project.sessions.filter((session) => !isArchived(session))
            const waiting = active.filter(needsYou).length
            const working = active.filter(isWorking).length
            return (
              <NavigationLink key={project.path} value={route('project', project.path)}>
                <HStack spacing={12}>
                  <Image
                    systemName={project.pinned ? 'pin.fill' : 'folder'}
                    modifiers={[foregroundStyle('secondary')]}
                  />
                  <VStack alignment="leading" spacing={2}>
                    <Text modifiers={[font({ textStyle: 'body', weight: 'medium' }), lineLimit(1)]}>
                      {project.name}
                    </Text>
                    <Text
                      modifiers={[
                        font({ textStyle: 'footnote' }),
                        foregroundStyle(waiting ? ATTENTION : 'secondary'),
                        lineLimit(1),
                      ]}
                    >
                      {waiting
                        ? `${waiting} ${waiting === 1 ? 'chat needs' : 'chats need'} you`
                        : working
                          ? `${working} working`
                          : `${active.length} ${active.length === 1 ? 'chat' : 'chats'}`}
                    </Text>
                  </VStack>
                  <Spacer />
                </HStack>
              </NavigationLink>
            )
          })}
        </List>
        <BottomSheet isPresented={browsing} onIsPresentedChange={setBrowsing}>
          <FolderBrowserSheet
            onAdded={(path) => {
              setBrowsing(false)
              navigator.push(route('project', path))
            }}
            onClose={() => setBrowsing(false)}
          />
        </BottomSheet>
      </ZStack>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Button onPress={() => setBrowsing(true)}>
            <Image systemName="folder.badge.plus" />
          </Button>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  )
}

function newest(
  project: { sessions: Parameters<typeof lastActivity>[0][] },
  activity: Readonly<Record<string, number>>,
): number {
  return project.sessions.reduce(
    (latest, session) => Math.max(latest, lastActivity(session, activity)),
    0,
  )
}

export function ProjectScreen(props: { path: string }) {
  const navigator = useNavigator()
  const state = useStore(projects.state)
  const project = state.projects.find((entry) => entry.path === props.path)
  const [showArchived, setShowArchived] = useState(false)
  const sessions = useMemo(() => {
    const all = (project?.sessions ?? []).map((session) => ({
      session,
      at: lastActivity(session, state.activity),
    }))
    all.sort((left, right) => right.at - left.at)
    return {
      active: all.filter(({ session }) => !isArchived(session)),
      archived: all.filter(({ session }) => isArchived(session)),
    }
  }, [project, state.activity])

  if (!project) {
    return (
      <ContentUnavailableView
        title="Project Not Found"
        systemImage="folder"
        description={props.path}
      />
    )
  }
  return (
    <Toolbar>
      <List modifiers={[navigationTitle(project.name), navigationBarTitleDisplayMode('large')]}>
        {sessions.active.length === 0 ? (
          <ContentUnavailableView
            title="No Chats"
            systemImage="bubble.left.and.text.bubble.right"
            description="Start the first chat in this project."
          />
        ) : (
          <Section title="Chats">
            {sessions.active.map(({ session, at }) => (
              <ChatRow
                key={session.id}
                session={session}
                project={project}
                at={at}
                showProject={false}
              />
            ))}
          </Section>
        )}
        {sessions.archived.length > 0 ? (
          <Section title="Archived" isExpanded={showArchived} onIsExpandedChange={setShowArchived}>
            {sessions.archived.map(({ session, at }) => (
              <ChatRow
                key={session.id}
                session={session}
                project={project}
                at={at}
                showProject={false}
              />
            ))}
          </Section>
        ) : null}
      </List>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Button onPress={() => navigator.push(route('new', project.path))}>
            <Image systemName="square.and.pencil" />
          </Button>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  )
}

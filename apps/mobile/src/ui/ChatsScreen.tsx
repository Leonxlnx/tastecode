import { useMemo, useState } from 'react'
import * as Haptics from 'expo-haptics'
import {
  Button,
  ContentUnavailableView,
  ContextMenu,
  HStack,
  Image,
  List,
  NavigationLink,
  ProgressView,
  Section,
  Spacer,
  SwipeActions,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
  useNativeState,
} from '@expo/ui/swift-ui'
import {
  controlSize,
  font,
  foregroundStyle,
  lineLimit,
  navigationTitle,
  refreshable,
  searchable,
  symbolEffect,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { connection, projects } from '../state/app'
import {
  isArchived,
  isWorking,
  lastActivity,
  needsYou,
  type Project,
  type Session,
} from '../state/projects'
import { useStore } from '../store'
import { providerName, sessionState, shortTime } from './format'
import { route, useNavigator } from './nav'
import { ATTENTION, FAILURE } from './theme'

type Entry = { session: Session; project: Project; at: number }

const RECENT_LIMIT = 60

export function ChatsScreen() {
  const navigator = useNavigator()
  const state = useStore(projects.state)
  const status = useStore(connection.status)
  const query = useNativeState('')
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const entries: Entry[] = []
    for (const project of state.projects) {
      for (const session of project.sessions) {
        if (isArchived(session) || session.lifecycle?.state === 'snoozed') continue
        if (
          needle &&
          !session.title.toLowerCase().includes(needle) &&
          !project.name.toLowerCase().includes(needle)
        ) {
          continue
        }
        entries.push({ session, project, at: lastActivity(session, state.activity) })
      }
    }
    entries.sort((left, right) => right.at - left.at)
    const attention = entries.filter((entry) => needsYou(entry.session))
    const working = entries.filter((entry) => !needsYou(entry.session) && isWorking(entry.session))
    const pinned = entries.filter(
      (entry) => entry.session.pinned && !needsYou(entry.session) && !isWorking(entry.session),
    )
    const recent = entries
      .filter(
        (entry) => !entry.session.pinned && !needsYou(entry.session) && !isWorking(entry.session),
      )
      .slice(0, RECENT_LIMIT)
    return { attention, working, pinned, recent, empty: entries.length === 0 }
  }, [state.projects, state.activity, filter])

  const offline = status.phase !== 'open' && status.phase !== 'idle'
  const loading = state.status === 'loading' || (state.status === 'idle' && !offline)

  return (
    <Toolbar>
      <List
        modifiers={[
          navigationTitle('Chats'),
          searchable(query, { prompt: 'Search chats', onChange: setFilter }),
          refreshable(() => projects.refresh()),
        ]}
      >
        {offline ? <LinkStatusRow /> : null}
        {groups.attention.length > 0 ? (
          <Section title="Needs you">
            {groups.attention.map((entry) => (
              <ChatRow key={entry.session.id} {...entry} />
            ))}
          </Section>
        ) : null}
        {groups.working.length > 0 ? (
          <Section title="Working">
            {groups.working.map((entry) => (
              <ChatRow key={entry.session.id} {...entry} />
            ))}
          </Section>
        ) : null}
        {groups.pinned.length > 0 ? (
          <Section title="Pinned">
            {groups.pinned.map((entry) => (
              <ChatRow key={entry.session.id} {...entry} />
            ))}
          </Section>
        ) : null}
        {groups.recent.length > 0 ? (
          <Section title="Recent">
            {groups.recent.map((entry) => (
              <ChatRow key={entry.session.id} {...entry} />
            ))}
          </Section>
        ) : null}
        {groups.empty && !loading ? (
          filter ? (
            <ContentUnavailableView
              title="No Results"
              systemImage="magnifyingglass"
              description={`No chat matches “${filter.trim()}”.`}
            />
          ) : (
            <ContentUnavailableView
              title="No Chats Yet"
              systemImage="bubble.left.and.text.bubble.right"
              description="Start one here or on your computer; it shows up in both places."
            />
          )
        ) : null}
        {groups.empty && loading ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[foregroundStyle('secondary')]}>Loading chats…</Text>
          </HStack>
        ) : null}
      </List>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Button
            onPress={() => {
              void Haptics.selectionAsync()
              navigator.push(route('new'))
            }}
          >
            <Image systemName="square.and.pencil" />
          </Button>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  )
}

/** Shown at the top of a list while the link to the computer is down. */
export function LinkStatusRow() {
  const status = useStore(connection.status)
  const name = connection.pairing?.name ?? 'your computer'
  if (status.phase === 'open' || status.phase === 'idle') return null
  const connecting = status.phase === 'connecting'
  return (
    <Section>
      <HStack spacing={12}>
        {connecting ? (
          <ProgressView />
        ) : (
          <Image systemName="wifi.exclamationmark" modifiers={[foregroundStyle('secondary')]} />
        )}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' })]}>
            {connecting ? `Connecting to ${name}…` : `${name} is not reachable`}
          </Text>
          {status.phase !== 'connecting' ? (
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>
              {status.error}
            </Text>
          ) : null}
        </VStack>
        <Spacer />
        {status.phase === 'waiting' ? (
          <Button
            label="Retry"
            onPress={() => connection.reconnectNow()}
            modifiers={[controlSize('small')]}
          />
        ) : null}
      </HStack>
    </Section>
  )
}

export function ChatRow(props: {
  session: Session
  project: Project
  at: number
  showProject?: boolean
}) {
  const { session, project } = props
  const state = sessionState(session)
  const working = state?.tone === 'working'
  const detail =
    state?.text ??
    `${props.showProject === false ? '' : `${project.name} · `}${providerName(session.provider)}`
  const tone =
    state?.tone === 'attention' ? ATTENTION : state?.tone === 'failed' ? FAILURE : undefined
  return (
    <SwipeActions>
      <ContextMenu>
        <ContextMenu.Trigger>
          <NavigationLink value={route('thread', session.id)}>
            <HStack spacing={12}>
              <VStack alignment="leading" spacing={3}>
                <HStack spacing={5}>
                  {session.pinned ? (
                    <Image
                      systemName="pin.fill"
                      size={11}
                      modifiers={[foregroundStyle('secondary')]}
                    />
                  ) : null}
                  <Text
                    modifiers={[
                      font({ textStyle: 'body', weight: session.unread ? 'semibold' : 'regular' }),
                      lineLimit(1),
                    ]}
                  >
                    {session.title || 'New chat'}
                  </Text>
                </HStack>
                <HStack spacing={5}>
                  {working ? (
                    <Image
                      systemName="ellipsis"
                      size={12}
                      modifiers={[
                        foregroundStyle('secondary'),
                        symbolEffect(
                          { effect: 'variableColor', fillStyle: 'iterative' },
                          { options: { repeat: 'continuous' } },
                        ),
                      ]}
                    />
                  ) : null}
                  <Text
                    modifiers={[
                      font({ textStyle: 'subheadline' }),
                      foregroundStyle(tone ?? 'secondary'),
                      lineLimit(1),
                    ]}
                  >
                    {detail}
                  </Text>
                </HStack>
              </VStack>
              <Spacer />
              <Text
                modifiers={[
                  font({ textStyle: 'footnote' }),
                  foregroundStyle(session.unread ? 'primary' : 'secondary'),
                ]}
              >
                {shortTime(props.at)}
              </Text>
            </HStack>
          </NavigationLink>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button
            label={session.pinned ? 'Unpin' : 'Pin'}
            systemImage={session.pinned ? 'pin.slash' : 'pin'}
            onPress={() => void projects.pinChat(session.id, !session.pinned)}
          />
          <Button
            label="Archive"
            systemImage="archivebox"
            onPress={() => void projects.archiveChat(session.id)}
          />
        </ContextMenu.Items>
      </ContextMenu>
      <SwipeActions.Actions edge="leading">
        <Button
          label={session.pinned ? 'Unpin' : 'Pin'}
          systemImage={session.pinned ? 'pin.slash.fill' : 'pin.fill'}
          onPress={() => void projects.pinChat(session.id, !session.pinned)}
          modifiers={[tint('orange')]}
        />
      </SwipeActions.Actions>
      <SwipeActions.Actions edge="trailing">
        <Button
          label="Archive"
          systemImage="archivebox.fill"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
            void projects.archiveChat(session.id)
          }}
          modifiers={[tint('indigo')]}
        />
      </SwipeActions.Actions>
    </SwipeActions>
  )
}

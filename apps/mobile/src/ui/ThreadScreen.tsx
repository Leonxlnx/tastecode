import { useEffect, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import * as Haptics from 'expo-haptics'
import type { ApprovalMode, Model } from '@harness/contracts'
import {
  BottomSheet,
  Button,
  HStack,
  Image,
  LazyVStack,
  Menu,
  ScrollView,
  Spacer,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
} from '@expo/ui/swift-ui'
import {
  defaultScrollAnchor,
  defaultScrollAnchorForRole,
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  navigationBarTitleDisplayMode,
  navigationTitle,
  padding,
  scrollDismissesKeyboard,
} from '@expo/ui/swift-ui/modifiers'
import { ChatBar, ChatScaffold, hideTabBar, navigationSubtitle } from '../../modules/tastecode-ui'
import { catalog, connection, projects, sessions } from '../state/app'
import {
  defaultModel,
  effortFor,
  preferences,
  sourceKey,
  type Choice,
  type Source,
} from '../state/catalog'
import { readNewChatChoice, startChat, type NewChatChoice } from '../state/new-chat'
import { findSession } from '../state/projects'
import { message, type ThreadSession } from '../state/thread-session'
import { useStore } from '../store'
import {
  AccessChip,
  ApprovalCard,
  ComposerStack,
  EffortChip,
  InputRow,
  ModelChip,
  ProjectChip,
  QuestionCard,
  QueueList,
  ChipRow,
  type Attachment,
} from './Composer'
import { ChangesSheet } from './ChangesSheet'
import { FolderBrowserSheet } from './FolderBrowser'
import { QuestionsSheet } from './QuestionsSheet'
import { buildRows, PlanCard, TranscriptRow, WorkingLine } from './Transcript'

export function ThreadScreen(props: { threadId?: string; newChatProject?: string | undefined }) {
  const [started, setStarted] = useState<string>()
  const threadId = props.threadId ?? started
  if (threadId) return <ThreadChat threadId={threadId} />
  return <NewChat initialProject={props.newChatProject} onStarted={setStarted} />
}

function useThreadSession(threadId: string): ThreadSession {
  const [session] = useState(() => sessions.acquire(threadId))
  useEffect(() => () => sessions.release(threadId), [threadId])
  return session
}

function ThreadChat(props: { threadId: string }) {
  const { threadId } = props
  const session = useThreadSession(threadId)
  const screen = useStore(session.state)
  const list = useStore(projects.state, (state) => state.projects)
  const linkOpen = useStore(connection.status, (status) => status.phase === 'open')
  const sources = useStore(catalog.state, (state) => state.sources)
  const found = useMemo(() => findSession(list, threadId), [list, threadId])
  const meta = found?.session
  const [answering, setAnswering] = useState(false)
  const [showingChanges, setShowingChanges] = useState(false)

  const source: Source | undefined = useMemo(() => {
    if (!meta) return undefined
    const key = sourceKey({
      provider: meta.provider,
      agent: meta.agent,
      connectionId: meta.connectionId,
      accountId: meta.accountId,
    })
    return sources.find((entry) => entry.key === key)
  }, [meta, sources])

  useEffect(() => {
    if (meta && !source && catalog.state.get().status === 'ready') {
      catalog.ensure({
        provider: meta.provider,
        agent: meta.agent,
        connectionId: meta.connectionId,
        accountId: meta.accountId,
      })
    }
  }, [meta, source])

  const [choice, setChoice] = useState<Choice>(() => {
    const saved = preferences.read<Choice & { source?: string }>(`thread:${threadId}`)
    return saved ? { model: saved.model, effort: saved.effort } : {}
  })
  const models = source?.models ?? []
  const model =
    models.find((entry) => entry.id === choice.model) ??
    models.find((entry) => entry.id === screen.view.model) ??
    defaultModel(models)
  const effort = effortFor(model, choice.effort)

  const choose = (next: Choice) => {
    setChoice(next)
    preferences.write(`thread:${threadId}`, { source: source?.key, ...next })
  }

  const switchTo = async (target: Source, picked: Model) => {
    if (target.key === source?.key) {
      choose({ model: picked.id, effort: effortFor(picked, choice.effort) })
      return
    }
    if (screen.view.running || screen.queue.length > 0) {
      Alert.alert(
        'Wait for this turn',
        'A chat can move to another provider once its turn has finished.',
      )
      return
    }
    try {
      await connection.request('thread.changeProvider', {
        threadId,
        provider: target.provider,
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.accountId ? { accountId: target.accountId } : {}),
        model: picked.id,
        ...(effortFor(picked, undefined) ? { effort: effortFor(picked, undefined) } : {}),
        approval: screen.approval,
      })
      preferences.write(`thread:${threadId}`, { source: target.key, model: picked.id })
      setChoice({ model: picked.id })
      void projects.refresh()
    } catch (error) {
      Alert.alert('Could not switch', message(error))
    }
  }

  const rows = useMemo(() => buildRows(screen.view), [screen.view])
  const { view } = screen
  const lastRow = rows.at(-1)
  const streaming = lastRow?.kind === 'assistant' && lastRow.item.status === 'started'
  const showWorking = view.running && !streaming && lastRow?.kind !== 'steps'
  const approval = view.approvals[0]
  const question = view.userInputs[0]

  const send = async (text: string, attachments: Attachment[]) => {
    try {
      projects.touch(threadId)
      await session.send(
        text,
        attachments.map((attachment) => attachment.path),
        { model: model?.id, effort },
      )
      return true
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      Alert.alert('Not sent', message(error))
      return false
    }
  }

  return (
    <Toolbar>
      <ChatScaffold
        modifiers={[
          navigationTitle(meta?.title || 'Chat'),
          navigationBarTitleDisplayMode('inline'),
          navigationSubtitle(linkOpen ? (found?.project.name ?? '') : 'Reconnecting…'),
          hideTabBar(),
        ]}
      >
        <ScrollView
          modifiers={[
            defaultScrollAnchor('bottom'),
            defaultScrollAnchorForRole('bottom', 'sizeChanges'),
            scrollDismissesKeyboard('interactively'),
          ]}
        >
          <LazyVStack
            alignment="leading"
            spacing={20}
            modifiers={[padding({ horizontal: 18, top: 12, bottom: 20 })]}
          >
            {screen.olderCursor ? (
              <HStack>
                <Spacer />
                <Button
                  label={screen.loadingOlder ? 'Loading…' : 'Show Earlier Messages'}
                  onPress={() => void session.loadOlder()}
                />
                <Spacer />
              </HStack>
            ) : null}
            {screen.status === 'loading' && rows.length === 0 ? (
              <WorkingLine label="Loading the chat…" />
            ) : null}
            {screen.status === 'error' && rows.length === 0 ? (
              <VStack spacing={10}>
                <Text modifiers={[foregroundStyle('secondary'), multilineTextAlignment('center')]}>
                  {screen.error ?? 'The chat could not be loaded.'}
                </Text>
                <Button label="Try Again" onPress={() => void session.load()} />
              </VStack>
            ) : null}
            {rows.map((row) => (
              <TranscriptRow
                key={row.key}
                row={row}
                turnTime={
                  row.kind === 'steps'
                    ? turnTime(view.turnStarted, view.turnEnded, row.turnId)
                    : undefined
                }
              />
            ))}
            {showWorking ? <WorkingLine label="Working…" /> : null}
            {view.running && view.plan.length > 0 ? <PlanCard steps={view.plan} /> : null}
          </LazyVStack>
        </ScrollView>
        <BottomSheet
          isPresented={answering && question !== undefined}
          onIsPresentedChange={setAnswering}
        >
          {question ? (
            <QuestionsSheet
              request={question}
              onSubmit={async (answers) => {
                await session.respondToUserInput(question.id, answers)
                setAnswering(false)
              }}
              onClose={() => setAnswering(false)}
            />
          ) : null}
        </BottomSheet>
        <BottomSheet isPresented={showingChanges} onIsPresentedChange={setShowingChanges}>
          {found ? (
            <ChangesSheet
              threadId={threadId}
              projectPath={found.project.path}
              onClose={() => setShowingChanges(false)}
            />
          ) : null}
        </BottomSheet>
        <ChatBar>
          <ComposerStack>
            {approval ? (
              <ApprovalCard
                key={approval.id}
                request={approval}
                onDecide={(decision) => session.respondToApproval(approval.id, decision)}
              />
            ) : null}
            {question && !approval ? (
              <QuestionCard request={question} onAnswer={() => setAnswering(true)} />
            ) : null}
            {screen.queue.length > 0 ? (
              <QueueList
                items={screen.queue}
                canSteer={screen.canSteer}
                onSteer={(id) =>
                  void session
                    .steer(id)
                    .catch((error: unknown) => Alert.alert('Could not send', message(error)))
                }
                onDelete={(id) => void session.deleteQueued(id).catch(() => undefined)}
              />
            ) : null}
            <ChipRow>
              <ModelChip
                sources={sources}
                current={source}
                model={model}
                switchable={!view.running && screen.queue.length === 0}
                onSelect={(target, picked) => void switchTo(target, picked)}
              />
              <EffortChip
                model={model}
                effort={effort}
                onSelect={(next) => choose({ ...choice, effort: next })}
              />
              <AccessChip
                source={source}
                approval={screen.approval}
                onSelect={(mode) =>
                  void session
                    .setApproval(mode)
                    .catch((error: unknown) =>
                      Alert.alert('Could not change access', message(error)),
                    )
                }
              />
            </ChipRow>
            <InputRow
              draftKey={threadId}
              running={view.running}
              canSend={linkOpen}
              allowImages={source?.capabilities?.images ?? true}
              placeholder={view.running ? 'Queue a message' : 'Message'}
              onSend={send}
              onStop={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid)
                void session
                  .interrupt()
                  .catch((error: unknown) => Alert.alert('Could not stop', message(error)))
              }}
            />
          </ComposerStack>
        </ChatBar>
      </ChatScaffold>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Menu label={<Image systemName="ellipsis" />}>
            <Button
              label="Changes"
              systemImage="plus.forwardslash.minus"
              onPress={() => setShowingChanges(true)}
            />
            {meta ? (
              <Button
                label={meta.pinned ? 'Unpin' : 'Pin'}
                systemImage={meta.pinned ? 'pin.slash' : 'pin'}
                onPress={() => void projects.pinChat(threadId, !meta.pinned)}
              />
            ) : null}
            {meta ? (
              <Button
                label="Archive"
                systemImage="archivebox"
                onPress={() => void projects.archiveChat(threadId)}
              />
            ) : null}
          </Menu>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  )
}

function turnTime(
  started: Readonly<Record<string, number>>,
  ended: Readonly<Record<string, number>>,
  turnId: string,
): number | undefined {
  const from = started[turnId]
  const to = ended[turnId]
  return from !== undefined && to !== undefined && to > from ? to - from : undefined
}

/** A chat that does not exist yet: choose where it runs, then the first prompt starts it. */
function NewChat(props: {
  initialProject: string | undefined
  onStarted: (threadId: string) => void
}) {
  const list = useStore(projects.state, (state) => state.projects)
  const sources = useStore(catalog.state, (state) => state.sources)
  const linkOpen = useStore(connection.status, (status) => status.phase === 'open')
  const [saved] = useState(readNewChatChoice)
  const [projectPath, setProjectPath] = useState(props.initialProject ?? saved.projectPath)
  const [sourceKeyChosen, setSourceKey] = useState(
    saved.source ? sourceKey(saved.source) : undefined,
  )
  const [choice, setChoice] = useState<Choice>({ model: saved.model, effort: saved.effort })
  const [approval, setApproval] = useState<ApprovalMode>(saved.approval ?? 'ask')
  const [isolate, setIsolate] = useState(saved.isolate ?? false)
  const [browsing, setBrowsing] = useState(false)
  const [pending, setPending] = useState<string>()

  useEffect(() => {
    if (catalog.state.get().status === 'idle') void catalog.load()
  }, [])

  const project =
    list.find((entry) => entry.path === projectPath) ?? (props.initialProject ? undefined : list[0])
  const usable = sources.filter((entry) => entry.status !== 'error')
  const source =
    usable.find((entry) => entry.key === sourceKeyChosen) ??
    usable.find((entry) => entry.models.length > 0) ??
    usable[0]
  const model =
    source?.models.find((entry) => entry.id === choice.model) ?? defaultModel(source?.models ?? [])
  const effort = effortFor(model, choice.effort)

  const send = async (text: string, attachments: Attachment[]) => {
    if (!project || !source) {
      Alert.alert(
        'Choose where to start',
        project ? 'No provider is ready on the computer.' : 'Pick a project first.',
      )
      return false
    }
    const next: NewChatChoice = {
      projectPath: project.path,
      source: {
        provider: source.provider,
        agent: source.agent,
        connectionId: source.connectionId,
        accountId: source.accountId,
      },
      model: model?.id,
      effort,
      approval,
      isolate,
    }
    setPending(text)
    try {
      const { threadId } = await startChat(
        next,
        text,
        attachments.map((attachment) => attachment.path),
      )
      props.onStarted(threadId)
      return true
    } catch (error) {
      setPending(undefined)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      Alert.alert('Could not start the chat', message(error))
      return false
    }
  }

  return (
    <ChatScaffold
      modifiers={[
        navigationTitle('New Chat'),
        navigationBarTitleDisplayMode('inline'),
        navigationSubtitle(project ? `${project.name}${isolate ? ' · private checkout' : ''}` : ''),
        hideTabBar(),
      ]}
    >
      <VStack
        spacing={10}
        modifiers={[padding({ horizontal: 32 }), frame({ maxWidth: 10_000, maxHeight: 10_000 })]}
      >
        <Spacer />
        {pending ? (
          <VStack spacing={14}>
            <Text modifiers={[font({ textStyle: 'body' }), multilineTextAlignment('center')]}>
              {pending}
            </Text>
            <WorkingLine label="Starting the chat…" />
          </VStack>
        ) : (
          <VStack spacing={8}>
            <Image
              systemName="sparkles"
              size={30}
              modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}
            />
            <Text
              modifiers={[
                font({ textStyle: 'title2', weight: 'semibold' }),
                multilineTextAlignment('center'),
              ]}
            >
              {project ? project.name : 'Pick a project'}
            </Text>
            <Text
              modifiers={[
                font({ textStyle: 'subheadline' }),
                foregroundStyle('secondary'),
                multilineTextAlignment('center'),
              ]}
            >
              {source
                ? `${source.name}${model ? ` · ${model.displayName}` : ''} runs on ${connection.pairing?.name ?? 'your computer'}.`
                : 'Loading providers…'}
            </Text>
          </VStack>
        )}
        <Spacer />
      </VStack>
      <ChatBar>
        <ComposerStack>
          <ChipRow>
            <ProjectChip
              projects={list}
              selected={project?.path}
              isolate={isolate}
              onSelect={setProjectPath}
              onIsolate={setIsolate}
              onAdd={() => setBrowsing(true)}
            />
            <ModelChip
              sources={usable}
              current={source}
              model={model}
              switchable
              onSelect={(target, picked) => {
                setSourceKey(target.key)
                setChoice({ model: picked.id, effort: effortFor(picked, choice.effort) })
              }}
            />
            <EffortChip
              model={model}
              effort={effort}
              onSelect={(next) => setChoice({ ...choice, effort: next })}
            />
            <AccessChip source={source} approval={approval} onSelect={setApproval} />
          </ChipRow>
          <InputRow
            draftKey={`new:${project?.path ?? ''}`}
            running={false}
            canSend={linkOpen && pending === undefined}
            allowImages={source?.capabilities?.images ?? true}
            placeholder={project ? `Ask anything in ${project.name}` : 'Message'}
            onSend={send}
            onStop={() => undefined}
          />
        </ComposerStack>
      </ChatBar>
      <BottomSheet isPresented={browsing} onIsPresentedChange={setBrowsing}>
        <FolderBrowserSheet
          onAdded={(path) => {
            setProjectPath(path)
            setBrowsing(false)
          }}
          onClose={() => setBrowsing(false)}
        />
      </BottomSheet>
    </ChatScaffold>
  )
}

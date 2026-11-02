import type { ApprovalMode } from '@harness/contracts'
import { catalog, projects } from '../state/app'
import { effortFor, sourceKey, type Source } from '../state/catalog'
import { startedSources } from './open-thread'
import { readNewChatChoice, startChat } from '../state/new-chat'
import { resolveModel, setupView } from '../view/catalog'
import type { NewChatView } from '../view/types'

type Draft = {
  projectPath: string | undefined
  isolate: boolean
  sourceKey: string | undefined
  model: string | undefined
  effort: string | undefined
  tier: string | undefined
  access: ApprovalMode
}

/** The chat about to start: where it runs and with what, remembered from the last one. */
export class NewChat {
  #draft: Draft

  constructor(private readonly push: (view: NewChatView) => void) {
    const saved = readNewChatChoice()
    this.#draft = {
      projectPath: saved.projectPath,
      isolate: saved.isolate ?? false,
      sourceKey: saved.source ? sourceKey(saved.source) : undefined,
      model: saved.model,
      effort: saved.effort,
      tier: saved.serviceTier,
      access: saved.approval ?? 'ask',
    }
    projects.state.subscribe(() => this.flush())
    catalog.state.subscribe(() => this.flush())
  }

  open(projectPath: string | null): void {
    if (projectPath) this.#draft = { ...this.#draft, projectPath }
    if (catalog.state.get().status === 'idle') void catalog.load()
    this.flush()
  }

  set(patch: Partial<Omit<Draft, 'tier'>> & { tier?: string | null }): void {
    const { tier, ...rest } = patch
    this.#set({ ...rest, ...(tier !== undefined ? { tier: tier ?? undefined } : {}) })
  }

  #set(patch: Partial<Draft>): void {
    const next = { ...this.#draft, ...patch }
    if (patch.sourceKey && patch.sourceKey !== this.#draft.sourceKey && !patch.model) {
      next.model = undefined
    }
    this.#draft = next
    this.flush()
  }

  #source(): Source | undefined {
    const usable = catalog.state.get().sources.filter((entry) => entry.status !== 'error')
    return (
      usable.find((entry) => entry.key === this.#draft.sourceKey) ??
      usable.find((entry) => entry.models.length > 0) ??
      usable[0]
    )
  }

  #project() {
    const list = projects.state.get().projects
    return list.find((entry) => entry.path === this.#draft.projectPath) ?? list[0]
  }

  view(): NewChatView {
    const project = this.#project()
    const source = this.#source()
    const model = resolveModel(source, this.#draft.model)
    return {
      projectPath: project?.path ?? null,
      projectName: project?.name ?? null,
      isolate: this.#draft.isolate,
      setup: setupView(
        source,
        model,
        { effort: this.#draft.effort, serviceTier: this.#tier(model) },
        this.#draft.access,
        true,
      ),
    }
  }

  flush(): void {
    this.push(this.view())
  }

  #tier(model: ReturnType<typeof resolveModel>): string | undefined {
    const tier = this.#draft.tier
    return tier && model?.serviceTiers.some((entry) => entry.id === tier) ? tier : undefined
  }

  async start(text: string, attachments: string[]): Promise<{ threadId: string }> {
    const project = this.#project()
    const source = this.#source()
    if (!project) throw new Error('Add a project first.')
    if (!source) throw new Error('No provider is ready on the computer.')
    const model = resolveModel(source, this.#draft.model)
    const { threadId } = await startChat(
      {
        projectPath: project.path,
        source: {
          provider: source.provider,
          agent: source.agent,
          connectionId: source.connectionId,
          accountId: source.accountId,
        },
        model: model?.id,
        effort: effortFor(model, this.#draft.effort),
        serviceTier: this.#tier(model),
        approval: this.#draft.access,
        isolate: this.#draft.isolate,
      },
      text,
      attachments,
    )
    startedSources.set(threadId, source.key)
    return { threadId }
  }
}

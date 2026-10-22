import type { ApprovalMode, Model } from '@harness/contracts'
import {
  accessLevels,
  defaultModel,
  effortFor,
  effortLabel,
  visibleModels,
  type CatalogState,
  type Choice,
  type Source,
} from '../state/catalog'
import type { CatalogView, SetupView, SourceView } from './types'

function sourceView(source: Source): SourceView {
  const { main, more } = visibleModels(source.models)
  const model = (entry: Model, extra: boolean) => ({
    id: entry.id,
    name: entry.displayName,
    more: extra,
    efforts: entry.reasoningEfforts.map((id) => ({ id, label: effortLabel(id) })),
    tiers: entry.serviceTiers.map(({ id, name }) => ({ id, name })),
  })
  return {
    key: source.key,
    name: source.name,
    status: source.status,
    images: source.capabilities?.images ?? true,
    models: [
      ...main.map((entry) => model(entry, false)),
      ...more.map((entry) => model(entry, true)),
    ],
    access: accessLevels(source.capabilities).map(({ mode, title, detail }) => ({
      mode,
      title,
      detail,
    })),
  }
}

export function catalogView(state: CatalogState): CatalogView {
  return { status: state.status, sources: state.sources.map(sourceView) }
}

/** The model a choice names, when its source still offers it; else the source's default. */
export function resolveModel(
  source: Source | undefined,
  ...preferred: Array<string | undefined>
): Model | undefined {
  const models = source?.models ?? []
  for (const id of preferred) {
    const found = id ? models.find((model) => model.id === id) : undefined
    if (found) return found
  }
  return defaultModel(models)
}

export function setupView(
  source: Source | undefined,
  model: Model | undefined,
  choice: Choice & { serviceTier?: string | undefined },
  access: ApprovalMode,
  switchable: boolean,
): SetupView {
  const effort = effortFor(model, choice.effort)
  const levels = accessLevels(source?.capabilities)
  const tier = model?.serviceTiers.find((entry) => entry.id === choice.serviceTier)
  return {
    sourceKey: source?.key ?? null,
    sourceName: source?.name ?? null,
    model: model?.id ?? null,
    modelName: model?.displayName ?? null,
    effort: effort ?? null,
    effortLabel: effort ? effortLabel(effort) : null,
    tier: tier?.id ?? null,
    tierName: tier?.name ?? null,
    access,
    accessTitle: levels.find((level) => level.mode === access)?.title ?? 'Ask first',
    images: source?.capabilities?.images ?? true,
    switchable,
  }
}

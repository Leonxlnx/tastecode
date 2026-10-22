import type { ApprovalMode, Model } from '@harness/contracts'
import {
  accessLevels,
  defaultModel,
  desktopChoiceKey,
  effortFor,
  effortLabel,
  visibleModels,
  type CatalogState,
  type Choice,
  type Source,
} from '../state/catalog'
import type { CatalogView, SetupView, SourceView } from './types'

/**
 * A source's models as the menus offer them. When the desktop told which
 * models its picker hides, the phone offers exactly the others, in one list
 * as the desktop does; otherwise the source's curated set comes first.
 */
function sourceView(source: Source, hidden: ReadonlySet<string>): SourceView {
  const shown = source.models.filter((model) => !hidden.has(desktopChoiceKey(source, model.id)))
  const { main, more } =
    hidden.size > 0 ? { main: shown, more: [] as Model[] } : visibleModels(source.models)
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

export function catalogView(
  state: CatalogState,
  hidden: ReadonlySet<string> = new Set(),
): CatalogView {
  return {
    status: state.status,
    sources: state.sources.map((source) => sourceView(source, hidden)),
  }
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

/** A model known only by its id, kept as it is with the effort it was chosen with. */
export function unlistedModel(id: string, effort: string | undefined): Model {
  return {
    id,
    displayName: id,
    isDefault: false,
    reasoningEfforts: effort ? [effort] : [],
    serviceTiers: [],
  }
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

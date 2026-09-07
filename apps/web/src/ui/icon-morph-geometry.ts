export type MorphPoint = Readonly<{ x: number; y: number }>

export type MorphTrack<TPaint> = Readonly<{
  points: readonly MorphPoint[]
  center: MorphPoint
  closed: boolean
  length: number
  paint: TPaint
}>

export type MorphTrackPair<TPaint> = Readonly<{
  from: MorphTrack<TPaint>
  to: MorphTrack<TPaint>
}>

function distanceSquared(a: MorphPoint, b: MorphPoint): number {
  const x = a.x - b.x
  const y = a.y - b.y
  return x * x + y * y
}

function trackCost<TPaint>(from: MorphTrack<TPaint>, to: MorphTrack<TPaint>): number {
  const centerCost = distanceSquared(from.center, to.center)
  const longest = Math.max(from.length, to.length, 1)
  const lengthDifference = ((from.length - to.length) / longest) * 8
  return centerCost + lengthDifference * lengthDifference
}

function sequenceCost(from: readonly MorphPoint[], to: readonly MorphPoint[]): number {
  let cost = 0
  for (const [index, point] of from.entries()) {
    cost += distanceSquared(point, to[index] ?? point)
  }
  return cost
}

function reverse(points: readonly MorphPoint[]): MorphPoint[] {
  return [...points].reverse()
}

function closedVariants(points: readonly MorphPoint[]): MorphPoint[][] {
  const loop = points.slice(0, -1)
  if (loop.length === 0) return [[...points]]

  const variants: MorphPoint[][] = []
  for (const direction of [loop, reverse(loop)]) {
    for (let offset = 0; offset < direction.length; offset += 1) {
      const rotated = [...direction.slice(offset), ...direction.slice(0, offset)]
      const first = rotated[0]
      if (first) variants.push([...rotated, first])
    }
  }
  return variants
}

function closestSequence(
  fixed: readonly MorphPoint[],
  candidates: readonly (readonly MorphPoint[])[],
): readonly MorphPoint[] {
  const initial = candidates[0]
  if (!initial) return fixed

  let best = initial
  let bestCost = sequenceCost(fixed, best)
  for (const candidate of candidates.slice(1)) {
    const cost = sequenceCost(fixed, candidate)
    if (cost < bestCost) {
      best = candidate
      bestCost = cost
    }
  }
  return best
}

function alignTracks<TPaint>(
  from: MorphTrack<TPaint>,
  to: MorphTrack<TPaint>,
): MorphTrackPair<TPaint> {
  let fromPoints = from.points
  let toPoints = to.points

  if (to.closed) {
    toPoints = closestSequence(fromPoints, closedVariants(toPoints))
  } else if (from.closed) {
    fromPoints = closestSequence(toPoints, closedVariants(fromPoints))
  } else {
    toPoints = closestSequence(fromPoints, [toPoints, reverse(toPoints)])
  }

  return {
    from: { ...from, points: fromPoints },
    to: { ...to, points: toPoints },
  }
}

function nearestTrack<TPaint>(
  track: MorphTrack<TPaint>,
  candidates: readonly MorphTrack<TPaint>[],
): MorphTrack<TPaint> {
  const initial = candidates[0]
  if (!initial) return track

  let closest = initial
  let closestCost = trackCost(track, closest)
  for (const candidate of candidates.slice(1)) {
    const cost = trackCost(track, candidate)
    if (cost < closestCost) {
      closest = candidate
      closestCost = cost
    }
  }
  return closest
}

/**
 * Pairs every visible stroke or fill in both icons. Extra tracks share their
 * nearest partner, so they join the new glyph instead of fading away.
 */
export function pairMorphTracks<TPaint>(
  from: readonly MorphTrack<TPaint>[],
  to: readonly MorphTrack<TPaint>[],
): MorphTrackPair<TPaint>[] {
  if (from.length === 0 || to.length === 0) return []

  const pairs: MorphTrackPair<TPaint>[] = []
  if (from.length >= to.length) {
    const unusedFrom = new Set(from.map((_, index) => index))
    for (const target of to) {
      let closestIndex = -1
      let closestCost = Number.POSITIVE_INFINITY
      for (const index of unusedFrom) {
        const source = from[index]
        if (!source) continue
        const cost = trackCost(source, target)
        if (cost < closestCost) {
          closestIndex = index
          closestCost = cost
        }
      }
      const source = from[closestIndex]
      if (source) pairs.push(alignTracks(source, target))
      unusedFrom.delete(closestIndex)
    }

    for (const index of unusedFrom) {
      const source = from[index]
      if (source) pairs.push(alignTracks(source, nearestTrack(source, to)))
    }
  } else {
    const unusedTo = new Set(to.map((_, index) => index))
    for (const source of from) {
      let closestIndex = -1
      let closestCost = Number.POSITIVE_INFINITY
      for (const index of unusedTo) {
        const target = to[index]
        if (!target) continue
        const cost = trackCost(source, target)
        if (cost < closestCost) {
          closestIndex = index
          closestCost = cost
        }
      }
      const target = to[closestIndex]
      if (target) pairs.push(alignTracks(source, target))
      unusedTo.delete(closestIndex)
    }

    for (const index of unusedTo) {
      const target = to[index]
      if (target) pairs.push(alignTracks(nearestTrack(target, from), target))
    }
  }
  return pairs
}

export function interpolateMorphPoints(
  from: readonly MorphPoint[],
  to: readonly MorphPoint[],
  progress: number,
): MorphPoint[] {
  return from.map((point, index) => {
    const target = to[index] ?? point
    return {
      x: point.x + (target.x - point.x) * progress,
      y: point.y + (target.y - point.y) * progress,
    }
  })
}

function coordinate(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

export function morphPath(points: readonly MorphPoint[]): string {
  const first = points[0]
  if (!first) return ''

  let path = `M${coordinate(first.x)} ${coordinate(first.y)}`
  for (const point of points.slice(1)) {
    path += `L${coordinate(point.x)} ${coordinate(point.y)}`
  }
  return path
}

import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type Simulation } from 'd3-force'

import type { LearningGraph, LearningNode } from '@/types/hermes'

import { RING_INNER, RING_OUTER, RING_STEPS } from './constants'
import { hash, nodeRadius, radiusForRecency } from './geometry'
import { formatDate } from './text'
import type { Ring, SimLink, SimNode } from './types'

export interface BuiltSim {
  byId: Map<string, SimNode>
  links: SimLink[]
  nodes: SimNode[]
  rings: Ring[]
  sim: Simulation<SimNode, SimLink>
}

// Build the radial time simulation: a node's distance from the core encodes its
// timestamp (radial force dominates; charge/collide only spread nodes around
// their date ring). Rings are dated gridlines across the time span.
export function buildSimulation(graph: LearningGraph, onTick: () => void): BuiltSim {
  const known = graph.nodes
    .map(n => (typeof n.timestamp === 'number' && Number.isFinite(n.timestamp) ? Number(n.timestamp) : null))
    .filter((v): v is number => v !== null)

  const minTs = known.length ? Math.min(...known) : null
  const maxTs = known.length ? Math.max(...known) : null
  const timed = minTs !== null && maxTs !== null && maxTs > minTs

  const ordered = [...graph.nodes].sort((a, b) => {
    const at = typeof a.timestamp === 'number' ? a.timestamp : Infinity
    const bt = typeof b.timestamp === 'number' ? b.timestamp : Infinity

    return at === bt ? a.id.localeCompare(b.id) : at - bt
  })

  const ordRatio = new Map(ordered.map((n, i) => [n.id, ordered.length > 1 ? i / (ordered.length - 1) : 0]))

  const ratioFor = (n: LearningNode): number => {
    if (timed && typeof n.timestamp === 'number' && minTs !== null && maxTs !== null) {
      return (Number(n.timestamp) - minTs) / (maxTs - minTs)
    }

    return ordRatio.get(n.id) ?? 0
  }

  const nodes: SimNode[] = graph.nodes.map(n => {
    const rec = ratioFor(n)
    const tr = radiusForRecency(rec)
    const angle = ((hash(n.id) % 3600) / 3600) * Math.PI * 2

    return { ...n, rec, tr, vx: 0, vy: 0, x: Math.cos(angle) * tr, y: Math.sin(angle) * tr }
  })

  const byId = new Map(nodes.map(n => [n.id, n]))

  const links: SimLink[] = graph.edges
    .filter(e => byId.has(e.source) && byId.has(e.target))
    .map(e => ({ source: e.source, target: e.target }))

  const sim = forceSimulation(nodes)
    .alphaDecay(0.05)
    .velocityDecay(0.62)
    .force('charge', forceManyBody<SimNode>().strength(-12))
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id(n => n.id)
        .distance(26)
        .strength(0.06)
    )
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius(n => nodeRadius(n) + 2)
        .iterations(2)
    )
    .force('radial', forceRadial<SimNode>(n => (n as SimNode).tr, 0, 0).strength(0.92))
    .on('tick', onTick)

  const rings: Ring[] = []

  for (let i = 0; i <= RING_STEPS; i += 1) {
    const ratio = i / RING_STEPS
    const r = RING_INNER + ratio * (RING_OUTER - RING_INNER)
    const label = timed && minTs !== null && maxTs !== null ? formatDate(Math.round(minTs + (maxTs - minTs) * ratio)) : null

    rings.push({ label, r, ratio })
  }

  return { byId, links, nodes, rings, sim }
}

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

import type { LearningGraph, LearningNode } from '@/types/hermes'

export type MemoryCard = LearningGraph['memory'][number]

export type Shape = 'circle' | 'diamond' | 'hexagon' | 'square' | 'triangle'

export interface Viewport {
  k: number
  x: number
  y: number
}

export interface Rgb {
  b: number
  g: number
  r: number
}

export interface Rect {
  h: number
  w: number
  x: number
  y: number
}

export interface SimNode extends LearningNode, SimulationNodeDatum {
  rec: number // recency 0 (oldest) → 1 (newest)
  tr: number // time-anchored target radius
  x: number
  y: number
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode | string
  target: SimNode | string
}

// Per-mode line/ring style.
export interface GraphParams {
  lineAlpha: number
  lineDash: number
  lineDashed: boolean
  lineWidth: number
  ringAlpha: number
  ringDash: number
  ringDashed: boolean
  ringWidth: number
}

// Per-mode ring/orb params (band wash, light-sliver size, ring outline alpha, orb sheen).
export interface RingParams {
  bandAlpha: number
  lightSize: number
  ringAlpha: number
  sheen: number
}

export interface Palette {
  bandInk: Rgb
  base: Rgb
  bg: Rgb
  c: GraphParams
  chipBg: string
  darkTheme: boolean
  inkInv: string
  memoryInk: Rgb
  skillInk: Rgb
}

export interface Ring {
  label: null | string
  r: number
  ratio: number
}

export interface Star {
  a: number
  r: number
  x: number
  y: number
}

export interface RingLabelRect {
  h: number
  i: number
  w: number
  x: number
  y: number
}

export interface FadeBuckets {
  labels: Map<string, number>
  links: Map<string, number>
  nodes: Map<string, number>
  rings: Map<string, number>
}

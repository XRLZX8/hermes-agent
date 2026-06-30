import { useStore } from '@nanostores/react'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { createDoubleTapDetector, isSmartZoomWheel } from '@/lib/trackpad-gestures'
import { $learningError, $learningGraph, $learningLoading, loadLearningGraph } from '@/store/learning'
import type { LearningGraph, LearningNode } from '@/types/hermes'

import { Panel, PanelEmpty, PanelHeader } from '../overlays/panel'

// ── The one view ────────────────────────────────────────────────────────────
// A tilted, top-down EVE-style star map of what Hermes has learned. Time is
// RADIAL: oldest learning sits at the galactic core, newer memories/skills
// accrete onto outer rings. The disk is tilted for depth; recent systems burn
// hot while old ones cool toward the core. Hover lights a constellation and
// shows a dated tooltip; click locks focus. Canvas-rendered. No modes.

const RING_INNER = 48
const RING_OUTER = 340
const ZOOM_MIN = 0.3
const ZOOM_MAX = 5
const FIT_PADDING = 80
const TILT = 0.6 // vertical squash → "looking down at a tilted disk"

interface Viewport {
  k: number
  x: number
  y: number
}

interface SimNode extends LearningNode, SimulationNodeDatum {
  rec: number // recency 0 (oldest) → 1 (newest)
  tr: number // time-anchored target radius
  x: number
  y: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode | string
  target: SimNode | string
}

interface Rgb {
  b: number
  g: number
  r: number
}

interface Rect {
  h: number
  w: number
  x: number
  y: number
}

// Fixed recency (age) gradient — old content quiet, recent content bright.
const AGE_GRADIENT = { mid: 0.52, midInk: 0.62, newInk: 0.82, oldInk: 0.24, reach: 1 }

// Per-mode line/ring defaults (curated). The controls seed from the active
// theme and reset to its set on toggle.
interface GraphParams {
  lineAlpha: number
  lineDash: number
  lineDashed: boolean
  lineWidth: number
  ringAlpha: number
  ringDash: number
  ringDashed: boolean
  ringWidth: number
}

const MODE_DEFAULTS: Record<'dark' | 'light', GraphParams> = {
  dark: {
    lineAlpha: 0.16,
    lineDash: 1,
    lineDashed: true,
    lineWidth: 0.5,
    ringAlpha: 0.1,
    ringDash: 4,
    ringDashed: false,
    ringWidth: 1.5
  },
  light: {
    lineAlpha: 0.18,
    lineDash: 1,
    lineDashed: true,
    lineWidth: 0.5,
    ringAlpha: 0.06,
    ringDash: 4,
    ringDashed: false,
    ringWidth: 2
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function hash(input: string): number {
  let h = 2166136261

  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }

  return h >>> 0
}

// Theme-driven palette: structure stays close to foreground ink, while node
// groups borrow subtle color from the active desktop theme. Recency is conveyed
// by opacity; memory vs skill is shape + restrained theme tint.
//
// Theme tokens come through `color-mix()`/oklch, so getComputedStyle returns a
// non-rgb() string. Rasterize it through a 1x1 canvas to get real sRGB bytes —
// naive string parsing of oklab()/color(srgb …) silently yields black.
let _probe: CanvasRenderingContext2D | null = null

function resolveRgb(color: string): Rgb {
  if (!_probe) {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    _probe = c.getContext('2d', { willReadFrequently: true })
  }

  if (!_probe) {
    return { b: 184, g: 163, r: 148 }
  }

  _probe.clearRect(0, 0, 1, 1)
  _probe.fillStyle = '#888888'
  _probe.fillStyle = color
  _probe.fillRect(0, 0, 1, 1)
  const d = _probe.getImageData(0, 0, 1, 1).data

  return { b: d[2], g: d[1], r: d[0] }
}

function rgba(c: Rgb, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const p = clamp(t, 0, 1)

  return {
    b: Math.round(a.b + (b.b - a.b) * p),
    g: Math.round(a.g + (b.g - a.g) * p),
    r: Math.round(a.r + (b.r - a.r) * p)
  }
}

function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.114 * b) / 255
}

interface Palette {
  base: Rgb
  bandInk: Rgb
  bg: Rgb
  c: GraphParams
  chipBg: string
  darkTheme: boolean
  inkInv: string
  memoryInk: Rgb
  skillInk: Rgb
}

// Resolve the theme-derived palette once per theme change — the resolveRgb
// probe does a getImageData readback, so this stays out of the per-frame path.
function computePalette(canvas: HTMLCanvasElement): Palette {
  const style = getComputedStyle(canvas)
  const fg = resolveRgb(style.color)
  const darkTheme = luminance(fg.r, fg.g, fg.b) > 0.55
  const base: Rgb = darkTheme ? { b: 255, g: 255, r: 255 } : { b: 0, g: 0, r: 0 }
  const primary = resolveRgb(style.getPropertyValue('--theme-primary').trim() || style.color)

  const secondary = resolveRgb(
    style.getPropertyValue('--theme-secondary').trim() ||
      style.getPropertyValue('--theme-midground').trim() ||
      style.color
  )

  const bg = resolveRgb(
    style.getPropertyValue('--background').trim() ||
      style.getPropertyValue('--dt-background').trim() ||
      (darkTheme ? '#000' : '#fff')
  )

  return {
    // Band tint derives from the theme primary so the rings read consistently
    // in both modes (foreground ink would go white on dark / black on light).
    bandInk: mixRgb(primary, base, darkTheme ? 0.3 : 0),
    base,
    bg,
    c: MODE_DEFAULTS[darkTheme ? 'dark' : 'light'],
    chipBg: darkTheme ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.85)',
    darkTheme,
    inkInv: darkTheme ? 'rgba(0,0,0,1)' : 'rgba(255,255,255,1)',
    memoryInk: mixRgb(secondary, base, darkTheme ? 0.08 : 0.14),
    skillInk: mixRgb(primary, base, darkTheme ? 0.12 : 0.18)
  }
}

function nodeRadius(n: LearningNode): number {
  if (n.kind === 'memory') {
    return 4.4
  }

  const base = n.state === 'archived' || n.state === 'stale' ? 2.4 : 3

  return base + Math.sqrt(Math.max(0, n.useCount)) * 0.55 + (n.pinned ? 0.8 : 0)
}

// Node glyphs — pure path geometry (the seam a future sprite/instanced renderer
// would bake from).
type Shape = 'circle' | 'diamond' | 'hexagon' | 'square' | 'triangle'

const NODE_SHAPE: Record<LearningNode['kind'], Shape> = { memory: 'diamond', skill: 'circle' }

const WHITE: Rgb = { b: 255, g: 255, r: 255 }
const BLACK: Rgb = { b: 0, g: 0, r: 0 }

// Darken the orb body so a bright primary doesn't swallow the sheen (the
// highlight is computed from the original ink, so it still reads). Tweak.
const ORB_DARKEN = 0.3

// Sheen forced this high when the orb ink is near-white (a white body needs a
// pure-white core to read as a sphere at all).
const WHITEISH_SHEEN = 0.95

interface RingParams {
  bandAlpha: number
  lightSize: number
  ringAlpha: number
  sheen: number
}

// Per-mode ring/orb params (band wash, light sliver size, ring outline alpha,
// orb sheen). Curated; the renderer picks the set by active theme.
const RING_PARAMS: Record<'dark' | 'light', RingParams> = {
  dark: { bandAlpha: 0.01, lightSize: 0.64, ringAlpha: 0.03, sheen: 0.12 },
  light: { bandAlpha: 0.03, lightSize: 0.27, ringAlpha: 0.04, sheen: 0.1 }
}

// Flat wash alpha for a lit (hovered/selected) date's band. The focused ring
// outline derives from this (×2).
const LIT_BAND_ALPHA = 0.04

function darken(c: Rgb, amount: number): Rgb {
  return mixRgb(c, BLACK, amount)
}

// Fill the current path as a lit sphere: an offset radial gradient from a hot
// core → darkened body → translucent rim, so a flat circle reads with volume.
// `strength` controls how white the core highlight is; `bodyDarken` darkens the
// body (0 for active/hover nodes, so they pop full bright like before).
function sphereFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  ink: Rgb,
  strength: number,
  bodyDarken: number
): void {
  // Darkening a near-white ink just greys it out (cringe). Detect whiteness
  // (bright + desaturated): skip the darken AND force a near-full sheen so the
  // white core still reads against the off-white body.
  const mx = Math.max(ink.r, ink.g, ink.b)
  const mn = Math.min(ink.r, ink.g, ink.b)
  const sat = mx ? (mx - mn) / mx : 0
  const whiteness = clamp((luminance(ink.r, ink.g, ink.b) - 0.7) / 0.3, 0, 1) * (1 - sat)
  const eff = strength + (WHITEISH_SHEEN - strength) * whiteness
  const hi = mixRgb(ink, WHITE, 0.7 * eff)
  const body = darken(ink, bodyDarken * (1 - whiteness))
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r * 1.15)
  g.addColorStop(0, rgba(hi, 1))
  g.addColorStop(0.5, rgba(body, 1))
  g.addColorStop(1, rgba(body, 0.85))
  ctx.fillStyle = g
  ctx.fill()
}

// Trace a centred geometric shape of radius r into the current path.
function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, r: number): void {
  ctx.beginPath()

  if (shape === 'square') {
    ctx.rect(x - r, y - r, r * 2, r * 2)

    return
  }

  if (shape === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2)

    return
  }

  const pts = shape === 'diamond' ? 4 : shape === 'triangle' ? 3 : 6
  // Diamond/triangle point up; hexagon is flat-topped.
  const rot = shape === 'hexagon' ? Math.PI / 6 : -Math.PI / 2

  for (let i = 0; i < pts; i += 1) {
    const a = rot + (i / pts) * Math.PI * 2
    const px = x + Math.cos(a) * r
    const py = y + Math.sin(a) * r

    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  }

  ctx.closePath()
}

function formatDate(ts?: null | number): string {
  if (!ts) {
    return 'unknown'
  }

  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return 'unknown'
  }
}

// Tag-style badge items for the hover tooltip — date first. Use-count is NOT a
// badge (rendered separately, right-aligned) so it's excluded here.
function metaBadges(n: LearningNode): string[] {
  const out: string[] = [formatDate(n.timestamp)]

  if (n.kind === 'memory') {
    out.push(n.memorySource === 'profile' ? 'profile memory' : 'memory')
  } else {
    out.push(n.category)

    if (n.createdBy === 'agent') {
      out.push('learned')
    }

    if (n.pinned) {
      out.push('pinned')
    }
  }

  return out.filter(Boolean)
}

// Bare "xN" use-count, last in the badge row. Null when never used.
function countLabel(n: LearningNode): null | string {
  return n.kind === 'skill' && n.useCount > 0 ? `x${n.useCount}` : null
}

// Footer-row content for the tooltip. Reserved primitive — returns nothing for
// now (skills have no UUID; their id is just the name). Wire real detail here
// later and the tooltip will lay it out automatically.
function nodeFooter(node: LearningNode): null | string {
  void node

  return null
}

// Greedy word-wrap for the tooltip title so long memory lines don't blow out.
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const next = line ? `${line} ${word}` : word

    if (!line || ctx.measureText(next).width <= maxW) {
      line = next
    } else {
      lines.push(line)
      line = word
    }
  }

  if (line) {
    lines.push(line)
  }

  return lines
}

// Trim to fit maxW, appending an ellipsis (keeps floating labels compact so
// they don't span the overlay).
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) {
    return text
  }

  let s = text

  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) {
    s = s.slice(0, -1)
  }

  return `${s.trimEnd()}…`
}

function fitViewport(w: number, h: number): Viewport {
  if (w <= 0 || h <= 0) {
    return { k: 1, x: w / 2, y: h / 2 }
  }

  const spanX = (RING_OUTER + 30) * 2
  const spanY = spanX * TILT
  const k = clamp(Math.min((w - FIT_PADDING * 2) / spanX, (h - FIT_PADDING * 2) / spanY, 2.2), ZOOM_MIN, ZOOM_MAX)

  return { k, x: w / 2, y: h / 2 }
}

function StarMap({ graph }: { graph: LearningGraph }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const simRef = useRef<null | Simulation<SimNode, SimLink>>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const byIdRef = useRef(new Map<string, SimNode>())
  const adjacencyRef = useRef(new Map<string, Set<string>>())
  const memByIdRef = useRef(new Map<string, LearningGraph['memory'][number]>())
  const ringsRef = useRef<Array<{ label: null | string; r: number; ratio: number }>>([])
  const ringLabelRectsRef = useRef<Array<{ h: number; i: number; w: number; x: number; y: number }>>([])
  const starsRef = useRef<Array<{ a: number; r: number; x: number; y: number }>>([])

  const fadeRef = useRef({
    labels: new Map<string, number>(),
    links: new Map<string, number>(),
    nodes: new Map<string, number>(),
    rings: new Map<string, number>()
  })

  const doubleTapRef = useRef(createDoubleTapDetector())
  const paletteRef = useRef<null | Palette>(null)
  const themeDirtyRef = useRef(true)
  const invalidateRef = useRef<() => void>(() => {})
  const viewportRef = useRef<Viewport>({ k: 1, x: 0, y: 0 })
  const hoverRef = useRef<null | string>(null)
  const hoveredRingRef = useRef<null | number>(null)
  const selectedRingRef = useRef<null | number>(null)
  const selectedIdRef = useRef<null | string>(null)
  const sizeRef = useRef({ h: 0, w: 0 })
  const dprRef = useRef(1)
  const dirtyRef = useRef(true)

  const dragRef = useRef<{
    id: null | string
    mode: 'none' | 'pan'
    moved: boolean
    ring: null | number
    sx: number
    sy: number
    vp: Viewport
  }>({ id: null, mode: 'none', moved: false, ring: null, sx: 0, sy: 0, vp: { k: 1, x: 0, y: 0 } })

  const [selectedId, setSelectedId] = useState<null | string>(null)
  const [size, setSize] = useState({ h: 0, w: 0 })
  const loading = useStore($learningLoading)

  // Mark the canvas dirty and wake the (otherwise-idle) render loop.
  const invalidate = useCallback(() => invalidateRef.current(), [])

  const memById = useMemo(() => {
    const m = new Map<string, LearningGraph['memory'][number]>()
    graph.memory.forEach((card, i) => m.set(`memory:${card.source}:${i}`, card))

    return m
  }, [graph.memory])

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>()

    for (const n of graph.nodes) {
      m.set(n.id, new Set())
    }

    for (const e of graph.edges) {
      m.get(e.source)?.add(e.target)
      m.get(e.target)?.add(e.source)
    }

    return m
  }, [graph.edges, graph.nodes])

  useEffect(() => {
    const el = wrapRef.current

    if (!el) {
      return
    }

    const sync = () => setSize({ h: el.clientHeight, w: el.clientWidth })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()

    return () => ro.disconnect()
  }, [])

  // Build the simulation: time → radius, oldest at the core.
  useEffect(() => {
    sizeRef.current = size

    if (size.w === 0 || size.h === 0) {
      return
    }

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
      const tr = RING_INNER + rec * (RING_OUTER - RING_INNER)
      const seed = hash(n.id)
      const angle = ((seed % 3600) / 3600) * Math.PI * 2

      return { ...n, rec, tr, vx: 0, vy: 0, x: Math.cos(angle) * tr, y: Math.sin(angle) * tr }
    })

    const byId = new Map(nodes.map(n => [n.id, n]))

    const links: SimLink[] = graph.edges
      .filter(e => byId.has(e.source) && byId.has(e.target))
      .map(e => ({ source: e.source, target: e.target }))

    // Radial force dominates so a node's distance from the core faithfully
    // encodes its time (it sits on/near its date ring); charge + collide only
    // spread nodes around that ring, they don't drag them off it.
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
      .on('tick', invalidate)

    const rings: Array<{ label: null | string; r: number; ratio: number }> = []
    const steps = 4

    for (let i = 0; i <= steps; i += 1) {
      const ratio = i / steps
      const r = RING_INNER + ratio * (RING_OUTER - RING_INNER)

      const label =
        timed && minTs !== null && maxTs !== null ? formatDate(Math.round(minTs + (maxTs - minTs) * ratio)) : null

      rings.push({ label, r, ratio })
    }

    simRef.current = sim
    nodesRef.current = nodes
    linksRef.current = links
    byIdRef.current = byId
    ringsRef.current = rings
    fadeRef.current.labels.clear()
    fadeRef.current.links.clear()
    fadeRef.current.nodes.clear()
    fadeRef.current.rings.clear()
    viewportRef.current = fitViewport(size.w, size.h)
    invalidate()

    if (selectedIdRef.current && !byId.has(selectedIdRef.current)) {
      selectedIdRef.current = null
      setSelectedId(null)
    }

    return () => {
      sim.stop()

      if (simRef.current === sim) {
        simRef.current = null
      }
    }
  }, [graph.edges, graph.nodes, invalidate, size])

  useEffect(() => {
    const count = clamp(Math.round((size.w * size.h) / 8000), 50, 200)
    starsRef.current = Array.from({ length: count }, (_, i) => {
      const s = hash(`star-${i}-${size.w}x${size.h}`)

      return {
        a: 0.1 + ((s >>> 18) % 55) / 100,
        r: 0.4 + ((s >>> 8) % 12) / 12,
        x: s % Math.max(1, size.w),
        y: (s >>> 12) % Math.max(1, size.h)
      }
    })
    invalidate()
  }, [invalidate, size])

  useEffect(() => {
    adjacencyRef.current = adjacency
    memByIdRef.current = memById
    invalidate()
  }, [adjacency, invalidate, memById])

  useEffect(() => {
    selectedIdRef.current = selectedId
    invalidate()
  }, [invalidate, selectedId])

  // Repaint + repalette when the theme/mode changes (class + inline vars on <html>).
  useEffect(() => {
    const mo = new MutationObserver(() => {
      themeDirtyRef.current = true
      invalidate()
    })

    mo.observe(document.documentElement, {
      attributeFilter: ['class', 'style', 'data-hermes-mode', 'data-hermes-theme'],
      attributes: true
    })

    return () => mo.disconnect()
  }, [invalidate])

  // Render loop.
  useEffect(() => {
    let raf = 0

    // Event-driven: no frames are scheduled while idle. Anything that changes
    // the view calls invalidate(); a draw that's still animating reschedules.
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(frame)
      }
    }

    const frame = () => {
      raf = 0

      if (!dirtyRef.current) {
        return
      }

      // A draw that's still animating (orbs, fades) keeps the loop alive
      // seamlessly; otherwise we settle to idle.
      dirtyRef.current = draw()

      if (dirtyRef.current) {
        schedule()
      }
    }

    invalidateRef.current = () => {
      dirtyRef.current = true
      schedule()
    }

    const draw = () => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')

      if (!canvas || !ctx) {
        return false
      }

      const { h, w } = sizeRef.current
      const dpr = dprRef.current
      const vp = viewportRef.current
      const nodes = nodesRef.current
      const byId = byIdRef.current
      const adj = adjacencyRef.current
      const fades = fadeRef.current
      let animating = false

      const fadeAlpha = (bucket: Map<string, number>, key: string, target: number, snapUp = false) => {
        const targetAlpha = clamp(target, 0, 1)
        const prev = bucket.get(key)

        if (prev == null || (snapUp && targetAlpha > prev)) {
          bucket.set(key, targetAlpha)

          return targetAlpha
        }

        const rate = targetAlpha > prev ? 0.22 : 0.32
        const next = prev + (targetAlpha - prev) * rate

        if (Math.abs(next - targetAlpha) < 0.01) {
          bucket.set(key, targetAlpha)

          return targetAlpha
        }

        animating = true
        bucket.set(key, next)

        return next
      }

      // Two independent layers that compose: a node highlight (selected node,
      // else hovered) painted in full ink, and a ring/date filter (selected
      // ring, else hovered) that only shifts alpha. A date can stay selected
      // while you focus nodes inside it.
      const focus = selectedIdRef.current ?? hoverRef.current
      // Rings respond to SELECTION only — hover does nothing (no neighbor bleed).
      const focusRing = selectedRingRef.current
      const focusSet = focus ? (adj.get(focus) ?? new Set<string>()) : null

      // Tilted projection: y is squashed for the "looking down at a disk" feel.
      const projX = (wx: number) => wx * vp.k + vp.x
      const projY = (wy: number) => wy * vp.k * TILT + vp.y

      // Theme palette is resolved only when the theme changes (the resolveRgb
      // probe is a getImageData readback), then reused every frame.
      if (themeDirtyRef.current || !paletteRef.current) {
        paletteRef.current = computePalette(canvas)
        themeDirtyRef.current = false
      }

      const { bandInk, base, bg, c, chipBg, darkTheme, inkInv, memoryInk, skillInk } = paletteRef.current
      const shade = (a: number) => `rgba(${base.r},${base.g},${base.b},${a})`

      const recencyInk = (rec: number) => {
        const reach = Math.max(0.01, AGE_GRADIENT.reach)
        const mid = clamp(AGE_GRADIENT.mid, 0.01, 0.99)
        const t = clamp(rec / reach, 0, 1)

        if (t <= mid) {
          const p = t / mid
          const eased = p * p * (3 - 2 * p)

          return AGE_GRADIENT.oldInk + (AGE_GRADIENT.midInk - AGE_GRADIENT.oldInk) * eased
        }

        const p = (t - mid) / (1 - mid)
        const eased = p * p * (3 - 2 * p)

        return AGE_GRADIENT.midInk + (AGE_GRADIENT.newInk - AGE_GRADIENT.midInk) * eased
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Starfield backdrop (screen space).
      ctx.fillStyle = shade(1)

      for (const s of starsRef.current) {
        ctx.globalAlpha = s.a * (darkTheme ? 0.32 : 0.5)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.globalAlpha = 1

      // Tilted world transform for the disk structure + jump routes.
      ctx.setTransform(vp.k * dpr, 0, 0, vp.k * TILT * dpr, vp.x * dpr, vp.y * dpr)

      const ringIdx = focusRing
      const ring = ringIdx != null ? (ringsRef.current[ringIdx] ?? null) : null
      // The "lit" date = hovered (preview) or selected (locked). Drives only the
      // band flatten; the ring outline never changes.
      const hoverRingIdx = hoveredRingRef.current
      const litRingIdx = hoverRingIdx ?? ringIdx
      const rings = ringsRef.current
      const { bandAlpha, lightSize, ringAlpha, sheen } = RING_PARAMS[darkTheme ? 'dark' : 'light']

      // Inter-ring bands: normally a theme-tinted wash sliver at the outer edge;
      // the lit date flattens the band just inside it to a constant light wash.
      if (bandAlpha > 0 || litRingIdx != null) {
        for (let i = 0; i < rings.length - 1; i += 1) {
          const lit = litRingIdx != null && i + 1 === litRingIdx

          if (!lit && bandAlpha <= 0) {
            continue
          }

          const inner = rings[i]?.r ?? 0
          const outer = rings[i + 1]?.r ?? 0

          if (lit) {
            // Lit date: flat, even wash across the whole band.
            ctx.fillStyle = rgba(bandInk, LIT_BAND_ALPHA)
          } else {
            const grad = ctx.createRadialGradient(0, 0, inner, 0, 0, outer)
            grad.addColorStop(0, rgba(bandInk, 0))
            grad.addColorStop(clamp(1 - lightSize, 0.01, 0.99), rgba(bandInk, 0))
            grad.addColorStop(1, rgba(bandInk, bandAlpha))
            ctx.fillStyle = grad
          }

          ctx.beginPath()
          ctx.arc(0, 0, outer, 0, Math.PI * 2)
          ctx.arc(0, 0, inner, 0, Math.PI * 2, true)
          ctx.fill()
        }
      }

      // Ring outline: brightens only on FOCUS (selected date) — the selected
      // ring plus its inner neighbor (the two bounding the lit band). No hover.
      ctx.lineWidth = c.ringWidth / vp.k
      ctx.setLineDash(c.ringDashed ? [c.ringDash / vp.k, c.ringDash / vp.k] : [])
      ringsRef.current.forEach((rg, i) => {
        const emphasized = ringIdx != null && (i === ringIdx || i === ringIdx - 1)
        const targetAlpha = emphasized ? clamp(LIT_BAND_ALPHA * 2, 0, 1) : ringAlpha
        ctx.strokeStyle = shade(fadeAlpha(fades.rings, String(i), targetAlpha, emphasized))
        ctx.beginPath()
        ctx.arc(0, 0, rg.r, 0, Math.PI * 2)
        ctx.stroke()
      })
      ctx.setLineDash([])
      // Switch to screen space for jump routes + glyphs (crisp, easy to trim).
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Jump routes. A focused node's links stop at its selection ring, not its
      // glyph, so the ring reads cleanly.
      const focusNode = focus ? (byId.get(focus) ?? null) : null
      const focusRingR = focusNode ? (nodeRadius(focusNode) + focusNode.rec) * vp.k + 4 : 0

      for (const link of linksRef.current) {
        const s = typeof link.source === 'object' ? link.source : byId.get(String(link.source))
        const t = typeof link.target === 'object' ? link.target : byId.get(String(link.target))

        if (!s || !t) {
          continue
        }

        const lit =
          !!focus && (s.id === focus || t.id === focus || (!!focusSet && focusSet.has(s.id) && focusSet.has(t.id)))

        let x1 = projX(s.x)
        let y1 = projY(s.y)
        let x2 = projX(t.x)
        let y2 = projY(t.y)

        if (s.id === focus) {
          const d = Math.hypot(x2 - x1, y2 - y1) || 1
          x1 += ((x2 - x1) / d) * focusRingR
          y1 += ((y2 - y1) / d) * focusRingR
        }

        if (t.id === focus) {
          const d = Math.hypot(x1 - x2, y1 - y2) || 1
          x2 += ((x1 - x2) / d) * focusRingR
          y2 += ((y1 - y2) / d) * focusRingR
        }

        // Ambient links follow the recency slope; a focused/hovered node's
        // connectors go solid, 1.5px, fully opaque so the constellation pops.
        const ageInk = recencyInk((s.rec + t.rec) / 2)
        const targetAlpha = lit ? 1 : focus || ring ? 0.025 : ageInk * c.lineAlpha
        const linkAlpha = fadeAlpha(fades.links, `${s.id}->${t.id}`, targetAlpha, lit)
        ctx.strokeStyle = shade(linkAlpha)
        ctx.setLineDash(lit || !c.lineDashed ? [] : [c.lineDash, c.lineDash])
        ctx.lineWidth = lit ? 1.5 : c.lineWidth
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      ctx.setLineDash([])

      // Systems (nodes). The node layer paints pure ink (focused node + its
      // neighbors); the ring/date layer is alpha-only — selected-date nodes keep
      // their tint and just brighten, so the two states compose cleanly.
      for (const n of nodes) {
        const isFocus = n.id === focus
        const isNeighbor = !!focusSet && focusSet.has(n.id)
        const inRing = !!ring && Math.abs(n.rec - ring.ratio) <= 0.13
        const nodeHigh = isFocus || isNeighbor
        const ageInk = recencyInk(n.rec)
        const ageScale = nodeHigh || inRing ? 1 : 0.34 + Math.min(1, n.rec / 0.4) * 0.66
        const r = nodeRadius(n) * vp.k * ageScale
        const sx = projX(n.x)
        const sy = projY(n.y)

        // Alpha: node highlight wins; otherwise the date filter (in-ring bright,
        // off-ring dim, and a mid level for in-ring while a node is focused).
        const targetAlpha = nodeHigh ? 1 : ring ? (inRing ? (focus ? 0.55 : 1) : 0.16) : focus ? 0.16 : ageInk
        ctx.globalAlpha = fadeAlpha(fades.nodes, n.id, targetAlpha, nodeHigh || inRing)
        // Pure ink only for the node layer; the date filter never recolors.
        const nodeInk = nodeHigh ? base : n.kind === 'memory' ? memoryInk : skillInk
        const shape = NODE_SHAPE[n.kind]
        shapePath(ctx, shape, sx, sy, r)

        if (shape === 'circle') {
          // Active/hover (highlighted) orbs pop full bright; others darken so the
          // sheen reads against a brighter primary.
          sphereFill(ctx, sx, sy, r, nodeInk, sheen, nodeHigh ? 0 : ORB_DARKEN)
        } else {
          ctx.fillStyle = rgba(nodeInk, 1)
          ctx.fill()
        }

        if (isFocus) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = rgba(nodeInk, 1)
          ctx.lineWidth = 1.4
          shapePath(ctx, shape, sx, sy, r + 4)
          ctx.stroke()
        }
      }

      ctx.globalAlpha = 1

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Ring date labels (top of each ellipse) — hoverable to focus the ring.
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ringLabelRectsRef.current = []
      ringsRef.current.forEach((rg, i) => {
        if (!rg.label) {
          return
        }

        const sx = projX(0)
        const sy = projY(-rg.r)

        if (sy < 8 || sy > h - 8) {
          return
        }

        const tw = ctx.measureText(rg.label).width
        const boxW = tw + 6
        // The selected OR hovered date is "this"; any focus fades the rest.
        const isThis = ringIdx === i || hoverRingIdx === i
        const faded = (focus != null || ringIdx != null) && !isThis
        // EVE-style: labels float in space (no chip). A solid backdrop in the
        // overlay's own background color masks the ring line behind the text so
        // it stays legible — a real backdrop, not a stark black/white halo.
        ctx.globalAlpha = fadeAlpha(fades.labels, String(i), faded ? 0.33 : 1, isThis)
        ctx.fillStyle = rgba(bg, 1)
        ctx.fillRect(sx - boxW / 2, sy - 6, boxW, 13)
        ctx.fillStyle = shade(isThis ? 1 : 0.2)
        ctx.fillText(rg.label, sx, sy + 3)
        ctx.globalAlpha = 1
        ringLabelRectsRef.current.push({ h: 18, i, w: boxW + 6, x: sx - boxW / 2 - 3, y: sy - 10 })
      })

      // Tooltip on focus (hover OR selection) — drawn first so its rect joins
      // the avoidance set and neighbor labels route around it. The metabar and
      // the title each get their own background that fills to their own width.
      const tip = focus ? byId.get(focus) : null
      let tipRect: null | Rect = null

      if (tip) {
        const PADX = 6
        const PADY = 4
        const BADGE_H = 14
        const ROW_GAP = 3
        const LINE_H = 16
        const badgeFont = '9px ui-sans-serif, system-ui, sans-serif'
        const monoFont = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
        const titleFont = '600 11px ui-sans-serif, system-ui, sans-serif'
        // The date (index 0) stays sans; the rest of the tags are monospace.
        const badgeFontFor = (i: number) => (i === 0 ? badgeFont : monoFont)

        const badges = metaBadges(tip)
        const use = countLabel(tip)

        const titleText =
          tip.kind === 'memory' ? memByIdRef.current.get(tip.id)?.body.split('\n')[0]?.trim() || tip.label : tip.label

        // Metabar metrics — plain text: no background, no chips, no padding.
        const ITEM_GAP = 8

        const badgeW = badges.map((b, i) => {
          ctx.font = badgeFontFor(i)

          return ctx.measureText(b).width
        })

        const rowW = badgeW.reduce((a, b) => a + b, 0) + ITEM_GAP * Math.max(0, badges.length - 1)
        ctx.font = monoFont
        const useW = use ? ctx.measureText(use).width : 0
        const metaW = rowW + (use ? ITEM_GAP + useW : 0)

        // Title metrics (wrapped) — title keeps its own filled (inverted) bg.
        ctx.font = titleFont
        const maxTitleW = Math.min(380, w - 16) - PADX * 2
        const titleLines = wrapText(ctx, titleText, maxTitleW)
        const titleW = Math.max(0, ...titleLines.map(l => ctx.measureText(l).width))
        const titleBgW = titleW + PADX * 2
        const titleBgH = titleLines.length * LINE_H + PADY * 2

        // Footer primitive — reserved for future per-node detail; nothing now.
        const footerText = nodeFooter(tip)
        const FOOTER_H = 13
        const footerFont = '9px ui-sans-serif, system-ui, sans-serif'
        ctx.font = footerFont
        const footerW = footerText ? ctx.measureText(footerText).width : 0

        const contentW = Math.max(metaW, footerW)
        const totalW = Math.max(contentW, titleBgW)
        const totalH = BADGE_H + ROW_GAP + titleBgH + (footerText ? ROW_GAP + FOOTER_H : 0)
        const bx = clamp(projX(tip.x) - totalW / 2, 4, Math.max(4, w - totalW - 4))
        const by = clamp(projY(tip.y) - (nodeRadius(tip) * vp.k + 8) - totalH, 4, Math.max(4, h - totalH - 4))
        tipRect = { h: totalH, w: totalW, x: bx, y: by }

        const textX = bx + PADX

        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'

        const badgeMidY = by + BADGE_H / 2

        // Metadata sits flush at the left edge (no padding).
        ctx.fillStyle = shade(0.7)
        let cx = bx
        badges.forEach((label, i) => {
          ctx.font = badgeFontFor(i)
          ctx.fillText(label, cx, badgeMidY)
          cx += badgeW[i] + ITEM_GAP
        })

        if (use) {
          ctx.font = monoFont
          ctx.fillStyle = shade(0.5)
          ctx.fillText(use, cx, badgeMidY)
        }

        // Title: inverted (fg/bg flipped) so the focused tooltip pops.
        const ty = by + BADGE_H + ROW_GAP
        ctx.fillStyle = shade(1)
        ctx.fillRect(bx, ty, titleBgW, titleBgH)
        ctx.font = titleFont
        ctx.fillStyle = inkInv
        titleLines.forEach((line, i) => {
          ctx.fillText(line, textX, ty + PADY + LINE_H * i + LINE_H / 2)
        })

        // Footer primitive (renders only when nodeFooter() returns content).
        if (footerText) {
          ctx.font = footerFont
          ctx.fillStyle = shade(0.45)
          ctx.fillText(footerText, bx, ty + titleBgH + ROW_GAP + FOOTER_H / 2)
        }

        ctx.textBaseline = 'alphabetic'
      }

      // Constellation labels for the focus's neighbors — greedy placement that
      // clamps to the overlay and dodges already-placed labels (date labels and
      // the tooltip included) so they don't overlap or clip at the edges.
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      const LBL_M = 6
      const LBL_H = 15
      const placed = ringLabelRectsRef.current.map(r => ({ h: r.h, w: r.w, x: r.x, y: r.y }))
      const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

      if (tipRect) {
        placed.push(tipRect)
      }

      for (const id of focusSet ?? []) {
        if (id === hoverRef.current) {
          continue
        }

        const n = byId.get(id)

        if (!n) {
          continue
        }

        const label = ellipsize(ctx, n.label, Math.min(180, w * 0.32))
        const bw = ctx.measureText(label).width + 8
        const x = clamp(projX(n.x) - bw / 2, LBL_M, Math.max(LBL_M, w - bw - LBL_M))
        const top = projY(n.y) - (nodeRadius(n) * vp.k + 7) - LBL_H + 4
        const clampY = (v: number) => clamp(v, LBL_M, Math.max(LBL_M, h - LBL_H - LBL_M))
        // Prefer above the node, then fan outward; skip if nothing stays clear
        // (a label on the tooltip reads worse than no label).
        const step = LBL_H + 3
        let y: null | number = null

        for (let k = 0; k <= 7 && y == null; k += 1) {
          for (const dy of k === 0 ? [0] : [-k * step, k * step]) {
            const cand = { h: LBL_H, w: bw, x, y: clampY(top + dy) }

            if (!placed.some(p => hits(cand, p))) {
              y = cand.y

              break
            }
          }
        }

        if (y == null) {
          continue
        }

        placed.push({ h: LBL_H, w: bw, x, y })
        ctx.fillStyle = chipBg
        ctx.fillRect(x, y, bw, LBL_H)
        ctx.fillStyle = shade(0.85)
        ctx.fillText(label, x + bw / 2, y + 11)
      }

      return animating
    }

    schedule()

    return () => {
      cancelAnimationFrame(raf)

      invalidateRef.current = () => {}
    }
  }, [])

  // Size the backing canvas (DPR-aware).
  useEffect(() => {
    sizeRef.current = size
    dprRef.current = Math.min(2, window.devicePixelRatio || 1)
    const canvas = canvasRef.current

    if (canvas && size.w > 0 && size.h > 0) {
      canvas.width = Math.round(size.w * dprRef.current)
      canvas.height = Math.round(size.h * dprRef.current)
      canvas.style.width = `${size.w}px`
      canvas.style.height = `${size.h}px`
    }

    invalidate()
  }, [invalidate, size])

  // ── Interactions (invert the tilted projection for hit-testing) ───────────
  const pickNode = (cssX: number, cssY: number): null | SimNode => {
    const vp = viewportRef.current
    const wx = (cssX - vp.x) / vp.k
    const wy = (cssY - vp.y) / (vp.k * TILT)
    let best: null | SimNode = null
    let bestD = Infinity

    for (const n of nodesRef.current) {
      const r = nodeRadius(n) + 6
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2

      if (d < r * r && d < bestD) {
        bestD = d
        best = n
      }
    }

    return best
  }

  const pickRingLabel = (cssX: number, cssY: number): null | number => {
    for (const r of ringLabelRectsRef.current) {
      if (cssX >= r.x && cssX <= r.x + r.w && cssY >= r.y && cssY <= r.y + r.h) {
        return r.i
      }
    }

    return null
  }

  const localXY = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect()

    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) {
      return
    }

    const { x, y } = localXY(e)
    const ringHit = pickRingLabel(x, y)
    hoveredRingRef.current = null
    // Nodes aren't draggable (static map) — remember which was pressed so a
    // click (press without movement) can select it; any drag just pans.
    const nodeId = ringHit == null ? (pickNode(x, y)?.id ?? null) : null
    dragRef.current = {
      id: nodeId,
      mode: 'pan',
      moved: false,
      ring: ringHit,
      sx: e.clientX,
      sy: e.clientY,
      vp: viewportRef.current
    }
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current

    if (drag.mode === 'none') {
      const { x, y } = localXY(e)
      const ringHit = pickRingLabel(x, y)
      const id = ringHit == null ? (pickNode(x, y)?.id ?? null) : null

      if (id !== hoverRef.current || ringHit !== hoveredRingRef.current) {
        hoverRef.current = id
        hoveredRingRef.current = ringHit
        invalidate()
      }

      const canvas = canvasRef.current

      if (canvas) {
        canvas.style.cursor = id || ringHit != null ? 'pointer' : 'crosshair'
      }

      return
    }

    const dx = e.clientX - drag.sx
    const dy = e.clientY - drag.sy

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true
    }

    if (drag.mode === 'pan') {
      viewportRef.current = { ...drag.vp, x: drag.vp.x + dx, y: drag.vp.y + dy }
      invalidate()
    }
  }

  const endDrag = () => {
    const drag = dragRef.current

    // A click (press without movement) selects a ring date, a node, or clears.
    if (drag.mode === 'pan' && !drag.moved) {
      // Double tap (trackpad tap-to-click may never emit a dblclick) resets view.
      if (doubleTapRef.current()) {
        resetView()

        dragRef.current = { id: null, mode: 'none', moved: false, ring: null, sx: 0, sy: 0, vp: viewportRef.current }

        return
      }

      // Independent toggles: a date and a node can both be selected. Clicking
      // empty space clears both.
      if (drag.ring != null) {
        selectedRingRef.current = selectedRingRef.current === drag.ring ? null : drag.ring
      } else if (drag.id) {
        setSelectedId(prev => (prev === drag.id ? null : drag.id))
      } else {
        selectedRingRef.current = null
        setSelectedId(null)
      }

      invalidate()
    }

    dragRef.current = { id: null, mode: 'none', moved: false, ring: null, sx: 0, sy: 0, vp: viewportRef.current }
  }

  const onMouseLeave = () => {
    hoverRef.current = null
    hoveredRingRef.current = null
    invalidate()
    endDrag()
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect()

    if (!rect) {
      return
    }

    // macOS "smart zoom" (two-finger double-tap) reaches us as a ctrl-wheel with
    // zero deltas (see lib/trackpad-gestures). Use it to reset the view.
    if (isSmartZoomWheel(e)) {
      resetView()

      return
    }

    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const vp = viewportRef.current
    const k = clamp(vp.k * (e.deltaY > 0 ? 0.9 : 1.1), ZOOM_MIN, ZOOM_MAX)
    viewportRef.current = { k, x: px - ((px - vp.x) / vp.k) * k, y: py - ((py - vp.y) / vp.k) * k }
    invalidate()
  }

  const resetView = () => {
    viewportRef.current = fitViewport(sizeRef.current.w, sizeRef.current.h)
    selectedRingRef.current = null
    invalidate()
    setSelectedId(null)
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" ref={wrapRef}>
      <canvas
        className="block cursor-crosshair touch-none select-none text-foreground"
        onDoubleClick={resetView}
        onMouseDown={onMouseDown}
        onMouseLeave={onMouseLeave}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onWheel={onWheel}
        ref={canvasRef}
      />

      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1 bg-background/40 px-2 py-1.5 text-[0.62rem] text-muted-foreground backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-full bg-[var(--theme-primary)]/80" /> skill
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rotate-45 bg-[var(--theme-secondary)]/80" /> memory
          </span>
        </div>
        <div className="text-[0.58rem] text-muted-foreground/65">core = oldest · outer rings = newer</div>
      </div>

      <div className="absolute right-3 top-2 flex items-center gap-3 text-[0.65rem]">
        <button className="text-muted-foreground hover:text-foreground" onClick={resetView} type="button">
          Reset view
        </button>
        <button
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          disabled={loading}
          onClick={() => void loadLearningGraph(true)}
          type="button"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

    </div>
  )
}

export function LearningView({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const graph = useStore($learningGraph)
  const loading = useStore($learningLoading)
  const error = useStore($learningError)

  useEffect(() => {
    void loadLearningGraph()
  }, [])

  const skillCount = graph ? graph.nodes.filter(n => n.kind === 'skill').length : 0
  const memoryCount = graph ? graph.nodes.filter(n => n.kind === 'memory').length : 0
  const subtitle = graph ? `${skillCount} learned skills · ${memoryCount} memories, over time` : undefined

  return (
    <Panel closeLabel={t.learning.close} onClose={onClose}>
      <PanelHeader subtitle={subtitle} title={t.learning.title} />

      {error ? (
        <PanelEmpty description={error} icon="warning" title={t.learning.loadFailed} />
      ) : !graph && loading ? (
        <div aria-label={t.learning.loading} className="grid flex-1 place-items-center" role="status">
          <Loader className="size-12 text-muted-foreground" strokeScale={0.72} type="spiral-search" />
        </div>
      ) : graph && graph.nodes.length === 0 ? (
        <PanelEmpty description={t.learning.emptyDesc} icon="lightbulb" title={t.learning.emptyTitle} />
      ) : graph ? (
        <StarMap graph={graph} />
      ) : null}
    </Panel>
  )
}

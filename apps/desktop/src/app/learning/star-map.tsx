import { useStore } from '@nanostores/react'
import { type Simulation } from 'd3-force'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createDoubleTapDetector, isSmartZoomWheel } from '@/lib/trackpad-gestures'
import { $learningLoading, loadLearningGraph } from '@/store/learning'
import type { LearningGraph } from '@/types/hermes'

import { computePalette } from './color'
import { TILT, ZOOM_MAX, ZOOM_MIN } from './constants'
import { clamp, distToSegmentSq, fitViewport, hash, nodeRadius } from './geometry'
import { drawScene } from './render'
import { buildSimulation } from './simulation'
import type { FadeBuckets, MemoryCard, Palette, Ring, RingLabelRect, SimLink, SimNode, Star, Viewport } from './types'

// A tilted, top-down star map of what Hermes has learned. Time is RADIAL: oldest
// at the core, newest on the outer rings. This component owns the refs, effects
// and pointer wiring; layout lives in simulation.ts and painting in render.ts.
export function StarMap({ graph }: { graph: LearningGraph }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const simRef = useRef<null | Simulation<SimNode, SimLink>>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const byIdRef = useRef(new Map<string, SimNode>())
  const adjacencyRef = useRef(new Map<string, Set<string>>())
  const memByIdRef = useRef(new Map<string, MemoryCard>())
  const ringsRef = useRef<Ring[]>([])
  const ringLabelRectsRef = useRef<RingLabelRect[]>([])
  const starsRef = useRef<Star[]>([])

  const fadeRef = useRef<FadeBuckets>({
    labels: new Map(),
    links: new Map(),
    nodes: new Map(),
    rings: new Map()
  })

  const doubleTapRef = useRef(createDoubleTapDetector())
  const paletteRef = useRef<null | Palette>(null)
  const themeDirtyRef = useRef(true)
  const invalidateRef = useRef<() => void>(() => {})
  const viewportRef = useRef<Viewport>({ k: 1, x: 0, y: 0 })
  const hoverRef = useRef<null | string>(null)
  const hoveredLinkRef = useRef<null | string>(null)
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
    const m = new Map<string, MemoryCard>()
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

  // Track the wrapper size.
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

  // (Re)build the radial simulation whenever the graph or size changes.
  useEffect(() => {
    sizeRef.current = size

    if (size.w === 0 || size.h === 0) {
      return
    }

    const { byId, links, nodes, rings, sim } = buildSimulation(graph, invalidate)
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
  }, [graph, invalidate, size])

  // Seed the starfield from the size (stable per dimensions).
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

  // Event-driven render loop: no frames while idle. Anything that changes the
  // view calls invalidate(); a draw that's still animating reschedules itself.
  useEffect(() => {
    let raf = 0

    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(frame)
      }
    }

    const draw = (): boolean => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')

      if (!canvas || !ctx) {
        return false
      }

      if (themeDirtyRef.current || !paletteRef.current) {
        paletteRef.current = computePalette(canvas)
        themeDirtyRef.current = false
      }

      const { animating, ringLabelRects } = drawScene({
        adjacency: adjacencyRef.current,
        byId: byIdRef.current,
        ctx,
        dpr: dprRef.current,
        fades: fadeRef.current,
        focusId: selectedIdRef.current ?? hoverRef.current,
        hoverId: hoverRef.current,
        hoverLink: hoveredLinkRef.current,
        hoverRing: hoveredRingRef.current,
        links: linksRef.current,
        memById: memByIdRef.current,
        nodes: nodesRef.current,
        palette: paletteRef.current,
        rings: ringsRef.current,
        selectedRing: selectedRingRef.current,
        size: sizeRef.current,
        stars: starsRef.current,
        vp: viewportRef.current
      })

      ringLabelRectsRef.current = ringLabelRects

      return animating
    }

    const frame = () => {
      raf = 0

      if (!dirtyRef.current) {
        return
      }

      dirtyRef.current = draw()

      if (dirtyRef.current) {
        schedule()
      }
    }

    invalidateRef.current = () => {
      dirtyRef.current = true
      schedule()
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

  // ── Pointer interactions (invert the tilted projection for hit-testing) ─────
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

  // Nearest link within ~5px of the cursor (screen space), or null.
  const pickLink = (cssX: number, cssY: number): null | string => {
    const vp = viewportRef.current
    let best: null | string = null
    let bestD = 25

    for (const link of linksRef.current) {
      const s = typeof link.source === 'object' ? link.source : byIdRef.current.get(String(link.source))
      const t = typeof link.target === 'object' ? link.target : byIdRef.current.get(String(link.target))

      if (!s || !t) {
        continue
      }

      const d = distToSegmentSq(
        cssX,
        cssY,
        s.x * vp.k + vp.x,
        s.y * vp.k * TILT + vp.y,
        t.x * vp.k + vp.x,
        t.y * vp.k * TILT + vp.y
      )

      if (d < bestD) {
        bestD = d
        best = `${s.id}->${t.id}`
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

  const resetView = () => {
    viewportRef.current = fitViewport(sizeRef.current.w, sizeRef.current.h)
    selectedRingRef.current = null
    invalidate()
    setSelectedId(null)
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) {
      return
    }

    const { x, y } = localXY(e)
    const ringHit = pickRingLabel(x, y)
    hoveredRingRef.current = null
    // Nodes aren't draggable (static map) — remember which was pressed so a click
    // (press without movement) can select it; any drag just pans.
    const nodeId = ringHit == null ? (pickNode(x, y)?.id ?? null) : null
    dragRef.current = { id: nodeId, mode: 'pan', moved: false, ring: ringHit, sx: e.clientX, sy: e.clientY, vp: viewportRef.current }
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current

    if (drag.mode === 'none') {
      const { x, y } = localXY(e)
      const ringHit = pickRingLabel(x, y)
      const id = ringHit == null ? (pickNode(x, y)?.id ?? null) : null
      // Links are the last fallback (only when not over a node/date).
      const linkKey = ringHit == null && id == null ? pickLink(x, y) : null

      if (id !== hoverRef.current || ringHit !== hoveredRingRef.current || linkKey !== hoveredLinkRef.current) {
        hoverRef.current = id
        hoveredRingRef.current = ringHit
        hoveredLinkRef.current = linkKey
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

    // A click (press without movement) toggles a ring date, a node, or clears.
    if (drag.mode === 'pan' && !drag.moved) {
      // Double tap (trackpad tap-to-click may never emit a dblclick) resets view.
      if (doubleTapRef.current()) {
        resetView()
        dragRef.current = { id: null, mode: 'none', moved: false, ring: null, sx: 0, sy: 0, vp: viewportRef.current }

        return
      }

      // Independent toggles: a date and a node can both be selected.
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
    hoveredLinkRef.current = null
    invalidate()
    endDrag()
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect()

    if (!rect) {
      return
    }

    // macOS smart zoom (two-finger double-tap) → reset (see lib/trackpad-gestures).
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

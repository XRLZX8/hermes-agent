import { darken, luminance, mixRgb, rgba } from './color'
import { LIT_BAND_ALPHA, NODE_SHAPE, ORB_DARKEN, RING_PARAMS, TILT, WHITE, WHITEISH_SHEEN } from './constants'
import { clamp, nodeRadius, recencyInk, shapePath } from './geometry'
import { countLabel, ellipsize, metaBadges, nodeFooter, wrapText } from './text'
import type { FadeBuckets, MemoryCard, Palette, Rect, Rgb, Ring, RingLabelRect, SimLink, SimNode, Star, Viewport } from './types'

export interface Scene {
  adjacency: Map<string, Set<string>>
  byId: Map<string, SimNode>
  ctx: CanvasRenderingContext2D
  dpr: number
  fades: FadeBuckets
  focusId: null | string
  hoverId: null | string
  hoverLink: null | string
  hoverRing: null | number
  links: SimLink[]
  memById: Map<string, MemoryCard>
  nodes: SimNode[]
  palette: Palette
  rings: Ring[]
  selectedRing: null | number
  size: { h: number; w: number }
  stars: Star[]
  vp: Viewport
}

export interface DrawResult {
  animating: boolean
  ringLabelRects: RingLabelRect[]
}

// Fill the current path as a lit sphere: an offset radial gradient from a hot
// core → darkened body → translucent rim, so a flat circle reads with volume.
// `strength` is how white the core is; `bodyDarken` darkens the body (0 for
// active/hover nodes so they pop full bright). Near-white inks skip the darken
// and force a near-full sheen so the white core still reads.
function sphereFill(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ink: Rgb, strength: number, bodyDarken: number): void {
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

const rectsOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

// Paint a full frame of the star map. Pure given its inputs (draws to the
// canvas + advances the fade buckets); returns whether it's still animating and
// the ring-label hit rects for pointer picking.
export function drawScene(scene: Scene): DrawResult {
  const { adjacency, byId, ctx, dpr, fades, focusId, hoverId, hoverLink, hoverRing, links, memById, nodes, palette, rings, selectedRing, size, stars, vp } = scene
  const { h, w } = size
  const { bandInk, base, bg, c, chipBg, darkTheme, inkInv, memoryInk, skillInk } = palette
  const { bandAlpha, lightSize, ringAlpha, sheen } = RING_PARAMS[darkTheme ? 'dark' : 'light']

  let animating = false
  const ringLabelRects: RingLabelRect[] = []

  // Eased opacity per element: snaps up when newly highlighted, eases otherwise.
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

  const shade = (a: number) => `rgba(${base.r},${base.g},${base.b},${a})`
  const projX = (wx: number) => wx * vp.k + vp.x
  const projY = (wy: number) => wy * vp.k * TILT + vp.y

  // Two composable layers: node highlight (selected ?? hovered) in full ink, and
  // a selection-only ring/date filter that only shifts alpha.
  const focusSet = focusId ? (adjacency.get(focusId) ?? new Set<string>()) : null
  const ringIdx = selectedRing
  const ring = ringIdx != null ? (rings[ringIdx] ?? null) : null

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // Starfield backdrop (screen space).
  ctx.fillStyle = shade(1)

  for (const s of stars) {
    ctx.globalAlpha = s.a * (darkTheme ? 0.32 : 0.5)
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.globalAlpha = 1

  // Tilted world transform for the disk structure.
  ctx.setTransform(vp.k * dpr, 0, 0, vp.k * TILT * dpr, vp.x * dpr, vp.y * dpr)

  // The "lit" date = hovered (preview) or selected (locked) — drives the band
  // flatten only; the ring outline reacts to selection.
  const litRingIdx = hoverRing ?? ringIdx

  // Inter-ring bands: a theme-tinted wash sliver at the outer edge; the lit
  // date's band flattens to an even wash.
  if (bandAlpha > 0 || litRingIdx != null) {
    for (let i = 0; i < rings.length - 1; i += 1) {
      const lit = litRingIdx != null && i + 1 === litRingIdx

      if (!lit && bandAlpha <= 0) {
        continue
      }

      const inner = rings[i]?.r ?? 0
      const outer = rings[i + 1]?.r ?? 0

      if (lit) {
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

  // Ring outline: brightens only on selection — the selected ring + its inner
  // neighbor (the two bounding the lit band).
  ctx.lineWidth = c.ringWidth / vp.k
  ctx.setLineDash(c.ringDashed ? [c.ringDash / vp.k, c.ringDash / vp.k] : [])
  rings.forEach((rg, i) => {
    const emphasized = ringIdx != null && (i === ringIdx || i === ringIdx - 1)
    const targetAlpha = emphasized ? clamp(LIT_BAND_ALPHA * 2, 0, 1) : ringAlpha
    ctx.strokeStyle = shade(fadeAlpha(fades.rings, String(i), targetAlpha, emphasized))
    ctx.beginPath()
    ctx.arc(0, 0, rg.r, 0, Math.PI * 2)
    ctx.stroke()
  })
  ctx.setLineDash([])

  // Screen space for jump routes + glyphs (crisp, easy to trim).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // Jump routes — a focused node's links stop at its selection ring.
  const focusNode = focusId ? (byId.get(focusId) ?? null) : null
  const focusRingR = focusNode ? (nodeRadius(focusNode) + focusNode.rec) * vp.k + 4 : 0

  for (const link of links) {
    const s = typeof link.source === 'object' ? link.source : byId.get(String(link.source))
    const t = typeof link.target === 'object' ? link.target : byId.get(String(link.target))

    if (!s || !t) {
      continue
    }

    const lit = !!focusId && (s.id === focusId || t.id === focusId || (!!focusSet && focusSet.has(s.id) && focusSet.has(t.id)))

    let x1 = projX(s.x)
    let y1 = projY(s.y)
    let x2 = projX(t.x)
    let y2 = projY(t.y)

    if (s.id === focusId) {
      const d = Math.hypot(x2 - x1, y2 - y1) || 1
      x1 += ((x2 - x1) / d) * focusRingR
      y1 += ((y2 - y1) / d) * focusRingR
    }

    if (t.id === focusId) {
      const d = Math.hypot(x1 - x2, y1 - y2) || 1
      x2 += ((x1 - x2) / d) * focusRingR
      y2 += ((y1 - y2) / d) * focusRingR
    }

    const key = `${s.id}->${t.id}`
    const ambient = recencyInk((s.rec + t.rec) / 2) * c.lineAlpha
    // Hovering a line fades it in a bit (×2, capped — never full white).
    const targetAlpha = lit ? 1 : key === hoverLink ? clamp(ambient * 2, 0, 0.7) : focusId || ring ? 0.025 : ambient
    const linkAlpha = fadeAlpha(fades.links, key, targetAlpha, lit)
    ctx.strokeStyle = shade(linkAlpha)
    ctx.setLineDash(lit || !c.lineDashed ? [] : [c.lineDash, c.lineDash])
    ctx.lineWidth = lit ? 1.5 : c.lineWidth
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  ctx.setLineDash([])

  // Nodes: the node layer paints pure ink (focused node + neighbors); the date
  // filter is alpha-only, so the two states compose.
  for (const n of nodes) {
    const isFocus = n.id === focusId
    const isNeighbor = !!focusSet && focusSet.has(n.id)
    const inRing = !!ring && Math.abs(n.rec - ring.ratio) <= 0.13
    const nodeHigh = isFocus || isNeighbor
    const ageScale = nodeHigh || inRing ? 1 : 0.34 + Math.min(1, n.rec / 0.4) * 0.66
    const r = nodeRadius(n) * vp.k * ageScale
    const sx = projX(n.x)
    const sy = projY(n.y)

    const targetAlpha = nodeHigh ? 1 : ring ? (inRing ? (focusId ? 0.55 : 1) : 0.16) : focusId ? 0.16 : recencyInk(n.rec)
    ctx.globalAlpha = fadeAlpha(fades.nodes, n.id, targetAlpha, nodeHigh || inRing)
    const nodeInk = nodeHigh ? base : n.kind === 'memory' ? memoryInk : skillInk
    const shape = NODE_SHAPE[n.kind]
    shapePath(ctx, shape, sx, sy, r)

    if (shape === 'circle') {
      // Highlighted orbs pop full bright; others darken so the sheen reads.
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
  rings.forEach((rg, i) => {
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
    const isThis = ringIdx === i || hoverRing === i
    const faded = (focusId != null || ringIdx != null) && !isThis
    ctx.globalAlpha = fadeAlpha(fades.labels, String(i), faded ? 0.33 : 1, isThis)
    ctx.fillStyle = rgba(bg, 1)
    ctx.fillRect(sx - boxW / 2, sy - 6, boxW, 13)
    ctx.fillStyle = shade(isThis ? 1 : 0.2)
    ctx.fillText(rg.label, sx, sy + 3)
    ctx.globalAlpha = 1
    ringLabelRects.push({ h: 18, i, w: boxW + 6, x: sx - boxW / 2 - 3, y: sy - 10 })
  })

  // Tooltip on focus — measured first so its rect joins the avoidance set and
  // neighbor labels route around it.
  const tip = focusId ? byId.get(focusId) : null
  let tipRect: null | Rect = null

  if (tip) {
    const PADX = 6
    const PADY = 4
    const BADGE_H = 14
    const ROW_GAP = 3
    const LINE_H = 16
    const ITEM_GAP = 8
    const badgeFont = '9px ui-sans-serif, system-ui, sans-serif'
    const monoFont = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    const titleFont = '600 11px ui-sans-serif, system-ui, sans-serif'
    const footerFont = '9px ui-sans-serif, system-ui, sans-serif'
    const FOOTER_H = 13
    // The date (index 0) stays sans; the rest of the tags are monospace.
    const badgeFontFor = (i: number) => (i === 0 ? badgeFont : monoFont)

    const badges = metaBadges(tip)
    const use = countLabel(tip)
    const titleText = tip.kind === 'memory' ? memById.get(tip.id)?.body.split('\n')[0]?.trim() || tip.label : tip.label

    const badgeW = badges.map((b, i) => {
      ctx.font = badgeFontFor(i)

      return ctx.measureText(b).width
    })

    const rowW = badgeW.reduce((a, b) => a + b, 0) + ITEM_GAP * Math.max(0, badges.length - 1)
    ctx.font = monoFont
    const useW = use ? ctx.measureText(use).width : 0
    const metaW = rowW + (use ? ITEM_GAP + useW : 0)

    ctx.font = titleFont
    const maxTitleW = Math.min(380, w - 16) - PADX * 2
    const titleLines = wrapText(ctx, titleText, maxTitleW)
    const titleW = Math.max(0, ...titleLines.map(l => ctx.measureText(l).width))
    const titleBgW = titleW + PADX * 2
    const titleBgH = titleLines.length * LINE_H + PADY * 2

    const footerText = nodeFooter(tip)
    ctx.font = footerFont
    const footerW = footerText ? ctx.measureText(footerText).width : 0

    const totalW = Math.max(metaW, footerW, titleBgW)
    const totalH = BADGE_H + ROW_GAP + titleBgH + (footerText ? ROW_GAP + FOOTER_H : 0)
    const bx = clamp(projX(tip.x) - totalW / 2, 4, Math.max(4, w - totalW - 4))
    const by = clamp(projY(tip.y) - (nodeRadius(tip) * vp.k + 8) - totalH, 4, Math.max(4, h - totalH - 4))
    tipRect = { h: totalH, w: totalW, x: bx, y: by }

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const badgeMidY = by + BADGE_H / 2

    // Metadata row, flush at the left edge.
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
      ctx.fillText(line, bx + PADX, ty + PADY + LINE_H * i + LINE_H / 2)
    })

    if (footerText) {
      ctx.font = footerFont
      ctx.fillStyle = shade(0.45)
      ctx.fillText(footerText, bx, ty + titleBgH + ROW_GAP + FOOTER_H / 2)
    }

    ctx.textBaseline = 'alphabetic'
  }

  // Neighbor constellation labels — greedy placement that clamps to the overlay
  // and dodges placed labels (date labels + tooltip) so nothing overlaps/clips.
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  const LBL_M = 6
  const LBL_H = 15
  const placed: Rect[] = ringLabelRects.map(r => ({ h: r.h, w: r.w, x: r.x, y: r.y }))

  if (tipRect) {
    placed.push(tipRect)
  }

  for (const id of focusSet ?? []) {
    if (id === hoverId) {
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
    const step = LBL_H + 3
    let y: null | number = null

    // Prefer above the node, then fan outward; skip if nothing stays clear (a
    // label on the tooltip reads worse than no label).
    for (let k = 0; k <= 7 && y == null; k += 1) {
      for (const dy of k === 0 ? [0] : [-k * step, k * step]) {
        const cand = { h: LBL_H, w: bw, x, y: clampY(top + dy) }

        if (!placed.some(p => rectsOverlap(cand, p))) {
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

  return { animating, ringLabelRects }
}

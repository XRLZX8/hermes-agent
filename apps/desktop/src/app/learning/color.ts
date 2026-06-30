import { BLACK, MODE_DEFAULTS } from './constants'
import { clamp } from './geometry'
import type { Palette, Rgb } from './types'

// Theme tokens come through `color-mix()`/oklch, so getComputedStyle returns a
// non-rgb() string. Rasterize through a 1x1 canvas to get real sRGB bytes —
// naive string parsing of oklab()/color(srgb …) silently yields black.
let _probe: CanvasRenderingContext2D | null = null

export function resolveRgb(color: string): Rgb {
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

export function rgba(c: Rgb, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const p = clamp(t, 0, 1)

  return {
    b: Math.round(a.b + (b.b - a.b) * p),
    g: Math.round(a.g + (b.g - a.g) * p),
    r: Math.round(a.r + (b.r - a.r) * p)
  }
}

export function darken(c: Rgb, amount: number): Rgb {
  return mixRgb(c, BLACK, amount)
}

export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.114 * b) / 255
}

// Resolve the theme-derived palette once per theme change — the resolveRgb probe
// does a getImageData readback, so this stays out of the per-frame path. Node
// groups borrow restrained tint from the theme; structure stays foreground ink.
export function computePalette(canvas: HTMLCanvasElement): Palette {
  const style = getComputedStyle(canvas)
  const fg = resolveRgb(style.color)
  const darkTheme = luminance(fg.r, fg.g, fg.b) > 0.55
  const base: Rgb = darkTheme ? { b: 255, g: 255, r: 255 } : { b: 0, g: 0, r: 0 }
  const primary = resolveRgb(style.getPropertyValue('--theme-primary').trim() || style.color)

  const secondary = resolveRgb(
    style.getPropertyValue('--theme-secondary').trim() || style.getPropertyValue('--theme-midground').trim() || style.color
  )

  const bg = resolveRgb(
    style.getPropertyValue('--background').trim() || style.getPropertyValue('--dt-background').trim() || (darkTheme ? '#000' : '#fff')
  )

  return {
    // Band tint derives from the theme primary so rings read consistently in
    // both modes (foreground ink would go white on dark / black on light).
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

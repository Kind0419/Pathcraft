/**
 * Two themes, one system.
 *
 * The light theme is the instrument panel the tool was designed as: warm paper,
 * ink green, hairline rules. The dark theme is the same system at night — not an
 * inversion, and not "the light one with the lights off". Paper becomes a dark
 * stage, ink becomes warm ivory, and the accent colours are lifted because a
 * saturated pine on near-black reads as mud.
 *
 * The UI reads CSS custom properties; the canvases cannot, so they read the
 * palettes below. Both are keyed on the same names so a colour can be changed in
 * one place and land in both.
 */

import { useSyncExternalStore } from 'react'

export type ThemeName = 'light' | 'dark'

const KEY = 'pathcraft.theme'

/* ------------------------------------------------------------------ canvas */
export interface CanvasPalette {
  /* 2D field */
  paperTop: string
  paperLow: string
  grid: string
  gridMajor: string
  wall: string
  wallEdge: string
  pathGlow: string
  trail: [number, number, number]
  path: string
  pathEdge: string
  markerStroke: string
  markerInk: string
  start: string
  goal: string
  ghost: string
  /* 3D stage */
  stageTop: string
  stageMid: string
  stageLow: string
  keyLight: string
  keyLightMid: string
  floor: string
  wallTop: string
  wallSideA: string
  wallSideB: string
  plate: string
  plateEdge: string
  route: string
  routeLow: string
  routeHigh: string
  routeHalo: string
  startGlow: string
  goalGlow: string
  shadow: string
  pool: string
  routeGlow: string
  /** the line of light where a wall's top edge turns over */
  wallRim: string
  /** dashed plumb line + landing square under a dragged 3D marker */
  guide: string
  /** a drop that has nowhere legal to land */
  warn: string
  /** the 2D board's outer rail: a filled margin and its inner edge */
  frameFill: string
  frameLine: string
}

export const CANVAS: Record<ThemeName, CanvasPalette> = {
  light: {
    paperTop: '#fbfaf6',
    paperLow: '#f0ede2',
    grid: 'rgba(64, 68, 58, 0.035)',
    gridMajor: 'rgba(64, 68, 58, 0.10)',
    wall: '#38403a',
    wallEdge: 'rgba(255, 255, 255, 0)',
    pathGlow: 'rgba(47, 93, 80, 0.22)',
    trail: [52, 78, 66],
    path: '#2f5d50',
    pathEdge: 'rgba(255, 255, 255, 0.86)',
    markerStroke: '#ffffff',
    markerInk: '#ffffff',
    start: '#2f5d50',
    goal: '#a45f43',
    ghost: 'rgba(110, 112, 102, 0.45)',
    stageTop: '#fcfbf6',
    stageMid: '#f5f2e8',
    stageLow: '#e9e5d8',
    keyLight: 'rgba(255, 250, 236, 0.66)',
    keyLightMid: 'rgba(255, 250, 236, 0.16)',
    floor: '#c9c6b3',
    wallTop: '#a9b0a6',
    wallSideA: '#6e776e',
    wallSideB: '#4d564d',
    plate: '#e0dccd',
    plateEdge: 'rgba(96, 104, 92, 0.16)',
    route: '#f8f2e2',
    routeLow: '#a8cdb4',
    routeHigh: '#dd9040',
    routeHalo: 'rgba(24, 33, 27, 0.72)',
    startGlow: 'rgba(47, 93, 80, 0.20)',
    goalGlow: 'rgba(164, 95, 67, 0.20)',
    shadow: 'rgba(40, 48, 41, 0.028)',
    pool: 'rgba(255, 247, 225, 0.34)',
    routeGlow: 'transparent',
    wallRim: 'rgba(255, 255, 250, 0.42)',
    guide: 'rgba(56, 64, 58, 0.30)',
    warn: '#b4573c',
    frameFill: 'rgba(56, 64, 58, 0.045)',
    frameLine: 'rgba(56, 64, 58, 0.18)',
  },
  dark: {
    /* A sheet of dark stone lit from the upper left -- but not black.
     *
     * The first pass sat at #141b18 over #0a0f0d and read as a hole: large
     * fields that dark make the eye chase detail that is not there, and every
     * accent on top of them turns into a lamp. The floor of this palette is
     * ~#161a17, which is dark enough to be "night" and high enough that walls,
     * grid and trail still separate without raising their contrast. */
    paperTop: '#1d1a13',
    paperLow: '#141209',
    grid: 'rgba(228, 218, 196, 0.045)',
    gridMajor: 'rgba(228, 218, 196, 0.10)',
    wall: '#4d564a',
    wallEdge: 'rgba(255, 246, 228, 0.12)',
    /* Accents are lifted and desaturated: #f0b478 on near-black is a 7:1 glare
     * at the exact place the eye is meant to rest. */
    pathGlow: 'rgba(238, 186, 130, 0.30)',
    trail: [132, 180, 158],
    path: '#eebd8c',
    pathEdge: 'rgba(20, 18, 12, 0.78)',
    markerStroke: '#141208',
    markerInk: '#141208',
    start: '#7cc3a6',
    goal: '#e3a077',
    ghost: 'rgba(158, 170, 156, 0.38)',
    /* The 3D stage: a room at night, one warm key, floor lifted off the page so
     * the volume sits on something instead of floating in the dark. */
    stageTop: '#181610',
    stageMid: '#141208',
    stageLow: '#0f0d07',
    keyLight: 'rgba(255, 214, 166, 0.10)',
    keyLightMid: 'rgba(255, 214, 166, 0.02)',
    floor: '#221f16',
    wallTop: '#525a4b',
    wallSideA: '#3f473d',
    wallSideB: '#2a302a',
    plate: '#1e1b13',
    plateEdge: 'rgba(228, 218, 196, 0.08)',
    route: '#ffd3a6',
    routeLow: '#9ed3b8',
    routeHigh: '#efae72',
    routeHalo: 'rgba(12, 10, 6, 0.84)',
    startGlow: 'rgba(124, 195, 166, 0.19)',
    goalGlow: 'rgba(227, 160, 119, 0.21)',
    shadow: 'rgba(0, 0, 0, 0.13)',
    pool: 'rgba(255, 214, 166, 0.085)',
    routeGlow: 'rgba(238, 186, 130, 0.12)',
    wallRim: 'rgba(255, 242, 218, 0.26)',
    guide: 'rgba(232, 222, 198, 0.30)',
    warn: '#e89372',
    frameFill: 'rgba(232, 222, 198, 0.032)',
    frameLine: 'rgba(232, 222, 198, 0.14)',
  },
}

/* ------------------------------------------------------------------ store */
const listeners = new Set<() => void>()
let current: ThemeName = 'light'

function read(): ThemeName | null {
  try {
    const v = window.localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* storage can throw when cookies are blocked; a theme is not worth failing over */
  }
  return null
}

export function currentTheme(): ThemeName {
  return current
}

export function setTheme(next: ThemeName): void {
  if (next === current && document.documentElement.dataset.theme === next) return
  current = next
  document.documentElement.dataset.theme = next
  try {
    window.localStorage.setItem(KEY, next)
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn())
}

export function initTheme(): void {
  // `?theme=dark` wins over storage: the capture scripts and design screenshots
  // need a deterministic frame, and a stale local preference would break them.
  const forced = new URLSearchParams(window.location.search).get('theme')
  if (forced === 'light' || forced === 'dark') {
    setTheme(forced)
    return
  }
  const saved = read()
  if (saved) {
    setTheme(saved)
    return
  }
  const prefers = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  setTheme(prefers ? 'dark' : 'light')
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribe, currentTheme, currentTheme)
}

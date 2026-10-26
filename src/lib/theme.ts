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
  },
  dark: {
    /* the field is a sheet of dark stone, lit from the upper left */
    paperTop: '#141b18',
    paperLow: '#0a0f0d',
    grid: 'rgba(196, 214, 200, 0.045)',
    gridMajor: 'rgba(196, 214, 200, 0.085)',
    wall: '#3d4a43',
    wallEdge: 'rgba(255, 246, 228, 0.10)',
    pathGlow: 'rgba(240, 164, 90, 0.42)',
    trail: [122, 178, 156],
    path: '#f0b478',
    pathEdge: 'rgba(12, 17, 15, 0.80)',
    markerStroke: '#0b100e',
    markerInk: '#0b100e',
    start: '#68bfa2',
    goal: '#e79a68',
    ghost: 'rgba(150, 168, 156, 0.42)',
    /* the 3D stage: a room at night, one warm key */
    stageTop: '#0d1210',
    stageMid: '#070b09',
    stageLow: '#030505',
    keyLight: 'rgba(255, 206, 150, 0.20)',
    keyLightMid: 'rgba(255, 206, 150, 0.035)',
    floor: '#18211d',
    wallTop: '#56645b',
    wallSideA: '#404d46',
    wallSideB: '#2a3530',
    plate: '#171e1b',
    plateEdge: 'rgba(200, 214, 200, 0.07)',
    route: '#ffcf95',
    routeLow: '#8fd0b2',
    routeHigh: '#f0a355',
    routeHalo: 'rgba(6, 10, 9, 0.86)',
    startGlow: 'rgba(104, 191, 162, 0.22)',
    goalGlow: 'rgba(231, 154, 104, 0.24)',
    shadow: 'rgba(0, 0, 0, 0.16)',
    pool: 'rgba(255, 206, 150, 0.10)',
    routeGlow: 'rgba(240, 164, 90, 0.16)',
    wallRim: 'rgba(255, 240, 212, 0.34)',
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

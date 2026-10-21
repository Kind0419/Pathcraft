import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { tr, useLang } from '../lib/i18n'
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../lib/types'

type EditMode = 'none' | 'start' | 'goal'

interface CanvasViewProps {
  map: GridMap
  cards: CardsState
  result: PlanResult
  playhead: number
  ghostPath: Point[]
  ghostContinuous: boolean
  hoverCard: CardId | null
  showExpanded: boolean
  showPath: boolean
  showGhost: boolean
  editMode: EditMode
  onStartChange: (point: Point) => void
  onGoalChange: (point: Point) => void
  onPlacePoint: () => void
  onInvalidPoint?: (message: string) => void
  mapEditMode: 'wall' | 'erase' | null
  brushSize: number
  onPaintCell: (x: number, y: number) => void
  zoom: number
  onZoom: (value: number) => void
}

interface Layout {
  cell: number
  ox: number
  oy: number
}

interface HoverCell {
  x: number
  y: number
  blocked: boolean
  clearance: number
}

function layoutFor(width: number, height: number, map: GridMap, zoom: number): Layout {
  const pad = 16
  const base = Math.min(
    Math.max(4, (width - pad * 2) / map.width),
    Math.max(4, (height - pad * 2) / map.height),
  )
  const cell = base * zoom
  return {
    cell,
    ox: (width - map.width * cell) / 2,
    oy: (height - map.height * cell) / 2,
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function pathsEqual(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i].x - b[i].x) > 1e-6 || Math.abs(a[i].y - b[i].y) > 1e-6) {
      return false
    }
  }
  return true
}

function resamplePath(points: Point[], count: number): Point[] {
  if (points.length === 0) return []
  if (count <= 1) return [{ ...points[0] }]
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    lengths.push(length)
    total += length
  }
  if (total < 1e-9) {
    return Array.from({ length: count }, () => ({ ...points[0] }))
  }
  const result: Point[] = []
  let segment = 0
  let traversed = 0
  for (let i = 0; i < count; i += 1) {
    const target = (total * i) / (count - 1)
    while (segment < lengths.length - 1 && traversed + lengths[segment] < target) {
      traversed += lengths[segment]
      segment += 1
    }
    const length = lengths[segment] || 1
    const t = Math.max(0, Math.min(1, (target - traversed) / length))
    const from = points[segment]
    const to = points[segment + 1] ?? from
    result.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    })
  }
  return result
}

export function CanvasView({
  map,
  cards,
  result,
  playhead,
  ghostPath,
  ghostContinuous,
  hoverCard,
  showExpanded,
  showPath,
  showGhost,
  editMode,
  onStartChange,
  onGoalChange,
  onPlacePoint,
  onInvalidPoint,
  mapEditMode,
  brushSize,
  onPaintCell,
  zoom,
  onZoom,
}: CanvasViewProps) {
  const lang = useLang()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragMarkerRef = useRef<'start' | 'goal' | null>(null)
  const paintingRef = useRef(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState<HoverCell | null>(null)
  const [displayPath, setDisplayPath] = useState<Point[]>(result.path)
  const displayPathRef = useRef<Point[]>(result.path)
  const morphFrameRef = useRef(0)
  const mapIdRef = useRef(map.id)
  const [markerView, setMarkerView] = useState({
    start: { x: map.start.x, y: map.start.y },
    goal: { x: map.goal.x, y: map.goal.y },
  })
  const markerViewRef = useRef(markerView)
  const markerFrameRef = useRef(0)

  useEffect(() => {
    const target = {
      start: { x: map.start.x, y: map.start.y },
      goal: { x: map.goal.x, y: map.goal.y },
    }
    const from = markerViewRef.current
    const distance = Math.max(
      Math.abs(target.start.x - from.start.x),
      Math.abs(target.start.y - from.start.y),
      Math.abs(target.goal.x - from.goal.x),
      Math.abs(target.goal.y - from.goal.y),
    )
    if (markerFrameRef.current) {
      cancelAnimationFrame(markerFrameRef.current)
      markerFrameRef.current = 0
    }
    if (
      distance > 5 ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      markerViewRef.current = target
      setMarkerView(target)
      return
    }
    if (distance < 1e-4) return
    const startedAt = performance.now()
    const duration = 95
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 2)
      const next = {
        start: {
          x: from.start.x + (target.start.x - from.start.x) * eased,
          y: from.start.y + (target.start.y - from.start.y) * eased,
        },
        goal: {
          x: from.goal.x + (target.goal.x - from.goal.x) * eased,
          y: from.goal.y + (target.goal.y - from.goal.y) * eased,
        },
      }
      markerViewRef.current = next
      setMarkerView(next)
      if (progress < 1) {
        markerFrameRef.current = requestAnimationFrame(tick)
      } else {
        markerFrameRef.current = 0
      }
    }
    markerFrameRef.current = requestAnimationFrame(tick)
    return () => {
      if (markerFrameRef.current) {
        cancelAnimationFrame(markerFrameRef.current)
        markerFrameRef.current = 0
      }
    }
  }, [map.start.x, map.start.y, map.goal.x, map.goal.y])

  const layout = useMemo(
    () => layoutFor(size.width, size.height, map, zoom),
    [size, map, zoom],
  )

  useEffect(() => {
    const next = result.path
    if (mapIdRef.current !== map.id) {
      mapIdRef.current = map.id
      displayPathRef.current = next
      setDisplayPath(next)
      return
    }
    const previous = displayPathRef.current
    if (pathsEqual(previous, next)) {
      displayPathRef.current = next
      setDisplayPath(next)
      return
    }
    if (morphFrameRef.current) {
      cancelAnimationFrame(morphFrameRef.current)
      morphFrameRef.current = 0
    }
    if (next.length === 0) {
      displayPathRef.current = []
      setDisplayPath([])
      return
    }
    if (previous.length === 0) {
      displayPathRef.current = next
      setDisplayPath(next)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      displayPathRef.current = next
      setDisplayPath(next)
      return
    }

    const count = Math.max(previous.length, next.length, 2)
    const from = resamplePath(previous, count)
    const to = resamplePath(next, count)
    const startedAt = performance.now()
    const duration = 360

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const frame = from.map((point, index) => ({
        x: point.x + (to[index].x - point.x) * eased,
        y: point.y + (to[index].y - point.y) * eased,
      }))
      displayPathRef.current = frame
      setDisplayPath(frame)
      if (progress < 1) {
        morphFrameRef.current = requestAnimationFrame(tick)
      } else {
        displayPathRef.current = next
        setDisplayPath(next)
        morphFrameRef.current = 0
      }
    }

    morphFrameRef.current = requestAnimationFrame(tick)
    return () => {
      if (morphFrameRef.current) {
        cancelAnimationFrame(morphFrameRef.current)
        morphFrameRef.current = 0
      }
    }
  }, [result.path, map.id])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(wrapper)
    const rect = wrapper.getBoundingClientRect()
    setSize({ width: rect.width, height: rect.height })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (
      Math.abs(rect.width - size.width) > 0.5 ||
      Math.abs(rect.height - size.height) > 0.5
    ) {
      setSize({ width: rect.width, height: rect.height })
      return
    }
    if (size.width === 0 || size.height === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(ctx, size.width, size.height)
  }, [size, map, cards, result, playhead, ghostPath, hover, hoverCard, showExpanded, showPath, showGhost, layout, displayPath, mapEditMode, brushSize, editMode, markerView])

  function draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const { cell, ox, oy } = layout
    const pathOffset = result.continuous ? 0 : 0.5
    const ghostOffset = ghostContinuous ? 0 : 0.5
    const eventCount = result.events.length
    const visibleEvents = Math.max(0, Math.min(playhead, eventCount))
    const pathVisible = result.status === 'success' && showPath && displayPath.length > 1

    ctx.clearRect(0, 0, width, height)
    const paper = ctx.createRadialGradient(
      width * 0.5,
      height * 0.32,
      0,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.72,
    )
    paper.addColorStop(0, '#fbfaf6')
    paper.addColorStop(1, '#f3f0e7')
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, width, height)

    // Paper grid.
    ctx.strokeStyle = 'rgba(64, 68, 58, 0.05)'
    ctx.lineWidth = 1
    for (let x = 0; x <= map.width; x += 1) {
      const px = Math.round(ox + x * cell) + 0.5
      ctx.beginPath()
      ctx.moveTo(px, oy)
      ctx.lineTo(px, oy + map.height * cell)
      ctx.stroke()
    }
    for (let y = 0; y <= map.height; y += 1) {
      const py = Math.round(oy + y * cell) + 0.5
      ctx.beginPath()
      ctx.moveTo(ox, py)
      ctx.lineTo(ox + map.width * cell, py)
      ctx.stroke()
    }

    ctx.strokeStyle = 'rgba(64, 68, 58, 0.10)'
    ctx.lineWidth = 1
    roundRect(
      ctx,
      ox - 1.5,
      oy - 1.5,
      map.width * cell + 3,
      map.height * cell + 3,
      7,
    )
    ctx.stroke()

    // Card-linked fields.
    if (hoverCard === 'clearance') {
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const index = y * map.width + x
          if (map.cells[index] === 1) continue
          const strength = Math.max(0, 1 - map.clearance[index] / 3.2)
          if (strength <= 0.01) continue
          ctx.fillStyle = `rgba(154, 118, 55, ${0.12 * strength})`
          ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell)
        }
      }
    } else if (hoverCard === 'heuristic') {
      let maxH = 1
      const values = new Float32Array(map.width * map.height)
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const index = y * map.width + x
          if (map.cells[index] === 1) continue
          const h =
            Math.max(map.goal.x - x, x - map.goal.x) +
            (Math.SQRT2 - 1) * Math.min(Math.abs(map.goal.x - x), Math.abs(map.goal.y - y))
          values[index] = h
          if (h > maxH) maxH = h
        }
      }
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const index = y * map.width + x
          if (map.cells[index] === 1) continue
          const strength = values[index] / maxH
          ctx.fillStyle = `rgba(65, 104, 119, ${0.13 * strength})`
          ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell)
        }
      }
    } else if (hoverCard === 'collision' && cards.collision.enabled) {
      const radius = cards.collision.value
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const index = y * map.width + x
          if (map.cells[index] === 1 || map.clearance[index] >= radius) continue
          const strength = 1 - map.clearance[index] / Math.max(radius, 0.001)
          ctx.fillStyle = `rgba(164, 95, 67, ${0.1 + 0.12 * strength})`
          ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell)
        }
      }
    }

    // Obstacles.
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (map.cells[y * map.width + x] !== 1) continue
        const px = ox + x * cell
        const py = oy + y * cell
        ctx.fillStyle = '#333a33'
        roundRect(ctx, px + 0.6, py + 0.6, cell - 1.2, cell - 1.2, Math.max(1, cell * 0.16))
        ctx.fill()
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    // Expanded nodes. The trail steps back once the search has finished so
    // the final path stays the focus.
    if (showExpanded) {
      const completed = visibleEvents >= eventCount
      for (let i = 0; i < visibleEvents; i += 1) {
        const event = result.events[i]
        const progress = (i + 1) / Math.max(1, visibleEvents)
        const alpha = completed ? 0.19 : 0.15 + progress * 0.25
        const inset = cell * 0.25
        ctx.fillStyle = `rgba(55, 82, 70, ${alpha})`
        if (result.continuous) {
          ctx.beginPath()
          ctx.arc(
            ox + event.x * cell,
            oy + event.y * cell,
            Math.max(1.2, cell * 0.09),
            0,
            Math.PI * 2,
          )
          ctx.fill()
        } else {
          ctx.fillRect(
            ox + event.x * cell + inset,
            oy + event.y * cell + inset,
            cell - inset * 2,
            cell - inset * 2,
          )
        }
      }
    }

    if (showExpanded && visibleEvents > 0 && visibleEvents < eventCount) {
      const current = result.events[visibleEvents - 1]
      ctx.beginPath()
      ctx.arc(
        ox + (current.x + pathOffset) * cell,
        oy + (current.y + pathOffset) * cell,
        Math.max(2.5, cell * 0.22),
        0,
        Math.PI * 2,
      )
      ctx.fillStyle = '#a45f43'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    // Ghost from the previous run.
    if (showGhost && ghostPath.length > 1) {
      ctx.save()
      ctx.beginPath()
      ghostPath.forEach((point, index) => {
        const px = ox + (point.x + ghostOffset) * cell
        const py = oy + (point.y + ghostOffset) * cell
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.setLineDash([4, 5])
      ctx.strokeStyle = 'rgba(110, 112, 102, 0.55)'
      ctx.lineWidth = Math.max(1.2, cell * 0.075)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
      ctx.restore()
    }

    // Bridge preview: the raw search path behind a processed path.
    if (
      (hoverCard === 'smooth' || hoverCard === 'round' || hoverCard === 'simplify') &&
      result.rawPath.length > 1
    ) {
      ctx.save()
      ctx.beginPath()
      result.rawPath.forEach((point, index) => {
        const px = ox + (point.x + pathOffset) * cell
        const py = oy + (point.y + pathOffset) * cell
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.setLineDash([3, 4])
      ctx.strokeStyle = 'rgba(65, 104, 119, 0.55)'
      ctx.lineWidth = Math.max(1.4, cell * 0.08)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
      ctx.restore()
    }

    // Final path. It stays visible while the expansion replays, so the
    // result and the process can be read at the same time.
    if (pathVisible) {
      ctx.save()
      ctx.beginPath()
      displayPath.forEach((point, index) => {
        const px = ox + (point.x + pathOffset) * cell
        const py = oy + (point.y + pathOffset) * cell
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.86)'
      ctx.lineWidth = Math.max(6, cell * 0.46)
      ctx.stroke()
      ctx.save()
      ctx.shadowColor = 'rgba(47, 93, 80, 0.22)'
      ctx.shadowBlur = Math.max(5, cell * 0.55)
      ctx.strokeStyle = '#2f5d50'
      ctx.lineWidth = Math.max(2.6, cell * 0.23)
      ctx.stroke()
      ctx.restore()

      if (!result.smoothed && displayPath.length < 90) {
        for (let i = 1; i < displayPath.length - 1; i += 2) {
          const point = displayPath[i]
          ctx.beginPath()
          ctx.arc(
            ox + (point.x + pathOffset) * cell,
            oy + (point.y + pathOffset) * cell,
            Math.max(1.2, cell * 0.075),
            0,
            Math.PI * 2,
          )
          ctx.fillStyle = '#2f5d50'
          ctx.fill()
        }
      }
      ctx.restore()
    }

    // Turn preview: mark the corners that the turn penalty is paying for.
    if (hoverCard === 'turn' && pathVisible && displayPath.length > 2) {
      for (let i = 1; i < displayPath.length - 1; i += 1) {
        const prev = displayPath[i - 1]
        const point = displayPath[i]
        const next = displayPath[i + 1]
        const a1 = Math.atan2(point.y - prev.y, point.x - prev.x)
        const a2 = Math.atan2(next.y - point.y, next.x - point.x)
        let delta = Math.abs(a2 - a1)
        if (delta > Math.PI) delta = Math.PI * 2 - delta
        if (delta < 0.02) continue
        ctx.beginPath()
        ctx.arc(
          ox + (point.x + pathOffset) * cell,
          oy + (point.y + pathOffset) * cell,
          Math.max(2.2, cell * 0.12) + delta * cell * 0.22,
          0,
          Math.PI * 2,
        )
        ctx.fillStyle = `rgba(164, 95, 67, ${0.26 + Math.min(0.45, delta / Math.PI)})`
        ctx.fill()
      }
    }

    // Additional card previews. Each card should have a visible consequence
    // on the canvas, so hovering the library or a recipe row explains it.
    if (hoverCard === 'diagonal') {
      const anchor =
        visibleEvents > 0
          ? result.events[Math.min(visibleEvents, result.events.length) - 1]
          : hover ?? { x: map.start.x, y: map.start.y }
      ctx.save()
      ctx.strokeStyle = 'rgba(47, 93, 80, 0.55)'
      ctx.fillStyle = 'rgba(47, 93, 80, 0.08)'
      ctx.lineWidth = 1
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const x = anchor.x + dx
          const y = anchor.y + dy
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue
          roundRect(
            ctx,
            ox + x * cell + 2,
            oy + y * cell + 2,
            cell - 4,
            cell - 4,
            2,
          )
          ctx.fill()
          ctx.stroke()
        }
      }
      ctx.restore()
    }

    if (hoverCard === 'maxTurn' && pathVisible && displayPath.length > 2) {
      const limit = cards.maxTurn.enabled ? cards.maxTurn.value : 45
      for (let i = 1; i < displayPath.length - 1; i += 1) {
        const prev = displayPath[i - 1]
        const point = displayPath[i]
        const next = displayPath[i + 1]
        const a1 = Math.atan2(point.y - prev.y, point.x - prev.x)
        const a2 = Math.atan2(next.y - point.y, next.x - point.x)
        let delta = Math.abs(a2 - a1)
        if (delta > Math.PI) delta = Math.PI * 2 - delta
        const degrees = (delta * 180) / Math.PI
        if (degrees <= limit + 1) continue
        ctx.beginPath()
        ctx.arc(
          ox + (point.x + pathOffset) * cell,
          oy + (point.y + pathOffset) * cell,
          Math.max(4, cell * 0.26),
          0,
          Math.PI * 2,
        )
        ctx.fillStyle = 'rgba(164, 95, 67, 0.32)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(164, 95, 67, 0.75)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    if (hoverCard === 'noUTurn') {
      const route = result.rawPath.length > 1 ? result.rawPath : displayPath
      for (let i = 2; i < route.length; i += 1) {
        const a = route[i - 2]
        const b = route[i]
        if (a.x === b.x && a.y === b.y) {
          ctx.beginPath()
          ctx.arc(
            ox + (route[i - 1].x + pathOffset) * cell,
            oy + (route[i - 1].y + pathOffset) * cell,
            Math.max(3, cell * 0.2),
            0,
            Math.PI * 2,
          )
          ctx.fillStyle = 'rgba(164, 95, 67, 0.4)'
          ctx.fill()
        }
      }
    }

    if (hoverCard === 'diagonalBias' && pathVisible) {
      for (let i = 1; i < displayPath.length; i += 1) {
        const a = displayPath[i - 1]
        const b = displayPath[i]
        const orthogonal = Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6
        ctx.beginPath()
        ctx.moveTo(ox + (a.x + pathOffset) * cell, oy + (a.y + pathOffset) * cell)
        ctx.lineTo(ox + (b.x + pathOffset) * cell, oy + (b.y + pathOffset) * cell)
        ctx.strokeStyle = orthogonal
          ? 'rgba(164, 95, 67, 0.7)'
          : 'rgba(47, 93, 80, 0.28)'
        ctx.lineWidth = Math.max(1.4, cell * 0.09)
        ctx.stroke()
      }
    }

    if (hoverCard === 'lengthWeight' && pathVisible) {
      ctx.save()
      ctx.beginPath()
      displayPath.forEach((point, index) => {
        const px = ox + (point.x + pathOffset) * cell
        const py = oy + (point.y + pathOffset) * cell
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.setLineDash([2, 5])
      ctx.strokeStyle = 'rgba(154, 118, 55, 0.7)'
      ctx.lineWidth = Math.max(1.4, cell * 0.1)
      ctx.stroke()
      ctx.restore()
    }

    if (hoverCard === 'cornerCut') {
      const route = result.rawPath.length > 1 ? result.rawPath : displayPath
      for (let i = 1; i < route.length; i += 1) {
        const a = route[i - 1]
        const b = route[i]
        const dx = Math.sign(b.x - a.x)
        const dy = Math.sign(b.y - a.y)
        if (dx === 0 || dy === 0) continue
        const si = (a.y + dy) * map.width + (a.x + dx)
        if (map.cells[si] !== 1) continue
        ctx.beginPath()
        ctx.arc(
          ox + (b.x + pathOffset) * cell,
          oy + (b.y + pathOffset) * cell,
          Math.max(3, cell * 0.22),
          0,
          Math.PI * 2,
        )
        ctx.fillStyle = 'rgba(164, 95, 67, 0.35)'
        ctx.fill()
      }
    }

    if (hoverCard === 'budget' && cards.budget.enabled) {
      const index = Math.min(
        result.events.length - 1,
        Math.max(0, Math.round(cards.budget.value)),
      )
      const event = result.events[index]
      if (event) {
        ctx.beginPath()
        ctx.arc(
          ox + (event.x + pathOffset) * cell,
          oy + (event.y + pathOffset) * cell,
          Math.max(5, cell * 0.34),
          0,
          Math.PI * 2,
        )
        ctx.strokeStyle = 'rgba(164, 95, 67, 0.85)'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    if (hoverCard === 'strategy' && visibleEvents > 0) {
      const event = result.events[Math.min(visibleEvents, result.events.length) - 1]
      ctx.beginPath()
      ctx.arc(
        ox + (event.x + pathOffset) * cell,
        oy + (event.y + pathOffset) * cell,
        Math.max(5, cell * 0.32),
        0,
        Math.PI * 2,
      )
      ctx.strokeStyle = 'rgba(47, 93, 80, 0.7)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Goal tolerance region.
    if (cards.goalTolerance.enabled && cards.goalTolerance.value > 0) {
      const goalCenterX = ox + (map.goal.x + 0.5) * cell
      const goalCenterY = oy + (map.goal.y + 0.5) * cell
      ctx.beginPath()
      ctx.arc(goalCenterX, goalCenterY, cell * cards.goalTolerance.value, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(164, 95, 67, 0.07)'
      ctx.fill()
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = 'rgba(164, 95, 67, 0.4)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Start and goal. Marker positions interpolate between cells so dragging
    // along a wall reads as a continuous slide instead of a per-cell jump.
    const startX = ox + (markerView.start.x + 0.5) * cell
    const startY = oy + (markerView.start.y + 0.5) * cell
    const goalX = ox + (markerView.goal.x + 0.5) * cell
    const goalY = oy + (markerView.goal.y + 0.5) * cell
    const markerRadius = Math.max(8, cell * 0.4)

    ctx.beginPath()
    ctx.arc(startX, startY, markerRadius + 3.2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(47, 93, 80, 0.12)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(startX, startY, markerRadius, 0, Math.PI * 2)
    ctx.fillStyle = '#2f5d50'
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(goalX, goalY, markerRadius + 3.2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(164, 95, 67, 0.12)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(goalX, goalY, markerRadius, 0, Math.PI * 2)
    ctx.fillStyle = '#a45f43'
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${Math.max(10, cell * 0.34)}px "SFMono-Regular", Consolas, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('S', startX, startY + 0.4)
    ctx.fillText('G', goalX, goalY + 0.4)

    if (editMode !== 'none') {
      const activeX = editMode === 'start' ? startX : goalX
      const activeY = editMode === 'start' ? startY : goalY
      ctx.beginPath()
      ctx.arc(activeX, activeY, markerRadius + 7, 0, Math.PI * 2)
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = editMode === 'start' ? '#416877' : '#a45f43'
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Hovered cell.
    if (hover) {
      ctx.strokeStyle = 'rgba(47, 93, 80, 0.9)'
      ctx.lineWidth = 1.5
      roundRect(ctx, ox + hover.x * cell + 1, oy + hover.y * cell + 1, cell - 2, cell - 2, 3)
      ctx.stroke()
    }

    if (mapEditMode && hover) {
      const offset = Math.floor(brushSize / 2)
      ctx.fillStyle =
        mapEditMode === 'wall'
          ? 'rgba(164, 95, 67, 0.18)'
          : 'rgba(65, 104, 119, 0.14)'
      for (let dy = -offset; dy < brushSize - offset; dy += 1) {
        for (let dx = -offset; dx < brushSize - offset; dx += 1) {
          const x = hover.x + dx
          const y = hover.y + dy
          if (x <= 0 || y <= 0 || x >= map.width - 1 || y >= map.height - 1) {
            continue
          }
          ctx.fillRect(
            ox + x * cell + 1,
            oy + y * cell + 1,
            cell - 2,
            cell - 2,
          )
        }
      }
    }
  }

  function cellAt(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor(
      (event.clientX - rect.left - layout.ox) / layout.cell,
    )
    const y = Math.floor(
      (event.clientY - rect.top - layout.oy) / layout.cell,
    )
    return { x, y }
  }

  function pointIsFree(x: number, y: number, marker: 'start' | 'goal') {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false
    const index = y * map.width + x
    if (map.cells[index] === 1) return false
    if (
      cards.collision.enabled &&
      map.clearance[index] < cards.collision.value - 1e-6
    ) {
      return false
    }
    const other = marker === 'start' ? map.goal : map.start
    return x !== other.x || y !== other.y
  }

  function nearestFreeCell(
    marker: 'start' | 'goal',
    x: number,
    y: number,
    maxRadius = 6,
  ): Point | null {
    let best: Point | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    let bestTravel = Number.POSITIVE_INFINITY
    const current = marker === 'start' ? map.start : map.goal
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
          const nx = x + dx
          const ny = y + dy
          if (!pointIsFree(nx, ny, marker)) continue
          const distance = dx * dx + dy * dy
          const travel =
            (nx - current.x) * (nx - current.x) +
            (ny - current.y) * (ny - current.y)
          if (
            distance < bestDistance ||
            (distance === bestDistance && travel < bestTravel)
          ) {
            bestDistance = distance
            bestTravel = travel
            best = { x: nx, y: ny }
          }
        }
      }
      if (best) return best
    }
    return null
  }

  function placeMarker(marker: 'start' | 'goal', x: number, y: number) {
    if (!pointIsFree(x, y, marker)) return false
    if (marker === 'start') onStartChange({ x, y })
    else onGoalChange({ x, y })
    return true
  }

  function handleWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    event.preventDefault()
    const direction = event.deltaY < 0 ? 1 : -1
    onZoom(Math.max(0.8, Math.min(1.05, zoom + direction * 0.05)))
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0) return
    const cell = cellAt(event)
    if (!cell) return

    if (editMode !== 'none') {
      const target = nearestFreeCell(editMode, cell.x, cell.y)
      if (target && placeMarker(editMode, target.x, target.y)) onPlacePoint()
      else {
        onInvalidPoint?.(
          editMode === 'start'
            ? tr(lang, '附近没有可放置起点的安全格')
            : tr(lang, '附近没有可放置终点的安全格'),
        )
      }
      return
    }

    if (mapEditMode) {
      event.preventDefault()
      paintingRef.current = true
      onPaintCell(cell.x, cell.y)
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers used in tests may not support capture.
      }
      return
    }

    const rect = canvas.getBoundingClientRect()
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    const startX = layout.ox + (markerView.start.x + 0.5) * layout.cell
    const startY = layout.oy + (markerView.start.y + 0.5) * layout.cell
    const goalX = layout.ox + (markerView.goal.x + 0.5) * layout.cell
    const goalY = layout.oy + (markerView.goal.y + 0.5) * layout.cell
    const hitRadius = Math.max(13, layout.cell * 0.72)
    const nearStart = Math.hypot(mx - startX, my - startY) <= hitRadius
    const nearGoal = Math.hypot(mx - goalX, my - goalY) <= hitRadius
    if (!nearStart && !nearGoal) return

    event.preventDefault()
    dragMarkerRef.current = nearStart ? 'start' : 'goal'
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers used in tests may not support capture.
    }
    setHover(null)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const cell = cellAt(event)
    if (!cell) return
    const { x, y } = cell

    if (paintingRef.current && mapEditMode) {
      onPaintCell(x, y)
      return
    }

    if (dragMarkerRef.current) {
      const target = nearestFreeCell(dragMarkerRef.current, x, y)
      if (target) placeMarker(dragMarkerRef.current, target.x, target.y)
      return
    }

    if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
      setHover(null)
      return
    }
    const index = y * map.width + x
    setHover({
      x,
      y,
      blocked: map.cells[index] === 1,
      clearance: map.clearance[index],
    })
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (paintingRef.current) {
      paintingRef.current = false
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      } catch {
        // Ignore capture failures after synthetic pointer events.
      }
      return
    }
    if (!dragMarkerRef.current) return
    dragMarkerRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Ignore capture failures after synthetic pointer events.
    }
  }

  const progress = result.events.length
    ? Math.min(1, playhead / result.events.length)
    : 1

  return (
    <div className="canvas-shell" ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className={`canvas ${editMode !== 'none' || mapEditMode ? 'is-editing' : ''}`}
        aria-label={tr(lang, '路径规划搜索画布；拖动 S 或 G 修改起点和终点')}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          if (!dragMarkerRef.current) setHover(null)
        }}
      />




      {hover ? (
        <div className="canvas-overlay canvas-hover-info">
          <span className={`hover-swatch ${hover.blocked ? 'is-blocked' : ''}`} />
          {hover.blocked
            ? `${tr(lang, '障碍格')} · (${hover.x}, ${hover.y})`
            : `${tr(lang, '可通行')} · (${hover.x}, ${hover.y}) · ${tr(lang, '间隙')} ${hover.clearance.toFixed(1)} ${tr(lang, '格')}`}
        </div>
      ) : null}


      <div className="canvas-progress" aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  )
}
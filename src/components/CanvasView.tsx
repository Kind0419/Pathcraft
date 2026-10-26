import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { tr, useLang } from '../lib/i18n'
import { CANVAS, useTheme } from '../lib/theme'
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
  /** Off for solvers that iterate instead of expanding a frontier (ACO / GA). */
  showTrail?: boolean
  showPath: boolean
  showGhost: boolean
  editMode: EditMode
  onStartChange: (point: Point) => void
  onGoalChange: (point: Point) => void
  onMarkerDrag?: (active: boolean) => void
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
  const pad = 0
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

/**
 * Trims a polyline to the given fraction of its total length, so the route
 * visibly grows out of the start and arrives at the goal as playback runs.
 */
function trimPath(points: Point[], fraction: number): { points: Point[]; tip: Point | null } {
  if (points.length < 2) return { points, tip: null }
  const clamp = Math.max(0, Math.min(1, fraction))
  if (clamp >= 1) {
    return { points, tip: points[points.length - 1] }
  }
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    )
    lengths.push(length)
    total += length
  }
  if (total < 1e-9 || clamp <= 0) {
    return { points: [points[0]], tip: { ...points[0] } }
  }
  const target = total * clamp
  const out: Point[] = [points[0]]
  let travelled = 0
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i]
    if (travelled + length <= target) {
      out.push(points[i + 1])
      travelled += length
      continue
    }
    const t = length <= 1e-9 ? 0 : (target - travelled) / length
    const from = points[i]
    const to = points[i + 1]
    const tip = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    }
    out.push(tip)
    return { points: out, tip }
  }
  return { points: out, tip: out[out.length - 1] }
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
  showTrail = true,
  showPath,
  showGhost,
  editMode,
  onStartChange,
  onGoalChange,
  onMarkerDrag,
  onPlacePoint,
  onInvalidPoint,
  mapEditMode,
  brushSize,
  onPaintCell,
  zoom,
  onZoom,
}: CanvasViewProps) {
  const lang = useLang()
  const theme = useTheme()
  const C = CANVAS[theme]
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
  }, [size, map, cards, result, playhead, ghostPath, hover, hoverCard, showExpanded, showPath, showGhost, layout, displayPath, mapEditMode, brushSize, editMode, markerView, theme])

  function draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const { cell, ox, oy } = layout
    const pathOffset = result.continuous ? 0 : 0.5
    const ghostOffset = ghostContinuous ? 0 : 0.5
    const eventCount = result.events.length
    const visibleEvents = Math.max(0, Math.min(playhead, eventCount))
    const replaying = visibleEvents < eventCount
    const progress =
      eventCount > 0 ? Math.max(0, Math.min(1, visibleEvents / eventCount)) : 1
    // The route is revealed as the search advances, so playback shows the path
    // travelling from the start to the goal instead of a finished line sitting
    // on top of the expanded cells. Scrub or pause and it holds the same point.
    const reveal = replaying ? progress : 1
    const grown = trimPath(displayPath, reveal)
    const pathVisible =
      result.status === 'success' && showPath && displayPath.length > 1 && grown.points.length > 1
    const pathPoints = grown.points

    ctx.clearRect(0, 0, width, height)
    const paper = ctx.createRadialGradient(
      width * 0.5,
      height * 0.32,
      0,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.72,
    )
    paper.addColorStop(0, C.paperTop)
    paper.addColorStop(1, C.paperLow)
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, width, height)

    // Paper grid.
    ctx.strokeStyle = C.grid
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

    ctx.strokeStyle = C.gridMajor
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

    // The board's edge.
    //
    // The outer ring of cells is structural, not content: it closes the region
    // so the search has a boundary, but drawing it as wall put a hard black
    // rectangle around every screenshot. Leaving it unpainted went the other
    // way — the field ran off the frame and the map stopped having an edge at
    // all, which reads as a crop rather than a board. So the ring is a margin
    // now: a faint fill across the whole ring plus one hairline at its inner
    // edge. It says "the map ends here" at about the weight of the grid, which
    // is all a boundary needs to say when the walls are the subject.
    const boardW = map.width * cell
    const boardH = map.height * cell
    // One cell: the band is the structural ring, and the hairline lands exactly
    // on the first interior grid line, so the edge is where the map says it is.
    const inset = cell
    ctx.fillStyle = C.frameFill
    ctx.fillRect(ox, oy, boardW, inset)
    ctx.fillRect(ox, oy + boardH - inset, boardW, inset)
    ctx.fillRect(ox, oy, inset, boardH)
    ctx.fillRect(ox + boardW - inset, oy, inset, boardH)

    ctx.strokeStyle = C.frameLine
    ctx.lineWidth = 1
    ctx.strokeRect(
      Math.round(ox + inset) + 0.5,
      Math.round(oy + inset) + 0.5,
      Math.round(boardW - inset * 2),
      Math.round(boardH - inset * 2),
    )

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

    // Algorithm field (pheromone for ACO). Drawn under the obstacles so walls
    // stay readable, and only while the search layer is on.
    //
    // The field is rendered at one pixel per cell into an offscreen canvas and
    // then scaled up with smoothing. Filling every cell rect instead produced
    // visible square blocks — at 44×28 the field looked like extra obstacles
    // rather than a gradient, which is the opposite of what it means.
    if (result.field && showExpanded) {
      const field = result.field
      const max = Math.max(field.max, 1e-6)
      const tile = document.createElement('canvas')
      tile.width = field.width
      tile.height = field.height
      const tileCtx = tile.getContext('2d')
      if (tileCtx) {
        const image = tileCtx.createImageData(field.width, field.height)
        for (let y = 0; y < field.height; y += 1) {
          for (let x = 0; x < field.width; x += 1) {
            const index = y * field.width + x
            const strength = Math.min(1, field.values[index] / max)
            // ^0.7 lifts the mid field so the corridor is visible at all;
            // a pure square left nothing on screen but the path itself.
            const alpha =
              map.cells[index] === 1 || strength <= 0.02
                ? 0
                : Math.min(0.6, 0.07 + 0.55 * Math.pow(strength, 0.7))
            const at = index * 4
            image.data[at] = 164
            image.data[at + 1] = 95
            image.data[at + 2] = 67
            image.data[at + 3] = Math.round(alpha * 255)
          }
        }
        tileCtx.putImageData(image, 0, 0)
        ctx.save()
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(tile, ox, oy, map.width * cell, map.height * cell)
        ctx.restore()
      }
    }

    // Obstacles.
    //
    // One continuous mass, drawn with no per-cell gap. The previous version inset
    // every tile by 0.4 px "so a wall still breaks into cells", but at this cell
    // size that 0.8 px gap is a bright hairline: a 6x6 block read as 36 tiles of
    // lego rather than one piece of stone, and the whole board shimmered. Cells
    // are now butted (plus a half-pixel overlap to kill antialiasing seams) and
    // the grid is implied by the paper behind them, not cut into the mass.
    ctx.fillStyle = C.wall
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (map.cells[y * map.width + x] !== 1) continue
        // The outer ring is structural, not content: it exists so the search has
        // a closed region, but drawing it puts a hard rectangle around the shot.
        // Left unpainted the field simply runs off frame, which is what a screen
        // recording of a work surface should do.
        if (x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1) continue
        ctx.fillRect(ox + x * cell, oy + y * cell, cell + 1, cell + 1)
      }
    }

    // A lit lip along the top of every wall run. One extra pass over the cells,
    // and it is what turns a flat rectangle into a block with a top face -- the
    // 2D answer to the shading the 3D view gets for free. Transparent in the
    // light theme, where the walls are dark on paper and already read.
    if (C.wallEdge !== 'rgba(255, 255, 255, 0)') {
      ctx.fillStyle = C.wallEdge
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          if (map.cells[y * map.width + x] !== 1) continue
          if (y > 0 && map.cells[(y - 1) * map.width + x] === 1) continue
          ctx.fillRect(ox + x * cell, oy + y * cell, cell + 1, Math.max(1, cell * 0.08))
        }
      }
    }

    // Expanded nodes.
    //
    // Rendered as inset cells, not a full-cell wash: the search is a sequence of
    // discrete steps and the dots say that, while a wash reads as a shaded
    // region. What made the first version of this noisy was drawing every node
    // with its own fillStyle — the eye got three thousand slightly different
    // greens. Now the trail is quantised into a handful of alpha steps and each
    // step is filled as one path, so the only variation left is the one that
    // carries meaning: older nodes fade, the wavefront stays bright.
    if (showExpanded && showTrail) {
      const completed = visibleEvents >= eventCount
      const steps = 6
      const buckets: number[][] = Array.from({ length: steps }, () => [])

      for (let i = 0; i < visibleEvents; i += 1) {
        // Order is the only thing the trail is really saying — this cell was
        // reached before that one. Keeping the same six steps after the replay
        // ends (just at a lower level) means the finished frame still shows
        // which ground the search covered first instead of turning into an
        // even dot grid.
        const level = Math.min(
          steps - 1,
          Math.floor(((i + 1) / Math.max(1, visibleEvents)) * steps),
        )
        buckets[level].push(i)
      }

      // Slightly finer than the original half-cell block: same dot language,
      // less ink, so a fully explored board stays quiet behind the path.
      const inset = cell * 0.34
      const size = Math.max(1, cell - inset * 2)
      // A hair of corner rounding keeps the trail from reading as graph paper
      // without turning the dots into blobs.
      const radius = Math.min(size * 0.22, cell * 0.14)
      const dot = !result.continuous && size >= 4 && typeof ctx.roundRect === 'function'
      // Completed replay steps the whole trail back to the original weight so
      // the path stays the focal element; during replay the wavefront is allowed
      // to be much stronger, which is what makes the search visible as motion.
      const low = completed ? 0.10 : 0.09
      const high = completed ? 0.10 : 0.28

      ctx.save()
      for (let level = 0; level < steps; level += 1) {
        const bucket = buckets[level]
        if (bucket.length === 0) continue
        const alpha = low + (level / (steps - 1)) * (high - low)
        ctx.fillStyle = `rgba(${C.trail.join(', ')}, ${alpha})`
        ctx.beginPath()
        if (result.continuous) {
          for (const i of bucket) {
            const event = result.events[i]
            const cx = ox + event.x * cell
            const cy = oy + event.y * cell
            const r = Math.max(1.1, cell * 0.09)
            // moveTo before every arc, otherwise each circle is joined to the
            // previous one by a stray chord.
            ctx.moveTo(cx + r, cy)
            ctx.arc(cx, cy, r, 0, Math.PI * 2)
          }
        } else {
          for (const i of bucket) {
            const event = result.events[i]
            const px = ox + event.x * cell + inset
            const py = oy + event.y * cell + inset
            if (dot) ctx.roundRect(px, py, size, size, radius)
            else ctx.rect(px, py, size, size)
          }
        }
        ctx.fill()
      }
      ctx.restore()
    }

    // Growing route. During replay the final path is drawn only as far as the
    // search has progressed, so the line visibly travels out of the start and
    // reaches the goal instead of appearing complete from the first frame.
    if (pathVisible) {
      ctx.save()
      ctx.beginPath()
      pathPoints.forEach((point, index) => {
        const px = ox + (point.x + pathOffset) * cell
        const py = oy + (point.y + pathOffset) * cell
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = C.pathEdge
      ctx.lineWidth = Math.max(6, cell * 0.46)
      ctx.stroke()
      ctx.save()
      ctx.shadowColor = C.pathGlow
      ctx.shadowBlur = Math.max(5, cell * 0.55)
      ctx.strokeStyle = C.path
      ctx.lineWidth = Math.max(2.6, cell * 0.23)
      ctx.stroke()
      ctx.restore()

      // Waypoint dots and the moving head, so the growth reads as a direction.
      if (!result.smoothed && pathPoints.length < 90) {
        for (let i = 1; i < pathPoints.length - 1; i += 2) {
          const point = pathPoints[i]
          ctx.beginPath()
          ctx.arc(
            ox + (point.x + pathOffset) * cell,
            oy + (point.y + pathOffset) * cell,
            Math.max(1.2, cell * 0.075),
            0,
            Math.PI * 2,
          )
          ctx.fillStyle = C.start
          ctx.fill()
        }
      }
      const tip = grown.tip
      if (replaying && tip) {
        ctx.beginPath()
        ctx.arc(
          ox + (tip.x + pathOffset) * cell,
          oy + (tip.y + pathOffset) * cell,
          Math.max(3, cell * 0.26),
          0,
          Math.PI * 2,
        )
        ctx.fillStyle = C.goal
        ctx.fill()
        ctx.strokeStyle = C.markerStroke
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
      ctx.restore()
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
      ctx.fillStyle = C.goal
      ctx.fill()
      ctx.strokeStyle = C.markerStroke
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
      ctx.strokeStyle = C.ghost
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
      ctx.strokeStyle = C.start
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
    ctx.fillStyle = C.start
    ctx.fill()
    ctx.strokeStyle = C.markerStroke
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(goalX, goalY, markerRadius + 3.2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(164, 95, 67, 0.12)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(goalX, goalY, markerRadius, 0, Math.PI * 2)
    ctx.fillStyle = C.goal
    ctx.fill()
    ctx.strokeStyle = C.markerStroke
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.fillStyle = C.markerInk
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
      ctx.strokeStyle = C.start
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
    onMarkerDrag?.(true)
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
    onMarkerDrag?.(false)
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
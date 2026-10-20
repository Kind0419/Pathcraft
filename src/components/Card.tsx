import type { CSSProperties, DragEvent } from 'react'
import { cardValueLabel, type CardDef } from '../lib/cards'
import type { CardState } from '../lib/types'
import { Icon } from './Icon'

interface CardProps {
  def: CardDef
  state: CardState
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onValue: (value: number) => void
  onAdjustStart: () => void
  onAdjustEnd: () => void
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (event: DragEvent<HTMLSpanElement>) => void
  onDragEnd?: () => void
}

export function Card({
  def,
  state,
  selected,
  onSelect,
  onToggle,
  onValue,
  onAdjustStart,
  onAdjustEnd,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
}: CardProps) {
  const hasSlider = def.kind !== 'toggle' && def.kind !== 'choice'
  const enabled = state.enabled
  const min = def.min ?? 0
  const max = def.max ?? 1
  const fill = max > min ? ((state.value - min) / (max - min)) * 100 : 0

  return (
    <article
      className={`card ${enabled ? 'is-enabled' : 'is-disabled'} ${
        selected ? 'is-selected' : ''
      } ${dragging ? 'is-dragging' : ''}`}
      style={{ '--card-accent': def.accent } as CSSProperties}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${def.title}，${enabled ? '已启用' : '已停用'}`}
    >
      <span className="card-accent" aria-hidden="true" />
      <div className="card-main">
        <div className="card-topline">
          {draggable ? (
            <span
              className="drag-grip"
              draggable
              role="button"
              aria-label={`拖动${def.title}排序`}
              title="拖动排序"
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => onDragStart?.(event)}
              onDragEnd={onDragEnd}
            >
              <Icon name="grip" size={12} />
            </span>
          ) : null}
          <span className="card-icon">
            <Icon name={def.icon} size={15} />
          </span>
          <div className="card-heading">
            <span className="card-title">{def.title}</span>
            <span className="card-subtitle">{def.subtitle}</span>
          </div>
          <button
            className={`switch ${enabled ? 'is-on' : ''}`}
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`${enabled ? '停用' : '启用'}${def.title}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            <span className="switch-thumb" />
          </button>
        </div>

        {def.kind === 'choice' ? (
          <div
            className="card-choice"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {def.options?.map((option, index) => (
              <button
                key={option}
                type="button"
                className={`choice-chip ${
                  Math.round(state.value) === index ? 'is-active' : ''
                }`}
                disabled={!enabled}
                aria-pressed={Math.round(state.value) === index}
                onClick={(event) => {
                  event.stopPropagation()
                  onValue(index)
                }}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {hasSlider ? (
          <div
            className="card-control"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <input
              className="range range-card"
              type="range"
              min={def.min ?? 0}
              max={def.max ?? 1}
              step={def.step ?? 0.05}
              value={state.value}
              disabled={!enabled}
              aria-label={`${def.title}参数`}
              style={
                {
                  '--fill': `${fill}%`,
                  '--range-color': def.accent,
                } as CSSProperties
              }
              onChange={(event) => onValue(Number(event.target.value))}
              onPointerDown={onAdjustStart}
              onPointerUp={onAdjustEnd}
              onPointerCancel={onAdjustEnd}
              onBlur={onAdjustEnd}
            />
            <span className="card-value">{cardValueLabel(def, state.value)}</span>
          </div>
        ) : null}
      </div>
    </article>
  )
}
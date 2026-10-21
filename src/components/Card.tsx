import type { CSSProperties, DragEvent } from 'react'
import { cardValueLabel, type CardDef } from '../lib/cards'
import { tr, useLang } from '../lib/i18n'
import type { CardState } from '../lib/types'
import { Icon } from './Icon'

interface CardProps {
  def: CardDef
  state: CardState
  selected: boolean
  index?: number
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
  index,
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
  const lang = useLang()
  const title = tr(lang, def.title)
  const subtitle = tr(lang, def.subtitle)
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
      aria-label={lang === 'en' ? `${title} (${def.param}), ${enabled ? 'enabled' : 'disabled'}` : `${title}（${def.param}），${enabled ? '已启用' : '已停用'}`}
    >
      <div className="card-topline">
        {draggable ? (
          <span
            className="drag-grip"
            draggable
            role="button"
            aria-label={lang === 'en' ? `Drag ${title} to reorder` : `拖动${title}排序`}
            title={tr(lang, '拖动排序')}
            onClick={(event) => event.stopPropagation()}
            onDragStart={(event) => onDragStart?.(event)}
            onDragEnd={onDragEnd}
          >
            <Icon name="grip" size={11} />
          </span>
        ) : (
          <span className="drag-grip is-placeholder" aria-hidden="true" />
        )}
        <span className="card-order">
          {index === undefined ? '—' : String(index + 1).padStart(2, '0')}
        </span>
        <div className="card-heading">
          <span className="card-title-row">
            <span className="card-title">{title}</span>
            <span className="card-param">{def.param}</span>
          </span>
          <span className="card-subtitle" title={subtitle}>{subtitle}</span>
        </div>
        <span className="card-value">{cardValueLabel(def, state.value, lang)}</span>
        <button
          className={`switch ${enabled ? 'is-on' : ''}`}
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={lang === 'en' ? `${enabled ? 'Disable' : 'Enable'} ${title}` : `${enabled ? '停用' : '启用'}${title}`}
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
          {def.options?.map((option, optionIndex) => (
            <button
              key={option}
              type="button"
              className={`choice-chip ${
                Math.round(state.value) === optionIndex ? 'is-active' : ''
              }`}
              disabled={!enabled}
              aria-pressed={Math.round(state.value) === optionIndex}
              onClick={(event) => {
                event.stopPropagation()
                onValue(optionIndex)
              }}
            >
              {tr(lang, option)}
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
            aria-label={lang === 'en' ? `${title} parameter ${def.param}` : `${def.title}参数 ${def.param}`}
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
          <span className="card-scale">
            {def.min ?? 0}
            <span>—</span>
            {def.max ?? 1}
          </span>
        </div>
      ) : null}
    </article>
  )
}
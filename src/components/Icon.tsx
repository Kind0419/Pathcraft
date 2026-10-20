import type { SVGProps } from 'react'

export type IconName =
  | 'logo'
  | 'compass'
  | 'diagonal'
  | 'clearance'
  | 'turn'
  | 'shield'
  | 'uturn'
  | 'angle'
  | 'cut'
  | 'smooth'
  | 'round'
  | 'grip'
  | 'plus'
  | 'minus'
  | 'play'
  | 'pause'
  | 'stepBack'
  | 'stepForward'
  | 'reset'
  | 'download'
  | 'share'
  | 'chevronDown'
  | 'layers'
  | 'eye'
  | 'eyeOff'
  | 'edit'
  | 'eraser'
  | 'trash'
  | 'info'
  | 'check'
  | 'alert'
  | 'close'
  | 'spark'
  | 'sliders'
  | 'target'
  | 'route'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
  strokeWidth?: number
}

export function Icon({ name, size = 16, strokeWidth = 1.8, ...props }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  }

  switch (name) {
    case 'logo':
      return (
        <svg {...common} viewBox="0 0 32 32" strokeWidth={1.7}>
          <rect x="3" y="3" width="11" height="11" rx="3" />
          <rect x="18" y="3" width="11" height="11" rx="3" />
          <rect x="3" y="18" width="11" height="11" rx="3" />
          <path d="M18 23.5h4.5a3 3 0 0 0 3-3V18" />
          <circle cx="25.5" cy="25.5" r="2.1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'compass':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="m14.7 9.3-1.5 3.9-3.9 1.5 1.5-3.9 3.9-1.5Z" />
        </svg>
      )
    case 'diagonal':
      return (
        <svg {...common}>
          <path d="M5 19 19 5" />
          <path d="M13 5h6v6" />
          <path d="M5 13v6h6" />
        </svg>
      )
    case 'clearance':
      return (
        <svg {...common}>
          <path d="M4 18c2.5-5 5.5-7.5 9-7.5S19.5 13 22 18" />
          <path d="M4 21h16" />
          <path d="M12 3v4" />
          <path d="m9.5 5.5 2.5-2.5 2.5 2.5" />
        </svg>
      )
    case 'turn':
      return (
        <svg {...common}>
          <path d="M5 19V9a4 4 0 0 1 4-4h8" />
          <path d="m14 2 3 3-3 3" />
          <circle cx="5" cy="19" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5.5c0 4.2 2.8 7.5 7 9.5 4.2-2 7-5.3 7-9.5V6l-7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      )
    case 'uturn':
      return (
        <svg {...common}>
          <path d="M18 17V9a4 4 0 0 0-4-4H6" />
          <path d="m9 2-3 3 3 3" />
          <path d="M18 17v3" />
        </svg>
      )
    case 'angle':
      return (
        <svg {...common}>
          <path d="M4 18 12 5l8 13" />
          <path d="M8.5 14.5A6 6 0 0 1 12 11a6 6 0 0 1 3.5 3.5" />
        </svg>
      )
    case 'cut':
      return (
        <svg {...common}>
          <path d="M4 4h6l10 10" />
          <path d="M4 20h6L20 10" />
          <path d="M13 13l-3 3" />
          <path d="M13 11l-3-3" />
        </svg>
      )
    case 'round':
      return (
        <svg {...common}>
          <path d="M4 19V9a5 5 0 0 1 5-5h11" />
          <path d="M4 19h4" />
          <path d="M16 4v3" />
        </svg>
      )
    case 'grip':
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <circle cx="9" cy="7" r="1.3" />
          <circle cx="15" cy="7" r="1.3" />
          <circle cx="9" cy="12" r="1.3" />
          <circle cx="15" cy="12" r="1.3" />
          <circle cx="9" cy="17" r="1.3" />
          <circle cx="15" cy="17" r="1.3" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )
    case 'minus':
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      )
    case 'smooth':
      return (
        <svg {...common}>
          <path d="M4 18c0-6 5-10 8-10s4 6 8 6" />
          <path d="M4 18h3" />
          <path d="M18 14h2" />
          <circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="20" cy="14" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'play':
      return (
        <svg {...common}>
          <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'pause':
      return (
        <svg {...common}>
          <path d="M8 5v14M16 5v14" strokeWidth={3} />
        </svg>
      )
    case 'stepBack':
      return (
        <svg {...common}>
          <path d="M7 5v14" />
          <path d="m18 6-9 6 9 6V6Z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'stepForward':
      return (
        <svg {...common}>
          <path d="M17 5v14" />
          <path d="m6 6 9 6-9 6V6Z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'reset':
      return (
        <svg {...common}>
          <path d="M4 10a8 8 0 1 1 2.4 6.4" />
          <path d="M4 4v6h6" />
        </svg>
      )
    case 'download':
      return (
        <svg {...common}>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      )
    case 'share':
      return (
        <svg {...common}>
          <circle cx="18" cy="5" r="2.5" />
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="18" cy="19" r="2.5" />
          <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
        </svg>
      )
    case 'chevronDown':
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      )
    case 'layers':
      return (
        <svg {...common}>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 16 9 5 9-5" />
        </svg>
      )
    case 'eye':
      return (
        <svg {...common}>
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      )
    case 'edit':
      return (
        <svg {...common}>
          <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
          <path d="m13.5 6.5 4 4" />
        </svg>
      )
    case 'eraser':
      return (
        <svg {...common}>
          <path d="m4 16 7.5-7.5a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3L12 20H7l-3-3Z" />
          <path d="M9 9l6 6" />
          <path d="M12 20h8" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M9 7V5h6v2" />
          <path d="M6 7l1 13h10l1-13" />
          <path d="M10 11v5M14 11v5" />
        </svg>
      )
    case 'eyeOff':
      return (
        <svg {...common}>
          <path d="M3 3l18 18" />
          <path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9 7 9 7a15 15 0 0 1-2.3 3.1" />
          <path d="M6.6 6.6C4.2 8.2 3 12 3 12s3.5 7 9 7a9.8 9.8 0 0 0 4.1-.9" />
          <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        </svg>
      )
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5" />
          <circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="m5 12 4 4L19 6" />
        </svg>
      )
    case 'alert':
      return (
        <svg {...common}>
          <path d="M12 3 2.8 20h18.4L12 3Z" />
          <path d="M12 9v5" />
          <circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'close':
      return (
        <svg {...common}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      )
    case 'spark':
      return (
        <svg {...common}>
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
          <path d="m6.5 6.5 2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
        </svg>
      )
    case 'sliders':
      return (
        <svg {...common}>
          <path d="M4 7h16M4 17h16" />
          <circle cx="9" cy="7" r="2.2" fill="var(--surface)" />
          <circle cx="15" cy="17" r="2.2" fill="var(--surface)" />
        </svg>
      )
    case 'target':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      )
    case 'route':
      return (
        <svg {...common}>
          <circle cx="5" cy="18" r="2" />
          <circle cx="19" cy="6" r="2" />
          <path d="M7 17.2 12 12l-2-2 4-4 3 3-2 2 2 2" />
        </svg>
      )
    default:
      return null
  }
}
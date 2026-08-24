/**
 * @file Inline SVG icon set.
 *
 * One small component per glyph so pages never repeat raw <svg> markup.
 * Every icon inherits its colour via `currentColor` and can be sized with the
 * `size` prop; any other prop is forwarded to the root <svg>.
 */

/** Shared props for feather-style stroke icons. */
const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

function Svg({ size = 24, children, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...props}>
      {children}
    </svg>
  )
}

/* ── Brand ────────────────────────────────────────────────────────────────── */

export function LogoMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="url(#logo-grad)" />
      <path d="M12 10L22 16L12 22V10Z" fill="white" />
      <defs>
        <linearGradient id="logo-grad" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/* ── Playback ─────────────────────────────────────────────────────────────── */

export function PlayIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </Svg>
  )
}

export function PlaySolidIcon(props) {
  return (
    <Svg fill="currentColor" {...props}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </Svg>
  )
}

export function PauseIcon(props) {
  return (
    <Svg fill="currentColor" {...props}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Svg>
  )
}

export function SkipBackIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </Svg>
  )
}

export function SkipForwardIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </Svg>
  )
}

export function VolumeIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </Svg>
  )
}

export function VolumeOffIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </Svg>
  )
}

/* ── Navigation & actions ─────────────────────────────────────────────────── */

export function ArrowLeftIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </Svg>
  )
}

export function UsersIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  )
}

export function LockIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  )
}

export function UnlockIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </Svg>
  )
}

export function GlobeIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Svg>
  )
}

export function UploadIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </Svg>
  )
}

export function LogInIcon(props) {
  return (
    <Svg {...strokeProps} strokeWidth={2.5} {...props}>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </Svg>
  )
}

export function DownloadIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  )
}

export function LinkIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  )
}

export function MaximizeIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </Svg>
  )
}

export function MinimizeIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </Svg>
  )
}

export function MessageIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  )
}

export function XIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  )
}

export function SendIcon(props) {
  return (
    <Svg {...strokeProps} {...props}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </Svg>
  )
}

import type { AvatarShape, AvatarSpec } from '../avatar'

const BURST =
  '20,2 23.8,6 29,4.4 30.3,9.7 35.6,11 34,16.2 38,20 34,23.8 35.6,29 30.3,30.3 29,35.6 23.8,34 20,38 16.2,34 11,35.6 9.7,30.3 4.4,29 6,23.8 2,20 6,16.2 4.4,11 9.7,9.7 11,4.4 16.2,6'

function Shape({ shape }: { shape: AvatarShape }) {
  switch (shape) {
    case 'circle':
      return <circle className="avatar__shape" cx="20" cy="20" r="17.5" />
    case 'square':
      return <rect className="avatar__shape" x="3.5" y="3.5" width="33" height="33" rx="5" />
    case 'diamond':
      return <polygon className="avatar__shape" points="20,1.5 38.5,20 20,38.5 1.5,20" />
    case 'hexagon':
      return <polygon className="avatar__shape" points="20,2 36,11 36,29 20,38 4,29 4,11" />
    case 'burst':
      return <polygon className="avatar__shape" points={BURST} />
  }
}

export function RobotIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="robot-icon">
      <line x1="8" y1="1.5" x2="8" y2="4" />
      <circle cx="8" cy="1.8" r="1.2" className="robot-icon__fill" />
      <rect x="2.5" y="4" width="11" height="9" rx="2" className="robot-icon__head" />
      <rect x="5" y="7" width="2" height="2" className="robot-icon__fill" />
      <rect x="9" y="7" width="2" height="2" className="robot-icon__fill" />
      <line x1="5.5" y1="11" x2="10.5" y2="11" />
    </svg>
  )
}

/** A player's icon: their shape and colour with their initial, and a robot badge for AI companions. */
export function Avatar({ spec, small = false }: { spec: AvatarSpec; small?: boolean }) {
  return (
    <span className={`avatar avatar--c${spec.colour}${small ? ' avatar--small' : ''}`} data-shape={spec.shape}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <Shape shape={spec.shape} />
        <text className="avatar__initial" x="20" y="21" textAnchor="middle" dominantBaseline="central">
          {spec.initial}
        </text>
      </svg>
      {spec.bot && (
        <span className="avatar__bot" title="AI companion" data-testid="bot-badge">
          <RobotIcon />
          <span className="sr-only">AI companion</span>
        </span>
      )}
    </span>
  )
}

/** The storyteller's token, the cassette from the logo. */
export function StorytellerToken() {
  return (
    <span className="storyteller-token" data-tutorial="storyteller" title="Storyteller" data-testid="storyteller-token">
      <svg viewBox="0 0 92 64" aria-hidden="true">
        <rect className="storyteller-token__body" x="2" y="2" width="88" height="60" rx="7" />
        <rect className="storyteller-token__label" x="13" y="11" width="66" height="26" rx="3" />
        <circle className="storyteller-token__reel" cx="31" cy="24" r="7" />
        <circle className="storyteller-token__reel" cx="61" cy="24" r="7" />
        <path className="storyteller-token__line" d="M24 62l5-14h34l5 14" />
      </svg>
    </span>
  )
}

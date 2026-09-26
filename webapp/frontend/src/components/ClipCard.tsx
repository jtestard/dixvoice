import { playClip } from '../audio'
import { hash } from '../hash'
import { usePlayingKey } from '../usePlayingKey'
import type { Clip } from '../types'

interface Props {
  clip: Clip
  index: number
  selected?: boolean
  disabled?: boolean
  actionLabel?: string
  onSelect?: (clipId: string) => void
  badge?: string
  badgeKind?: 'accent' | 'plain'
  children?: React.ReactNode
}

const BARS = 16
const ENVELOPE = [0.35, 0.6, 0.85]

/** Stable pseudo-random bar heights (in %) for a clip id, faded in and out at both ends. */
function waveform(clipId: string): number[] {
  let seed = hash(clipId) || 1
  const bars: number[] = []
  for (let i = 0; i < BARS; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    const r = (seed >>> 0) / 4294967296
    const fade = ENVELOPE[Math.min(i, BARS - 1 - i)] ?? 1
    bars.push(Math.round((25 + r * 75) * fade))
  }
  return bars
}

export function ClipCard({ clip, index, selected, disabled, actionLabel, onSelect, badge, badgeKind = 'plain', children }: Props) {
  const playing = usePlayingKey() === clip.clipId
  const label = `Clip ${index + 1}`
  const classes = ['clip-card', selected && 'clip-card--selected', playing && 'clip-card--playing'].filter(Boolean).join(' ')
  return (
    <div className={classes} data-testid={`clip-${clip.clipId}`}>
      <button type="button" className="clip-card__tape" onClick={() => playClip(clip.clipUrl, clip.clipId)} aria-label={`Play ${label}`}>
        <span className="clip-card__label">CLIP {String(index + 1).padStart(2, '0')}</span>
        <span className="clip-card__wave" aria-hidden="true">
          {waveform(clip.clipId).map((h, i) => (
            <span key={i} className="clip-card__bar" style={{ height: `${h}%`, animationDelay: `${(i % 5) * -90}ms` }} />
          ))}
        </span>
        <span className="clip-card__foot" aria-hidden="true">
          <span className={playing ? 'icon-pause' : 'icon-play'} />
          <span className="clip-card__dur">2s</span>
        </span>
      </button>
      {badge && <span className={`tag clip-card__badge${badgeKind === 'accent' ? ' tag--accent' : ''}`}>{badge}</span>}
      {onSelect && (
        <button
          type="button"
          className={`btn btn--small ${selected ? 'btn--primary' : 'btn--secondary'}`}
          disabled={disabled}
          aria-pressed={selected}
          onClick={() => onSelect(clip.clipId)}
        >
          {selected ? 'Selected' : (actionLabel ?? 'Pick')}
        </button>
      )}
      {children}
    </div>
  )
}

export function FaceDownCard({ label = 'Face-down clip' }: { label?: string }) {
  return (
    <div className="facedown" role="img" aria-label={label}>
      <span className="facedown__q" aria-hidden="true">
        ?
      </span>
    </div>
  )
}

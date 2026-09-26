import { playClip } from '../audio'
import { usePlayingKey } from '../usePlayingKey'
import type { Clip } from '../types'

interface Props {
  clip: Clip
  label: string
  selected?: boolean
  disabled?: boolean
  actionLabel?: string
  onSelect?: (clipId: string) => void
  badge?: string
  children?: React.ReactNode
}

export function ClipCard({ clip, label, selected, disabled, actionLabel, onSelect, badge, children }: Props) {
  const playing = usePlayingKey() === clip.clipId
  return (
    <div className={`clip-card${selected ? ' clip-card--selected' : ''}`} data-testid={`clip-${clip.clipId}`}>
      <button
        type="button"
        className={`btn btn--play${playing ? ' btn--playing' : ''}`}
        onClick={() => playClip(clip.clipUrl, clip.clipId)}
        aria-label={`Play ${label}`}
      >
        <span aria-hidden="true">{playing ? '◼' : '▶'}</span> {label}
      </button>
      {badge && <span className="clip-card__badge">{badge}</span>}
      {onSelect && (
        <button
          type="button"
          className={`btn ${selected ? 'btn--primary' : 'btn--secondary'}`}
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

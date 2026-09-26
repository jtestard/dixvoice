import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { playClip, progress, sampleWave } from '../audio'
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
  /** The card is leaving the hand (just submitted). */
  flying?: boolean
  /** Your vote is on this card. */
  voted?: boolean
  /** Reveal: this is the storyteller's clip — it lights up. */
  correct?: boolean
  children?: ReactNode
}

const BARS = 16
const ENVELOPE = [0.35, 0.6, 0.85]
const LEVELS = new Float32Array(BARS)

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

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

/** Drives the 16 bars and the progress strip from the real audio while the card plays. DOM only, no re-render per frame. */
function useLiveWave(playing: boolean, waveRef: RefObject<HTMLSpanElement | null>, progRef: RefObject<HTMLSpanElement | null>) {
  useEffect(() => {
    const wave = waveRef.current
    const prog = progRef.current
    if (!playing || !wave) return
    const bars = Array.from(wave.children) as HTMLElement[]
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    const tick = (t: number) => {
      const live = sampleWave(LEVELS)
      if (!reduced) {
        for (let i = 0; i < bars.length; i++) {
          const s = live ? Math.min(1.6, 0.25 + LEVELS[i] * 5.5) : 0.35 + 0.65 * Math.abs(Math.sin(t / 110 + i * 0.9))
          bars[i].style.transform = `scaleY(${s.toFixed(2)})`
        }
      }
      if (prog) prog.style.width = `${(progress() * 100).toFixed(1)}%`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      for (const b of bars) b.style.transform = ''
      if (prog) prog.style.width = '0%'
    }
  }, [playing, waveRef, progRef])
}

export function ClipCard({ clip, index, selected, disabled, actionLabel, onSelect, badge, badgeKind = 'plain', flying, voted, correct, children }: Props) {
  const playing = usePlayingKey() === clip.clipId
  const waveRef = useRef<HTMLSpanElement>(null)
  const progRef = useRef<HTMLSpanElement>(null)
  useLiveWave(playing, waveRef, progRef)
  const label = `Clip ${index + 1}`
  const classes = [
    'clip-card',
    selected && 'clip-card--selected',
    playing && 'clip-card--playing',
    flying && 'clip-card--fly',
    correct && 'clip-card--correct',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes} data-testid={`clip-${clip.clipId}`}>
      <button type="button" className="clip-card__tape" onClick={() => playClip(clip.clipUrl, clip.clipId)} aria-label={`Play ${label}`}>
        <span className="clip-card__label">
          <span>CLIP {String(index + 1).padStart(2, '0')}</span>
          <span className="clip-card__reels" aria-hidden="true">
            <span className="clip-card__reel" />
            <span className="clip-card__reel" />
          </span>
        </span>
        <span ref={waveRef} className="clip-card__wave" aria-hidden="true">
          {waveform(clip.clipId).map((h, i) => (
            <span key={i} className="clip-card__bar" style={{ height: `${h}%` }} />
          ))}
        </span>
        <span className="clip-card__foot" aria-hidden="true">
          <span ref={progRef} className="clip-card__prog" />
          <span className={playing ? 'icon-pause' : 'icon-play'} />
          <span className="clip-card__dur">2s</span>
        </span>
        {voted && (
          <span className="clip-card__stamp" aria-hidden="true">
            <span>VOTED</span>
          </span>
        )}
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

import { useEffect, useRef, useState } from 'react'
import type { RoleBanner, TourStep, TutorialCue as Cue } from '../tutorial'
import { PlayerName } from './Common'

export interface TourControls {
  step: TourStep
  onNext: () => void
  onSkip: () => void
}

/**
 * The tutorial slot of a screen: the tour explanation card while a section still needs explaining, then the compact
 * per-moment cue card. The tour highlights its section through the `data-tutorial` anchor on the page.
 */
export function TutorialCue({ cue, tour = null }: { cue: Cue | null; tour?: TourControls | null }) {
  if (tour) return <TourCard key={tour.step.section} {...tour} />
  if (!cue) return null
  return <TutorialCueInner key={cue.key} cue={cue} />
}

const HIGHLIGHT_CLASS = 'tutorial-target'

function TourCard({ step, onNext, onSkip }: TourControls) {
  const card = useRef<HTMLElement>(null)

  useEffect(() => {
    card.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onSkip])

  useEffect(() => {
    const target = document.querySelector<HTMLElement>(`[data-tutorial="${step.section}"]`)
    if (!target) return
    target.classList.add(HIGHLIGHT_CLASS)
    return () => target.classList.remove(HIGHLIGHT_CLASS)
  }, [step.section])

  return (
    <aside aria-label="Tour step">
      <section ref={card} tabIndex={-1} className="tutorial-card tutorial-card--tour" aria-labelledby="tour-label" data-testid="tour-step">
        <span id="tour-label" className="tutorial-card__label">
          TOUR · {step.label}
        </span>
        <p>{step.body}</p>
        <div className="tutorial-card__actions">
          <button type="button" className="btn btn--link tutorial-card__skip" onClick={onSkip}>
            Skip tour
          </button>
          <button type="button" className="btn btn--primary" onClick={onNext}>
            Next
          </button>
        </div>
      </section>
    </aside>
  )
}

function TutorialCueInner({ cue }: { cue: Cue }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <aside className="tutorial-card" aria-label="How to play cue">
      <p>{cue.body}</p>
      <button type="button" className="btn tutorial-card__dismiss" onClick={() => setDismissed(true)} aria-label="Got it">
        ✕
      </button>
    </aside>
  )
}

/** The compact strip that says who you are this round. `detailed` adds the second sentence (tutorial on). */
export function RoleStrip({ banner, detailed }: { banner: RoleBanner; detailed: boolean }) {
  return (
    <section className={`role-strip role-strip--${banner.role}`} aria-label="Your role" data-tutorial="role" data-testid="role-strip">
      <span className="role-strip__tag">{banner.role}</span>
      <p>
        <strong>{banner.headline.map((part, i) => (typeof part === 'string' ? part : <PlayerName key={i} player={part} />))}</strong>
        {detailed && <> {banner.detail}</>}
      </p>
    </section>
  )
}

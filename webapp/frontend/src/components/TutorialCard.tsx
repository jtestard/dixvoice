import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RoleBanner, TourStep, TutorialCue } from '../tutorial'
import { PlayerName } from './Common'

export interface TourControls {
  step: TourStep
  onNext: () => void
  onSkip: () => void
}

/**
 * Wraps a screen with the tutorial slot: the tour explanation card while a section still needs explaining, then the
 * per-moment cue card. The tour highlights its section through the `data-tutorial` anchor on the page.
 */
export function TutorialLayout({ cue, tour, children }: { cue: TutorialCue | null; tour: TourControls | null; children: ReactNode }) {
  return (
    <div className="tutorial-layout">
      {tour ? <TourAside key={tour.step.section} {...tour} /> : cue && <TutorialAside key={cue.key} cue={cue} />}
      <div className="tutorial-layout__content">{children}</div>
    </div>
  )
}

const HIGHLIGHT_CLASS = 'tutorial-target'

function TourAside({ step, onNext, onSkip }: TourControls) {
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
    <aside className="tutorial-layout__aside" aria-label="Tour step">
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

function TutorialAside({ cue }: { cue: TutorialCue }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <aside className="tutorial-layout__aside" aria-label="How to play cue">
      <div className="tutorial-card">
        <span className="tutorial-card__label">{cue.label}</span>
        <p>{cue.body}</p>
        <button type="button" className="btn btn--secondary tutorial-card__dismiss" onClick={() => setDismissed(true)}>
          Got it
        </button>
      </div>
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

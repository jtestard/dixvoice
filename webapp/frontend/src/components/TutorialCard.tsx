import { useState, type ReactNode } from 'react'
import type { TutorialCue } from '../tutorial'

export function TutorialLayout({
  cue,
  children,
}: {
  cue: TutorialCue | null
  children: ReactNode
}) {
  const [dismissed, setDismissed] = useState(false)
  const visibleCue = !dismissed && cue
  return (
    <div className={`tutorial-layout${visibleCue ? ' tutorial-layout--with-cue' : ''}`}>
      {visibleCue && (
        <aside className="tutorial-layout__aside" aria-label="How to play cue">
          <div className="tutorial-card">
            <span className="tutorial-card__label">{visibleCue.label}</span>
            <p>{visibleCue.body}</p>
            <button type="button" className="btn btn--secondary tutorial-card__dismiss" onClick={() => setDismissed(true)}>
              Got it
            </button>
          </div>
        </aside>
      )}
      <div className="tutorial-layout__content">{children}</div>
    </div>
  )
}

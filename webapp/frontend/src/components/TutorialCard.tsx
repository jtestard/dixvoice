import { useState, type ReactNode } from 'react'
import type { TutorialCue } from '../tutorial'

export function TutorialLayout({
  cue,
  children,
}: {
  cue: TutorialCue | null
  children: ReactNode
}) {
  return (
    <div className="tutorial-layout">
      {cue && <TutorialAside key={cue.key} cue={cue} />}
      <div className="tutorial-layout__content">{children}</div>
    </div>
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

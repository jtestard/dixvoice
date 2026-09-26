import { useState } from 'react'
import type { TutorialCue as Cue } from '../tutorial'

/** Compact cue card: one line of advice and a ✕. Remounts (and re-animates) when `cue.key` changes. */
export function TutorialCue({ cue }: { cue: Cue | null }) {
  if (!cue) return null
  return <TutorialCueInner key={cue.key} cue={cue} />
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

import { useId, useState } from 'react'
import type { CustomSlotState } from '../types'

/** Limits of an AudioRequest (spec/audio-request.schema.json). */
export const MAX_SOUND_TEXT = 100
export const MAX_SOUND_EMOTION = 30
/** About 2 seconds of speech (measured with the audio service); longer texts are sped up, then cut. */
const ADVISED_TEXT = 40

/** Emotions the audio service knows (webapp/audio/config/emotions.json); any other word works too. */
const EMOTION_SUGGESTIONS = [
  'joyful', 'excited', 'playful', 'laughing', 'surprised', 'curious', 'neutral', 'calm', 'sad', 'tired',
  'whisper', 'eerie', 'mysterious', 'menacing', 'scared', 'angry', 'furious', 'sarcastic', 'dramatic',
]

/** The 6th card of the hand while it holds no sound yet: create one, generating, or failed (retry). */
export function CustomSlotCard({ state, onOpen }: { state: CustomSlotState; onOpen: () => void }) {
  if (state === 'generating') {
    return (
      <div className="custom-slot custom-slot--busy" role="status" aria-live="polite">
        <span className="custom-slot__spinner" aria-hidden="true" />
        <span>Generating your sound…</span>
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <button type="button" className="custom-slot custom-slot--failed" onClick={onOpen}>
        <span className="custom-slot__icon" aria-hidden="true">!</span>
        <span>Generation failed</span>
        <span className="custom-slot__action">Try again</span>
      </button>
    )
  }
  return (
    <button type="button" className="custom-slot" onClick={onOpen}>
      <span className="custom-slot__icon" aria-hidden="true">+</span>
      <span>Create a sound</span>
    </button>
  )
}

export interface SoundDraft {
  text: string
  emotion: string
}

/** Form to generate your own sound: what is said, and how (the emotion). */
export function CreateSoundForm({ initial, onSubmit, onCancel }: { initial: SoundDraft; onSubmit: (draft: SoundDraft) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial.text)
  const [emotion, setEmotion] = useState(initial.emotion)
  const listId = useId()
  const hasDigits = /\d/.test(text)
  const ready = text.trim().length > 0 && emotion.trim().length > 0 && !hasDigits
  return (
    <form
      className="panel create-sound"
      aria-label="Create a sound"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit({ text: text.trim(), emotion: emotion.trim() })
      }}
    >
      <h3 className="create-sound__title">Create your sound</h3>
      <p className="create-sound__hint">
        A voice says your text with the emotion you choose, in 2 seconds at most: about {ADVISED_TEXT} characters fit.
      </p>
      <label className="field">
        <span>What is said</span>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_SOUND_TEXT} placeholder="Who ate my sandwich?" autoFocus />
      </label>
      <div className={`create-sound__count${text.length > ADVISED_TEXT ? ' create-sound__count--over' : ''}`} aria-live="polite">
        {text.length > ADVISED_TEXT ? `${text.length} characters: it will be spoken fast, or cut` : `${text.length} / ${ADVISED_TEXT}`}
      </div>
      {hasDigits && (
        <p className="create-sound__warn" role="alert">
          Write numbers in words (&quot;twelve&quot;, not &quot;12&quot;).
        </p>
      )}
      <label className="field">
        <span>How it is said (emotion)</span>
        <input value={emotion} onChange={(e) => setEmotion(e.target.value)} maxLength={MAX_SOUND_EMOTION} placeholder="angry" list={listId} />
      </label>
      <datalist id={listId}>
        {EMOTION_SUGGESTIONS.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      <div className="row">
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!ready}>
          Generate
        </button>
      </div>
    </form>
  )
}

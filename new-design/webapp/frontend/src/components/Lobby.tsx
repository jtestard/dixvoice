import { useState } from 'react'
import { setSfxEnabled, sfx, sfxEnabled } from '../sfx'
import type { TutorialCue as Cue } from '../tutorial'
import type { ClientMessage, GameState } from '../types'
import { QUICK_START_COMPANIONS, isQuickStartActive, type QuickStart } from '../useQuickStart'
import { AddCompanionButton, MAX_PLAYERS, NoticeLabel, PlayerList, StopButton } from './Common'
import { Table } from './Table'
import { TutorialCue } from './TutorialCard'

interface Props {
  state: GameState
  send: (msg: ClientMessage) => void
  quick?: QuickStart | null
  onDismissQuick?: () => void
  cue?: Cue | null
}

function quickStartText(quick: QuickStart): string {
  switch (quick.status) {
    case 'adding':
      return `Seating AI companions… ${quick.added}/${QUICK_START_COMPANIONS}`
    case 'failed':
      return quick.text
  }
}

export const MIN_PLAYERS = 4
export { MAX_PLAYERS }

export function Lobby({ state, send, quick = null, onDismissQuick, cue = null }: Props) {
  const [copied, setCopied] = useState(false)
  const [sound, setSound] = useState(sfxEnabled())
  const n = state.players.length
  const quickActive = isQuickStartActive(quick)
  const canStart = n >= MIN_PLAYERS && !quickActive

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.room.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const toggleSound = () => {
    const on = !sound
    setSfxEnabled(on)
    setSound(on)
    if (on) sfx('click')
  }

  return (
    <main className="screen board board--center">
      <div className="board__side">
        <Table state={state} seats={MAX_PLAYERS} centerLabel={n < MIN_PLAYERS ? `${n} of ${MIN_PLAYERS} seated` : 'ready to start'} />
      </div>

      <div className="board__main board__main--narrow">
        <div className="lobby-head">
          <h1 className="title">Lobby</h1>
          <button type="button" className="btn btn--secondary btn--small" onClick={toggleSound} aria-pressed={sound}>
            Sound: {sound ? 'on' : 'off'}
          </button>
        </div>

        <TutorialCue cue={cue} />

        <section className="room-code" aria-label="Room code">
          <div className="room-code__value" data-testid="room-code">
            {state.room.code.split('').map((ch, i) => (
              <span key={i} className="room-code__tile">
                {ch}
              </span>
            ))}
          </div>
          <button type="button" className="btn btn--secondary btn--small" onClick={copy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </section>

        <PlayerList players={state.players} youId={state.you.playerId} onRemoveCompanion={quickActive ? undefined : (playerId) => send({ type: 'remove_companion', playerId })} />

        {quick && quickActive && (
          <p className="quick-progress" role="status" aria-live="polite" data-testid="quick-progress">
            <span className="spinner" aria-hidden="true" />
            {quickStartText(quick)}
          </p>
        )}
        {quick?.status === 'failed' && (
          <div className="notice notice--error" role="alert" data-testid="quick-failed">
            <NoticeLabel kind="error" />
            <span className="notice__text">{quickStartText(quick)}</span>
            {onDismissQuick && (
              <button type="button" className="btn btn--link" onClick={onDismissQuick} aria-label="Dismiss quick start message">
                ✕
              </button>
            )}
          </div>
        )}

        <div className="actions">
          <button type="button" className={`btn btn--primary btn--block${canStart ? ' btn--armed' : ''}`} disabled={!canStart} onClick={() => send({ type: 'start_game' })}>
            {canStart || quickActive ? 'Start game' : `Start game (${n}/${MIN_PLAYERS} players)`}
          </button>
          <div className="row">
            <AddCompanionButton players={state.players} disabled={quickActive} onAdd={() => send({ type: 'add_companion' })} className="btn btn--secondary" />
            <button type="button" className="btn" onClick={() => send({ type: 'leave_room' })}>
              Leave
            </button>
            <StopButton onStop={() => send({ type: 'stop_game' })} />
          </div>
        </div>
      </div>
    </main>
  )
}

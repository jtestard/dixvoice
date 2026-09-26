import { useState } from 'react'
import type { ClientMessage, GameState } from '../types'
import { QUICK_START_COMPANIONS, isQuickStartActive, type QuickStart } from '../useQuickStart'
import { AddCompanionButton, MAX_PLAYERS, NoticeLabel, PlayerList, StopButton } from './Common'

interface Props {
  state: GameState
  send: (msg: ClientMessage) => void
  quick?: QuickStart | null
  onDismissQuick?: () => void
}

function quickStartText(quick: QuickStart): string {
  switch (quick.status) {
    case 'adding':
      return `Adding companions… ${quick.added}/${QUICK_START_COMPANIONS}`
    case 'starting':
      return 'Starting…'
    case 'failed':
      return quick.text
  }
}

export const MIN_PLAYERS = 4
export { MAX_PLAYERS }

export function Lobby({ state, send, quick = null, onDismissQuick }: Props) {
  const [copied, setCopied] = useState(false)
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

  return (
    <main className="screen screen--lobby">
      <h1 className="title">Lobby</h1>
      <section className="room-code" aria-label="Room code">
        <span className="label">Room code</span>
        <div className="room-code__value" data-testid="room-code">
          {state.room.code.split('').map((ch, i) => (
            <span key={i} className="room-code__tile">
              {ch}
            </span>
          ))}
        </div>
        <button type="button" className="btn btn--secondary" onClick={copy}>
          {copied ? 'Copied!' : 'Copy code'}
        </button>
      </section>

      <h2>
        Players ({n}/{MAX_PLAYERS})
      </h2>
      <div className="screen__body screen__body--scroll">
        <PlayerList players={state.players} youId={state.you.playerId} onRemoveCompanion={(playerId) => send({ type: 'remove_companion', playerId })} />
      </div>
      {quick && quickActive && (
        <p className="quick-progress" role="status" aria-live="polite" data-testid="quick-progress">
          <span className="spinner" aria-hidden="true" />
          Quick start: {quickStartText(quick)}
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
      {!quickActive && n < MIN_PLAYERS && <p className="muted">Waiting for at least {MIN_PLAYERS} players to start. Add AI companions to fill the seats.</p>}

      <div className="actions action-bar">
        <AddCompanionButton players={state.players} disabled={quickActive} onAdd={() => send({ type: 'add_companion' })} />
        <button type="button" className="btn btn--primary btn--block" disabled={!canStart} onClick={() => send({ type: 'start_game' })}>
          Start game
        </button>
        <div className="row">
          <button type="button" className="btn btn--secondary" onClick={() => send({ type: 'leave_room' })}>
            Leave
          </button>
          <StopButton onStop={() => send({ type: 'stop_game' })} />
        </div>
      </div>
    </main>
  )
}

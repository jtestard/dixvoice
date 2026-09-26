import { useState } from 'react'
import type { ClientMessage, GameState } from '../types'
import { PlayerList, StopButton } from './Common'

interface Props {
  state: GameState
  send: (msg: ClientMessage) => void
}

export const MIN_PLAYERS = 4
export const MAX_PLAYERS = 8

export function Lobby({ state, send }: Props) {
  const [copied, setCopied] = useState(false)
  const n = state.players.length
  const canStart = n >= MIN_PLAYERS

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
    <main className="screen">
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
      <PlayerList players={state.players} youId={state.you.playerId} />
      {!canStart && <p className="muted">Waiting for at least {MIN_PLAYERS} players to start.</p>}

      <div className="actions">
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

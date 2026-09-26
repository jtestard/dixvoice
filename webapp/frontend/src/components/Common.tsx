import { useState } from 'react'
import type { Player } from '../types'

export function BotBadge() {
  return (
    <span className="tag tag--bot" title="AI companion" data-testid="bot-badge">
      bot
    </span>
  )
}

export function PlayerName({ player }: { player: Player | undefined }) {
  if (!player) return null
  return (
    <>
      {player.nickname}
      {player.isCompanion && <BotBadge />}
    </>
  )
}

export const MAX_PLAYERS = 8

export function AddCompanionButton({ players, onAdd }: { players: Player[]; onAdd: () => void }) {
  if (players.length >= MAX_PLAYERS) return null
  return (
    <button type="button" className="btn btn--secondary btn--block" onClick={onAdd}>
      Add AI companion
    </button>
  )
}

interface PlayerListProps {
  players: Player[]
  youId: string
  waitingOn?: (p: Player) => boolean
  onRemoveCompanion?: (playerId: string) => void
}

export function PlayerList({ players, youId, waitingOn, onRemoveCompanion }: PlayerListProps) {
  return (
    <ul className="player-list">
      {players.map((p) => {
        const waiting = waitingOn ? waitingOn(p) : false
        return (
          <li key={p.playerId} className={`player${p.connected ? '' : ' player--offline'}`}>
            <span className="player__name">
              <PlayerName player={p} />
              {p.playerId === youId && <span className="muted"> (you)</span>}
              {p.isStoryteller && <span className="tag">storyteller</span>}
            </span>
            {waitingOn && (
              <span className={`player__status ${waiting ? 'player__status--waiting' : 'player__status--done'}`}>
                {waiting ? 'waiting…' : 'done'}
              </span>
            )}
            {!p.connected && <span className="tag tag--offline">offline</span>}
            {onRemoveCompanion && p.isCompanion && (
              <button type="button" className="btn btn--secondary btn--small" onClick={() => onRemoveCompanion(p.playerId)} aria-label={`Remove ${p.nickname}`}>
                Remove
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function Scoreboard({ players, youId, winnerIds = [], targetScore }: { players: Player[]; youId: string; winnerIds?: string[]; targetScore?: number }) {
  const sorted = [...players].sort((a, b) => b.score - a.score)
  return (
    <table className="scoreboard">
      <thead>
        <tr>
          <th>Player</th>
          <th className="num">Score{targetScore ? ` / ${targetScore}` : ''}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={p.playerId} className={winnerIds.includes(p.playerId) ? 'winner' : ''}>
            <td>
              <PlayerName player={p} />
              {p.playerId === youId && <span className="muted"> (you)</span>}
              {winnerIds.includes(p.playerId) && <span className="tag tag--winner">winner</span>}
            </td>
            <td className="num">{p.score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function StopButton({ onStop, label = 'Stop' }: { onStop: () => void; label?: string }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
        {label}
      </button>
    )
  }
  return (
    <div className="confirm" role="alertdialog" aria-label="Confirm stop">
      <p>Stop the game and close the room for everyone?</p>
      <div className="row">
        <button type="button" className="btn btn--secondary" onClick={() => setConfirming(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onStop}>
          Yes, stop
        </button>
      </div>
    </div>
  )
}

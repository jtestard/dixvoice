import { useState } from 'react'
import { MAX_PLAYERS } from '../table'
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

export { MAX_PLAYERS }

export function AddCompanionButton({ players, onAdd, disabled = false }: { players: Player[]; onAdd: () => void; disabled?: boolean }) {
  if (players.length >= MAX_PLAYERS) return null
  return (
    <button type="button" className="btn btn--secondary btn--block" disabled={disabled} onClick={onAdd}>
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
          <li key={p.playerId} className={`player${p.connected ? '' : ' player--offline'}${p.playerId === youId ? ' player--you' : ''}`}>
            <span className="player__name">
              <PlayerName player={p} />
              {p.playerId === youId && <span className="muted"> (you)</span>}
            </span>
            <span className="player__tags">
              {p.isStoryteller && <span className="tag tag--accent">storyteller</span>}
              {!p.connected && <span className="tag tag--offline">offline</span>}
              {waitingOn && <span className={`tag ${waiting ? 'tag--waiting' : 'tag--done'}`}>{waiting ? 'waiting…' : 'done'}</span>}
              {onRemoveCompanion && p.isCompanion && (
                <button type="button" className="btn btn--secondary btn--small" onClick={() => onRemoveCompanion(p.playerId)} aria-label={`Remove ${p.nickname}`}>
                  Remove
                </button>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function ScoreTrack({ score, target }: { score: number; target: number }) {
  return (
    <span className="score-track" role="img" aria-label={`${score} of ${target} points`}>
      {Array.from({ length: target }, (_, i) => (
        <span key={i} className={`score-track__pip${i < score ? ' score-track__pip--on' : ''}`} />
      ))}
    </span>
  )
}

export function Scoreboard({ players, youId, winnerIds = [], targetScore }: { players: Player[]; youId: string; winnerIds?: string[]; targetScore?: number }) {
  const sorted = [...players].sort((a, b) => b.score - a.score)
  const target = targetScore || 10
  return (
    <table className="scoreboard">
      <thead>
        <tr>
          <th>Player</th>
          <th className="scoreboard__target">First to {target}</th>
          <th className="num">Score</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => {
          const classes = [winnerIds.includes(p.playerId) && 'winner', p.playerId === youId && 'you'].filter(Boolean).join(' ')
          return (
            <tr key={p.playerId} className={classes || undefined}>
              <td className="scoreboard__player">
                <span className="scoreboard__name">
                  <PlayerName player={p} />
                  {p.playerId === youId && <span className="muted"> (you)</span>}
                  {winnerIds.includes(p.playerId) && <span className="tag tag--accent">winner</span>}
                </span>
              </td>
              <td className="scoreboard__track">
                <ScoreTrack score={p.score} target={target} />
              </td>
              <td className="num scoreboard__score">{p.score}</td>
            </tr>
          )
        })}
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
        <button type="button" className="btn btn--danger-fill" onClick={onStop}>
          Yes, stop
        </button>
      </div>
    </div>
  )
}

export function NoticeLabel({ kind }: { kind: 'error' | 'info' | 'warning' }) {
  return <span className="notice__label">{kind}</span>
}

import { useMemo, useState } from 'react'
import type { Phase, Player } from '../types'

export const MAX_PLAYERS = 8

/** One colour per seat, in join order. Same order as --player-1..8 in index.css. */
export const PLAYER_COLORS = ['#e85a3c', '#1f6f6a', '#e3b341', '#7b4b94', '#5b9bd5', '#7a8f3c', '#d9779a', '#8c6a4a']

export function playerColor(players: Player[], playerId: string): string {
  const i = players.findIndex((p) => p.playerId === playerId)
  return PLAYER_COLORS[Math.max(0, i) % PLAYER_COLORS.length]
}

/** One avatar design for everyone (humans and companions): a person on a coloured disc. */
export function Avatar({ color, size = 'default', empty = false }: { color?: string; size?: 'default' | 'dot' | 'tiny'; empty?: boolean }) {
  const cls = `avatar${size === 'dot' ? ' avatar--dot' : size === 'tiny' ? ' avatar--tiny' : ''}${empty ? ' avatar--empty' : ''}`
  return (
    <span className={cls} style={empty ? undefined : { background: color }} aria-hidden="true">
      {!empty && size === 'default' && (
        <span className="avatar__clip">
          <span className="avatar__head" />
          <span className="avatar__body" />
        </span>
      )}
    </span>
  )
}

export function BotBadge() {
  return (
    <span className="tag tag--bot" title="AI companion" data-testid="bot-badge">
      bot
    </span>
  )
}

export function PlayerName({ player }: { player: Player | undefined }) {
  if (!player) return null
  return <>{player.nickname}</>
}

export function AddCompanionButton({ players, onAdd, disabled = false, className = 'btn btn--secondary btn--block' }: { players: Player[]; onAdd: () => void; disabled?: boolean; className?: string }) {
  if (players.length >= MAX_PLAYERS) return null
  return (
    <button type="button" className={className} disabled={disabled} onClick={onAdd}>
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
              <Avatar color={playerColor(players, p.playerId)} size="dot" />
              <span>
                <PlayerName player={p} />
                {p.playerId === youId && <span className="muted"> (you)</span>}
              </span>
            </span>
            <span className="player__tags">
              {!p.connected && <span className="tag tag--offline">offline</span>}
              {waitingOn && <span className={`tag ${waiting ? 'tag--waiting' : 'tag--done'}`}>{waiting ? 'waiting…' : 'done'}</span>}
              {onRemoveCompanion && p.isCompanion && (
                <button type="button" className="btn btn--small" onClick={() => onRemoveCompanion(p.playerId)} aria-label={`Remove ${p.nickname}`}>
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

/** Pips gained this round pop one by one (delays aligned with the `tick` sounds). */
export function ScoreTrack({ score, target, gained = 0 }: { score: number; target: number; gained?: number }) {
  return (
    <span className="score-track" role="img" aria-label={`${score} of ${target} points`}>
      {Array.from({ length: target }, (_, i) => {
        const on = i < score
        const fresh = on && i >= score - gained
        return (
          <span
            key={i}
            className={`score-track__pip${on ? ' score-track__pip--on' : ''}${fresh ? ' score-track__pip--new' : ''}`}
            style={fresh ? { animationDelay: `${1100 + (i - (score - gained)) * 90}ms` } : undefined}
          />
        )
      })}
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
                  <Avatar color={playerColor(players, p.playerId)} size="dot" />
                  <span>
                    <PlayerName player={p} />
                    {p.playerId === youId && <span className="muted"> (you)</span>}
                  </span>
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

const STEP: Record<Phase, number> = { storyteller: 1, submit: 2, vote: 3, reveal: 4 }

/** Optional: not used by default (the header only shows Room · Round). */
export function StepCounter({ phase, title }: { phase: Phase; title: string }) {
  const n = STEP[phase]
  return (
    <span className="label">
      STEP {n}/4 · {title}
    </span>
  )
}

/** 2nd · 1st · 3rd; bars rise 3-2-1, names pop afterwards. */
export function Podium({ players, youId }: { players: Player[]; youId: string }) {
  const sorted = [...players].sort((a, b) => b.score - a.score)
  const spec: Array<[number, string, number]> = [
    [1, '62%', 150],
    [0, '100%', 320],
    [2, '46%', 0],
  ]
  return (
    <div className="podium" aria-label="Podium">
      {spec
        .filter(([k]) => sorted[k])
        .map(([k, height, delay]) => {
          const p = sorted[k]
          return (
            <div key={p.playerId} className="podium__col">
              <div className="podium__name" style={{ animationDelay: `${delay + 420}ms` }}>
                <div>
                  <PlayerName player={p} />
                  {p.playerId === youId && <span className="muted"> (you)</span>}
                </div>
                <div className="label">{p.score} pts</div>
              </div>
              <div className="podium__bar" style={{ height, animationDelay: `${delay}ms`, background: playerColor(players, p.playerId) }}>
                {k + 1}
              </div>
            </div>
          )
        })}
    </div>
  )
}

const CONFETTI = ['var(--color-accent)', 'var(--color-success)', 'var(--color-secondary)', 'var(--color-surface)', 'var(--color-text)']

export function Confetti({ count = 44 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        left: `${Math.random() * 100}%`,
        width: 8 + Math.random() * 8,
        height: 10 + Math.random() * 12,
        background: CONFETTI[i % CONFETTI.length],
        animationDuration: `${2600 + Math.random() * 1800}ms`,
        animationDelay: `${Math.random() * 1400}ms`,
      })),
    [count],
  )
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((s, i) => (
        <span key={i} style={s} />
      ))}
    </div>
  )
}

export function StopButton({ onStop, label = 'Stop', className = 'btn btn--danger' }: { onStop: () => void; label?: string; className?: string }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button type="button" className={className} onClick={() => setConfirming(true)}>
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

import type { CSSProperties } from 'react'
import type { GameState, Player } from '../types'
import { Avatar, playerColor } from './Common'

const TILT = [-2.5, 1.5, -1, 2, 1, -2]

interface Props {
  state: GameState
  /** Fixed number of seats (lobby shows all 8, empty ones dashed). Defaults to the number of players. */
  seats?: number
  /** Lobby: text shown in the middle of the table. */
  centerLabel?: string
  className?: string
}

/**
 * The table seen from above. You always sit at the bottom, the others clockwise. One mini card per
 * player travels: seat (hidden) → in front of the player (face down) → pile in the middle (vote)
 * → revealed row in the owner's colour, the storyteller's ringed in Teal.
 */
export function Table({ state, seats, centerLabel, className }: Props) {
  const { round: r, players, you } = state
  const idx = players.findIndex((p) => p.playerId === you.playerId)
  const order = idx >= 0 ? [...players.slice(idx), ...players.slice(0, idx)] : players
  const N = Math.max(seats ?? players.length, 1)
  const pos = (i: number, rx: number, ry: number) => {
    const a = (Math.PI / 180) * (90 + (i * 360) / N)
    // round: sin(2π) is -2e-16, which would flip the right-hand seat
    return { x: Math.round((50 + rx * Math.cos(a)) * 100) / 100, y: Math.round((50 + ry * Math.sin(a)) * 100) / 100 }
  }
  const submitted = order.filter((p) => p.hasSubmitted)
  const revealOrder = r?.reveal?.results.map((x) => x.ownerId) ?? null
  const spacing = Math.min(11, 60 / Math.max(1, players.length))
  const phase = r?.phase

  return (
    <section className={`table${className ? ` ${className}` : ''}`} aria-label="Table">
      <div className="table__rim" aria-hidden="true" />
      <div className="table__felt" aria-hidden="true" />
      {centerLabel && (
        <div className="table__center" aria-hidden="true">
          {centerLabel}
        </div>
      )}
      {r &&
        order.map((p, i) => {
          const sp = pos(i, 43, 43)
          const has = phase !== 'storyteller' && p.hasSubmitted
          let x = sp.x
          let y = sp.y
          let rot = 0
          let cls = 'table__card'
          const style: CSSProperties = {}
          if (has && phase === 'submit') {
            x = 50 + (sp.x - 50) * 0.5
            y = 50 + (sp.y - 50) * 0.5
            rot = TILT[i % 6] * 2
          } else if (has && phase === 'vote') {
            const k = submitted.indexOf(p)
            x = 50 + (k - (submitted.length - 1) / 2) * 1.5
            y = 50
            rot = -10 + (k * 20) / Math.max(1, submitted.length - 1)
          } else if (has && phase === 'reveal' && revealOrder) {
            const k = revealOrder.indexOf(p.playerId)
            x = 50 + (k - (revealOrder.length - 1) / 2) * spacing
            y = 50
            style.background = playerColor(players, p.playerId)
            if (p.isStoryteller) cls += ' table__card--correct'
          }
          return (
            <div
              key={p.playerId}
              className={`${cls}${has ? ' table__card--down' : ''}`}
              style={{ ...style, left: `${x}%`, top: `${y}%`, transform: `translate(-50%,-50%) rotate(${rot}deg)` }}
              aria-hidden="true"
            />
          )
        })}
      {Array.from({ length: N }, (_, i) => {
        const p: Player | undefined = order[i]
        const sp = pos(i, 43, 43)
        const isYou = p?.playerId === you.playerId
        const done = p && !p.isStoryteller && (phase === 'submit' ? p.hasSubmitted : phase === 'vote' ? p.hasVoted : false)
        const pts = phase === 'reveal' && p ? (r?.reveal?.points[p.playerId] ?? 0) : undefined
        return (
          <div key={p?.playerId ?? `empty-${i}`} className="seat" style={{ left: `${sp.x}%`, top: `${sp.y}%`, animationDelay: `${i * 60}ms` }}>
            <span className={`seat__avatar${done && phase !== 'reveal' ? ' seat__avatar--nod' : ''}`}>
              {p ? <Avatar color={playerColor(players, p.playerId)} /> : <Avatar empty />}
              {p?.isStoryteller && r && (
                <span className="seat__tape" title="Storyteller">
                  <i />
                  <i />
                </span>
              )}
              {phase === 'vote' && p && !p.isStoryteller && p.hasVoted && (
                <span className="seat__check" title="Voted">
                  ✓
                </span>
              )}
              {pts !== undefined && (
                <span className={`seat__points${pts > 0 ? ' seat__points--win' : ''}`} style={{ animationDelay: `${900 + i * 80}ms` }}>
                  +{pts}
                </span>
              )}
            </span>
            {p && <span className={`seat__name${p.isStoryteller && r ? ' seat__name--storyteller' : ''}`}>{isYou ? 'you' : p.nickname}</span>}
            {phase === 'storyteller' && p?.isStoryteller && (
              <span className={`seat__bubble${sp.y < 49.5 ? ' seat__bubble--below' : ''}`}>
                {isYou ? 'your turn' : 'writing a clue'}
                <span className="dots">…</span>
              </span>
            )}
          </div>
        )
      })}
    </section>
  )
}

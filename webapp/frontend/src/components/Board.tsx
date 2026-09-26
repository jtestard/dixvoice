import { boardSlots, pawnLooks, railOrder, seatStatus, trackCells, type PawnLook } from '../board'
import type { GameState, Player } from '../types'
import { ClipCard, FaceDownCard } from './ClipCard'
import { PlayerName } from './Common'

interface Props {
  state: GameState
  /** Set while you can vote: makes the face-up clips on the board votable. */
  onVote?: (clipId: string) => void
}

export function Pawn({ look, size = 'md' }: { look: PawnLook | undefined; size?: 'sm' | 'md' }) {
  if (!look) return null
  return (
    <span className={`pawn pawn--c${look.color} pawn--s${look.shape} pawn--${size}`} aria-hidden="true">
      {size === 'md' && look.initial}
    </span>
  )
}

function MicToken() {
  return (
    <span className="mic-token" title="Storyteller" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14">
        <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
        <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  )
}

/**
 * The Dixit-style board, always on screen during a round: the 0-10 score track with every
 * player's pawn, the felt play area with one numbered slot per player, and the rail of
 * players with the storyteller's microphone token.
 */
export function Board({ state, onVote }: Props) {
  const round = state.round
  const you = state.you.playerId
  const looks = pawnLooks(state.players)
  const target = state.room.targetScore || 10
  const storyteller = state.players.find((p) => p.isStoryteller)
  const youTell = storyteller?.playerId === you
  const slots = boardSlots(state)
  const n = slots.length
  const byId = new Map(state.players.map((p) => [p.playerId, p]))

  const nameOf = (id: string) => (id === you ? 'You' : (byId.get(id)?.nickname ?? id))
  const owner = (id: string) => (
    <span className="board-who">
      <Pawn look={looks.get(id)} size="sm" />
      <strong>{id === you ? 'You' : <PlayerName player={byId.get(id)} />}</strong>
    </span>
  )
  // Voters are shown as their pawns placed on the card, like Dixit's voting tokens.
  const voter = (id: string) => (
    <span key={id} className="board-vote" title={nameOf(id)}>
      <Pawn look={looks.get(id)} />
      <span className="visually-hidden">{nameOf(id)}</span>
    </span>
  )

  let clueText: React.ReactNode
  if (round?.clue) clueText = round.clue
  else if (youTell) clueText = <em className="board__pending">You're choosing a clip and a clue…</em>
  else clueText = <em className="board__pending">{storyteller?.nickname ?? 'The storyteller'} is choosing a clip and a clue…</em>

  const trackLabel = state.players.map((p) => `${p.playerId === you ? 'You' : p.nickname} ${p.score}`).join(', ')

  return (
    <section className="board" aria-label="Board" data-tutorial="table">
      <div className="board__track" role="img" aria-label={`Score track, first to ${target}: ${trackLabel}`}>
        {trackCells(state.players, target).map((cell, score) => (
          <span key={score} className={`board__cell${score === target ? ' board__cell--goal' : ''}`} aria-hidden="true">
            <span className="board__cell-num">{score}</span>
            <span className="board__cell-pawns">
              {cell.map((p) => (
                <Pawn key={p.playerId} look={looks.get(p.playerId)} size="sm" />
              ))}
            </span>
          </span>
        ))}
      </div>

      <div className="board__felt">
        <div className="board__clue">
          <span className="board__clue-label">{youTell ? 'Your clue' : 'Clue'}</span>
          <div className="board__clue-text">{clueText}</div>
        </div>
        <div
          className="board__slots"
          style={{ '--cols-sm': Math.min(n, 4), '--cols-lg': Math.min(n, 8) } as React.CSSProperties}
          aria-label={`${slots.filter((s) => s.kind !== 'empty').length} of ${n} clips on the board`}
        >
          {slots.map((slot, i) => {
            if (slot.kind === 'empty')
              return (
                <span key={`e${i}`} className="board__slot" aria-hidden="true">
                  {i + 1}
                </span>
              )
            if (slot.kind === 'facedown') return <FaceDownCard key={`f${i}`} />
            if (slot.kind === 'clip') {
              const own = slot.clip.clipId === round?.yourSubmission
              return (
                <ClipCard
                  key={slot.clip.clipId}
                  clip={slot.clip}
                  index={i}
                  selected={round?.yourVote === slot.clip.clipId}
                  badge={own ? 'yours' : undefined}
                  onSelect={onVote && !own ? onVote : undefined}
                  actionLabel="Vote"
                />
              )
            }
            const r = slot.result
            return (
              <ClipCard key={r.clipId} clip={slot.clip} index={i} selected={r.isStoryteller}>
                {r.isStoryteller && (
                  <span className="board-card-mic">
                    <MicToken />
                    <span className="visually-hidden">storyteller</span>
                  </span>
                )}
                <div className="reveal-info">
                  <div>
                    <span className="label">Owner </span>
                    {owner(r.ownerId)}
                  </div>
                  <div>
                    <span className="label">Votes </span>
                    {r.voterIds.length ? <span className="board-voters">{r.voterIds.map(voter)}</span> : 'none'}
                  </div>
                </div>
              </ClipCard>
            )
          })}
        </div>
      </div>

      <ul className="board__rail" aria-label="Players" data-tutorial="seats">
        {railOrder(state.players, you).map((p) => (
          <Seat key={p.playerId} state={state} player={p} look={looks.get(p.playerId)} isYou={p.playerId === you} />
        ))}
      </ul>
    </section>
  )
}

function Seat({ state, player, look, isYou }: { state: GameState; player: Player; look: PawnLook | undefined; isYou: boolean }) {
  const status = seatStatus(state, player)
  const points = state.round?.phase === 'reveal' ? state.round.reveal?.points[player.playerId] : undefined
  const classes = ['seat', isYou && 'seat--you', status === 'storyteller' && 'seat--storyteller', !player.connected && 'seat--offline']
  return (
    <li className={classes.filter(Boolean).join(' ')} data-tutorial={status === 'storyteller' ? 'storyteller' : undefined}>
      <span className="seat__pawn">
        <Pawn look={look} />
        {status === 'storyteller' && <MicToken />}
      </span>
      <span className="seat__body">
        <span className="seat__name">
          {isYou ? 'You' : <PlayerName player={player} />}
        </span>
        <span className="seat__status">
          {status === 'storyteller' && (
<span className="tag tag--accent">storyteller</span>
          )}
          {status === 'done' && <span className="tag tag--done">done</span>}
          {status === 'waiting' && <span className="tag tag--waiting">waiting…</span>}
          {!player.connected && <span className="tag tag--offline">offline</span>}
          {points !== undefined && <span className="seat__points num">+{points}</span>}
        </span>
      </span>
    </li>
  )
}

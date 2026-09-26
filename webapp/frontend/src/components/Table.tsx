import type { CSSProperties, ReactNode } from 'react'
import type { AvatarSpec } from '../avatar'
import type { RevealCard, Seat, TableCentre, TableView, VoteCard } from '../table'
import type { Player } from '../types'
import { Avatar, StorytellerToken } from './Avatar'
import { ClipCard, FaceDownCard } from './ClipCard'

interface Props {
  view: TableView
  onVote?: (clipId: string) => void
  onRemoveCompanion?: (playerId: string) => void
  /** Extra content for the lobby table centre. */
  lobby?: ReactNode
}

type Vars = CSSProperties & Record<`--${string}`, string | number>

/** Grid columns for `n` cards in the table centre, on phones and on wide screens. */
function cardColumns(n: number): Vars {
  const sm = n <= 2 ? n : n <= 4 ? 2 : 3
  const lg = n <= 4 ? n : Math.ceil(n / 2)
  return { '--cols-sm': Math.max(1, sm), '--cols-lg': Math.max(1, lg), '--cols-tall': Math.max(1, Math.min(n, 2)) }
}

const seatVars = (s: Seat): Vars => ({
  '--x': `${s.seat.x}%`,
  '--y': `${s.seat.y}%`,
  '--dx': s.facing.x,
  '--dy': s.facing.y,
  '--tx': `${s.tall.seat.x}%`,
  '--ty': `${s.tall.seat.y}%`,
  '--tdx': s.tall.facing.x,
  '--tdy': s.tall.facing.y,
})

const displayName = (p: Player, youId: string | null) => (p.playerId === youId ? 'You' : p.nickname)

/** The game table: seats around a kraft board, and whatever is on it right now. Rendered from `tableView(state)`. */
export function GameTable({ view, onVote, onRemoveCompanion, lobby }: Props) {
  const you = view.seats.find((s) => s.isYou)?.player?.playerId ?? null
  const avatars = new Map(view.seats.flatMap((s) => (s.player && s.avatar ? [[s.player.playerId, s.avatar] as const] : [])))
  return (
    <section
      className={`board board--${view.phase} board--${view.centre.kind}${view.seats.length > 5 ? ' board--crowded' : ''}`}
      aria-label="Table"
      data-tutorial="table"
      data-testid="table"
      style={{ '--seats': view.seats.length } as Vars}
    >
      <div className="board__felt">
        {view.seats.map((s) =>
          s.inFront ? (
            <span
              key={s.key}
              className={`board__spot board__spot--${s.inFront}`}
              style={seatVars(s)}
              data-testid={`spot-${s.key}`}
            >
              {s.inFront === 'facedown' ? (
                <FaceDownCard label={s.isYou ? 'Your face-down clip' : `${s.player?.nickname}'s face-down clip`} />
              ) : (
                <span className="spot-waiting" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </span>
          ) : null,
        )}
        <div className="board__centre" data-testid="table-centre">
          <Centre centre={view.centre} youId={you} avatars={avatars} onVote={onVote} lobby={lobby} />
        </div>
      </div>
      <ol className="board__seats" data-tutorial="seats" aria-label="Seats">
        {view.seats.map((s) => (
          <SeatView key={s.key} seat={s} onRemoveCompanion={onRemoveCompanion} />
        ))}
      </ol>
    </section>
  )
}

function seatTag(seat: Seat): { text: string; kind: string } | null {
  const p = seat.player
  if (!p) return null
  if (seat.isStoryteller) return { text: 'storyteller', kind: 'accent' }
  if (!p.connected) return { text: 'offline', kind: 'offline' }
  if (seat.status === 'done') return { text: 'done', kind: 'done' }
  if (seat.status === 'waiting') return { text: 'waiting…', kind: 'waiting' }
  return null
}

function SeatView({ seat, onRemoveCompanion }: { seat: Seat; onRemoveCompanion?: (playerId: string) => void }) {
  const p = seat.player
  const tag = seatTag(seat)
  const classes = [
    'seat',
    !p && 'seat--open',
    seat.isYou && 'seat--you',
    seat.isStoryteller && 'seat--storyteller',
    p && !p.connected && 'seat--offline',
  ]
    .filter(Boolean)
    .join(' ')
  const style: Vars = {
    ...seatVars(seat),
    '--from-x': `${50 - seat.seat.x}cqw`,
    '--from-y': `${50 - seat.seat.y}cqh`,
  }
  return (
    <li className={classes} style={style} data-testid={`seat-${seat.key}`}>
      <span className="seat__plate">
        <span className="seat__icon">
          {seat.avatar ? <Avatar spec={seat.avatar} /> : <span className="avatar avatar--open" aria-hidden="true" />}
          {seat.isStoryteller && <StorytellerToken />}
          {seat.vote && (
            <span className={`vote-token vote-token--${seat.vote}`} title={seat.vote === 'placed' ? 'Voted' : 'Not voted yet'}>
              <span className="sr-only">{seat.vote === 'placed' ? 'voted' : 'not voted yet'}</span>
            </span>
          )}
          {p && (
            <span className="seat__score" title="Score">
              {p.score}
              <span className="sr-only"> points</span>
            </span>
          )}
        </span>
        <span className="seat__name">
          {seat.isYou ? 'You' : (p?.nickname ?? 'Open seat')}
          {seat.isYou && p && <span className="sr-only"> ({p.nickname})</span>}
        </span>
        {tag && <span className={`seat__tag seat__tag--${tag.kind}`}>{tag.text}</span>}
      </span>
      {seat.pointsWon !== null && (
        <span className={`seat__points${seat.pointsWon > 0 ? '' : ' seat__points--zero'}`} data-testid={`points-${seat.key}`}>
          +{seat.pointsWon}
        </span>
      )}
      {onRemoveCompanion && p?.isCompanion && (
        <button type="button" className="seat__remove" onClick={() => onRemoveCompanion(p.playerId)} aria-label={`Remove ${p.nickname}`}>
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </li>
  )
}

interface CentreProps {
  centre: TableCentre
  youId: string | null
  avatars: Map<string, AvatarSpec>
  onVote?: (clipId: string) => void
  lobby?: ReactNode
}

function Centre({ centre, youId, avatars, onVote, lobby }: CentreProps) {
  switch (centre.kind) {
    case 'lobby':
      return <div className="board__lobby">{lobby}</div>
    case 'choosing':
      return (
        <div className="table-clue table-clue--placeholder" data-testid="clue-slot">
          <span className="table-clue__label">{centre.youAreStoryteller ? 'Your turn' : 'Clue'}</span>
          <p className="table-clue__text">
            {centre.youAreStoryteller ? "You're telling the story" : `${centre.storyteller?.nickname ?? 'The storyteller'} is choosing a clip…`}
          </p>
        </div>
      )
    case 'clue':
    case 'vote':
    case 'reveal':
      return (
        <>
          <TableClue clue={centre.clue} storyteller={centre.storyteller} youAreStoryteller={centre.youAreStoryteller} compact={centre.kind !== 'clue'} />
          {centre.kind === 'vote' && <VoteCards cards={centre.cards} onVote={onVote} />}
          {centre.kind === 'reveal' && <RevealCards cards={centre.cards} youId={youId} avatars={avatars} />}
        </>
      )
  }
}

function TableClue({ clue, storyteller, youAreStoryteller, compact }: { clue: string; storyteller: Player | null; youAreStoryteller: boolean; compact: boolean }) {
  return (
    <blockquote className={`table-clue${compact ? ' table-clue--compact' : ''}`}>
      <span className="table-clue__label">{youAreStoryteller ? 'Your clue' : `${storyteller?.nickname ?? 'Storyteller'}'s clue`}</span>
      <span className="table-clue__text">{clue}</span>
    </blockquote>
  )
}

function VoteCards({ cards, onVote }: { cards: VoteCard[]; onVote?: (clipId: string) => void }) {
  return (
    <div className="board__cards board__cards--vote" style={cardColumns(cards.length)}>
      {cards.map((c, i) => (
        <div key={c.clip.clipId} className="board__cell">
          <ClipCard
            clip={c.clip}
            index={i}
            selected={c.isYourVote}
            badge={c.isYours ? 'yours' : undefined}
            onSelect={c.canVote && onVote ? onVote : undefined}
            actionLabel="Vote"
          />
        </div>
      ))}
    </div>
  )
}

function RevealCards({ cards, youId, avatars }: { cards: RevealCard[]; youId: string | null; avatars: CentreProps['avatars'] }) {
  return (
    <div className="board__cards board__cards--reveal" style={cardColumns(cards.length)}>
      {cards.map((c, i) => {
        const ownerAvatar = c.owner ? avatars.get(c.owner.playerId) : undefined
        return (
          <div key={c.clip.clipId} className="board__cell">
            <ClipCard clip={c.clip} index={i} selected={c.isStoryteller} badge={c.isStoryteller ? 'storyteller' : undefined} badgeKind="accent">
              <div className="reveal-chip">
                <span className="reveal-chip__owner">
                  {ownerAvatar && <Avatar spec={ownerAvatar} small />}
                  <span className="reveal-chip__name">{c.owner ? displayName(c.owner, youId) : '?'}</span>
                </span>
                <span className="vote-stack" aria-label={`Votes: ${c.voters.length}`}>
                  {c.voters.length ? (
                    c.voters.map((v) => {
                      const a = avatars.get(v.playerId)
                      return (
                        <span key={v.playerId} className="vote-stack__token" title={displayName(v, youId)}>
                          {a && <Avatar spec={a} small />}
                          <span className="sr-only">{v.nickname}</span>
                        </span>
                      )
                    })
                  ) : (
                    <span className="vote-stack__none">none</span>
                  )}
                </span>
              </div>
            </ClipCard>
          </div>
        )
      })}
    </div>
  )
}

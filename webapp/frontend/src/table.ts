import { assignAvatars, type AvatarSpec } from './avatar'
import type { Clip, GameState, Phase, Player } from './types'

export const MIN_PLAYERS = 4
export const MAX_PLAYERS = 8

export type TablePhase = 'lobby' | Phase

/** A position on the table, in % of the table box (0,0 top left, 50,50 the centre). */
export interface Point {
  x: number
  y: number
}

export interface Seat {
  key: string
  /** `null` for an open seat in the lobby. */
  player: Player | null
  avatar: AvatarSpec | null
  isYou: boolean
  isStoryteller: boolean
  /** Where the seat sits, on the edge of the table. */
  seat: Point
  /** The way the seat faces, towards the table centre (a unit step on one axis): what is in front of it goes there. */
  facing: Point
  /** The same on a portrait (`tall`) table: the component picks one from the table's aspect ratio. */
  tall: { seat: Point; facing: Point }
  /** Round progress shown on the seat: `done` / `waiting` for the players the round is waiting on. */
  status: 'done' | 'waiting' | null
  /** What is on the table in front of the seat. */
  inFront: 'facedown' | 'waiting' | null
  /** Vote phase: whether this player's vote token is placed (never on what). */
  vote: 'placed' | 'waiting' | null
  /** Reveal: points won this round. */
  pointsWon: number | null
}

export interface VoteCard {
  clip: Clip
  isYours: boolean
  isYourVote: boolean
  canVote: boolean
}

export interface RevealCard {
  clip: Clip
  owner: Player | null
  isStoryteller: boolean
  isYours: boolean
  voters: Player[]
}

interface ClueBase {
  storyteller: Player | null
  youAreStoryteller: boolean
}

export type TableCentre =
  | { kind: 'lobby'; seated: number; min: number; max: number }
  | ({ kind: 'choosing' } & ClueBase)
  | ({ kind: 'clue'; clue: string } & ClueBase)
  | ({ kind: 'vote'; clue: string; cards: VoteCard[] } & ClueBase)
  | ({ kind: 'reveal'; clue: string; cards: RevealCard[] } & ClueBase)

export interface TableView {
  phase: TablePhase
  seats: Seat[]
  centre: TableCentre
}

export interface TableOptions {
  /** You are the storyteller and have picked a clip locally (not sent yet). */
  storytellerPicked?: boolean
}

/** Players in join order, rotated so you come first; the others follow you around the table. */
export function seatOrder<T extends { playerId: string }>(players: T[], youId: string): T[] {
  const i = players.findIndex((p) => p.playerId === youId)
  return i <= 0 ? [...players] : [...players.slice(i), ...players.slice(0, i)]
}

const round2 = (v: number) => Math.round(v * 100) / 100 + 0

export type TableShape = 'wide' | 'tall'

const spread = (k: number) => Array.from({ length: k }, (_, j) => round2(((j + 1) * 100) / (k + 1)))

/**
 * `n` seats round a rounded-rectangle table, as percentages of the table (0-100 on each axis). The first seat is at
 * the bottom centre (your seat); the next ones go on to your left, round the table clockwise. Seats sit along the
 * edges, never on the corners: a `wide` table (landscape) seats most players along the top, a `tall` one (portrait)
 * along the sides.
 */
export function seatPoints(n: number, shape: TableShape = 'wide'): Point[] {
  const others = Math.max(0, n - 1)
  let bottom = 0
  let side: number
  let top: number
  if (shape === 'wide') {
    side = others >= 2 ? 1 : 0
    const rest = others - 2 * side
    bottom = rest >= 4 ? 1 : 0
    top = rest - 2 * bottom
  } else {
    top = others % 2
    side = (others - top) / 2
  }
  const ys = spread(side)
  const flank = { x: round2(50 / (bottom + 1)), y: 100 }
  return [
    { x: 50, y: 100 },
    ...(bottom ? [flank] : []),
    ...[...ys].reverse().map((y) => ({ x: 0, y })),
    ...spread(top).map((x) => ({ x, y: 0 })),
    ...ys.map((y) => ({ x: 100, y })),
    ...(bottom ? [{ x: round2(100 - flank.x), y: 100 }] : []),
  ].slice(0, Math.max(1, n))
}

/** Seats sit on an edge, never a corner: they face straight across the table. */
export const facingFor = (p: Point): Point => ({ x: p.x === 0 ? 1 : p.x === 100 ? -1 : 0, y: p.y === 0 ? 1 : p.y === 100 ? -1 : 0 })

function lobbySeatCount(players: number): number {
  return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, players < MAX_PLAYERS ? players + 1 : players))
}

/** Everything on the table right now, from the state snapshot alone. */
export function tableView(state: GameState, options: TableOptions = {}): TableView {
  const you = state.you.playerId
  const round = state.room.status === 'playing' ? state.round : null
  const phase: TablePhase = round ? round.phase : 'lobby'
  const avatars = assignAvatars(state.players)
  const ordered = seatOrder(state.players, you)
  const count = phase === 'lobby' ? lobbySeatCount(ordered.length) : ordered.length
  const seatAt = seatPoints(count, 'wide')
  const tallAt = seatPoints(count, 'tall')
  const storytellerId = round?.storytellerId ?? null
  const reveal = round?.phase === 'reveal' ? round.reveal : null

  const seats: Seat[] = seatAt.map((point, i) => {
    const player = ordered[i] ?? null
    const isYou = player?.playerId === you
    const isStoryteller = !!player && player.playerId === storytellerId
    const seat: Seat = {
      key: player?.playerId ?? `open-${i}`,
      player,
      avatar: player ? (avatars.get(player.playerId) ?? null) : null,
      isYou,
      isStoryteller,
      seat: point,
      facing: facingFor(point),
      tall: { seat: tallAt[i], facing: facingFor(tallAt[i]) },
      status: null,
      inFront: null,
      vote: null,
      pointsWon: null,
    }
    if (!player || !round) return seat
    switch (round.phase) {
      case 'storyteller':
        if (isStoryteller && (player.hasSubmitted || (isYou && options.storytellerPicked))) seat.inFront = 'facedown'
        break
      case 'submit':
        if (isStoryteller) seat.inFront = 'facedown'
        else {
          seat.inFront = player.hasSubmitted ? 'facedown' : 'waiting'
          seat.status = player.hasSubmitted ? 'done' : 'waiting'
        }
        break
      case 'vote':
        if (!isStoryteller) {
          seat.vote = player.hasVoted ? 'placed' : 'waiting'
          seat.status = player.hasVoted ? 'done' : 'waiting'
        }
        break
      case 'reveal':
        seat.pointsWon = reveal ? (reveal.points[player.playerId] ?? 0) : null
        break
    }
    return seat
  })

  const byId = new Map(state.players.map((p) => [p.playerId, p]))
  const clueBase: ClueBase = {
    storyteller: storytellerId ? (byId.get(storytellerId) ?? null) : null,
    youAreStoryteller: storytellerId === you,
  }
  const clue = round?.clue ?? ''

  let centre: TableCentre
  if (!round) {
    centre = { kind: 'lobby', seated: state.players.length, min: MIN_PLAYERS, max: MAX_PLAYERS }
  } else if (round.phase === 'storyteller') {
    centre = { kind: 'choosing', ...clueBase }
  } else if (round.phase === 'submit') {
    centre = { kind: 'clue', clue, ...clueBase }
  } else if (round.phase === 'vote') {
    const canVote = !clueBase.youAreStoryteller && !round.yourVote
    centre = {
      kind: 'vote',
      clue,
      ...clueBase,
      cards: round.table.map((clip) => {
        const isYours = clip.clipId === round.yourSubmission
        return { clip, isYours, isYourVote: clip.clipId === round.yourVote, canVote: canVote && !isYours }
      }),
    }
  } else {
    const clips = new Map(round.table.map((c) => [c.clipId, c]))
    centre = {
      kind: 'reveal',
      clue,
      ...clueBase,
      cards: (reveal?.results ?? []).map((r) => ({
        clip: clips.get(r.clipId) ?? { clipId: r.clipId, clipUrl: '', text: '', emotion: '', voiceId: '' },
        owner: byId.get(r.ownerId) ?? null,
        isStoryteller: r.isStoryteller,
        isYours: r.ownerId === you,
        voters: r.voterIds.flatMap((id) => byId.get(id) ?? []),
      })),
    }
  }

  return { phase, seats, centre }
}

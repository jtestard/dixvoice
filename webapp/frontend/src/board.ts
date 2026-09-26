import type { Clip, GameState, Player, RevealResult } from './types'

/** What sits in one numbered slot of the board's play area. */
export type Slot =
  | { kind: 'empty' }
  | { kind: 'facedown' }
  | { kind: 'clip'; clip: Clip }
  | { kind: 'result'; clip: Clip; result: RevealResult }

/** A player's status chip on the board rail, for the current phase. */
export type SeatStatus = 'storyteller' | 'done' | 'waiting' | 'idle'

export interface PawnLook {
  /** Colour index into the pawn palette (0-3). */
  color: number
  /** Shape index (0 = round, 1 = square). */
  shape: number
  initial: string
}

const PAWN_COLORS = 4

/**
 * The board's slots, one per player (a Dixit board has one voting slot per player).
 * Storyteller phase: all empty. Submit: a face-down card per clip played so far (the
 * storyteller's is there from the start). Vote: the shuffled clips, face up. Reveal: the
 * same clips with their owner and votes.
 */
export function boardSlots(state: GameState): Slot[] {
  const round = state.round
  const n = state.players.length
  const slots: Slot[] = []
  if (round?.phase === 'submit') {
    const played = 1 + state.players.filter((p) => !p.isStoryteller && p.hasSubmitted).length
    for (let i = 0; i < played; i++) slots.push({ kind: 'facedown' })
  } else if (round?.phase === 'vote') {
    for (const clip of round.table) slots.push({ kind: 'clip', clip })
  } else if (round?.phase === 'reveal' && round.reveal) {
    for (const result of round.reveal.results) {
      const clip = round.table.find((c) => c.clipId === result.clipId) ?? { clipId: result.clipId, clipUrl: '', text: '', emotion: '', voiceId: '' }
      slots.push({ kind: 'result', clip, result })
    }
  }
  while (slots.length < n) slots.push({ kind: 'empty' })
  return slots
}

/** Players grouped by score cell on the 0..target track (scores past the target sit on the last cell). */
export function trackCells(players: Player[], target: number): Player[][] {
  const cells: Player[][] = Array.from({ length: target + 1 }, () => [])
  for (const p of players) cells[Math.max(0, Math.min(target, p.score))].push(p)
  return cells
}

/** Stable pawn colour, shape and initial from the join order: 8 players get 8 distinct pawns. */
export function pawnLooks(players: Player[]): Map<string, PawnLook> {
  const looks = new Map<string, PawnLook>()
  players.forEach((p, i) => {
    looks.set(p.playerId, {
      color: i % PAWN_COLORS,
      shape: Math.floor(i / PAWN_COLORS) % 2,
      initial: (p.nickname.trim()[0] ?? '?').toUpperCase(),
    })
  })
  return looks
}

export function seatStatus(state: GameState, player: Player): SeatStatus {
  const phase = state.round?.phase
  if (player.isStoryteller) return 'storyteller'
  if (phase === 'submit') return player.hasSubmitted ? 'done' : 'waiting'
  if (phase === 'vote') return player.hasVoted ? 'done' : 'waiting'
  return 'idle'
}

/** Rail order: you first, then everyone else in join order, so your seat is always easy to find. */
export function railOrder(players: Player[], youId: string): Player[] {
  const you = players.filter((p) => p.playerId === youId)
  return [...you, ...players.filter((p) => p.playerId !== youId)]
}

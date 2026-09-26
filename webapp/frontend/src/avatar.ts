import { hash } from './hash'
import type { Player } from './types'

export const AVATAR_SHAPES = ['circle', 'square', 'diamond', 'hexagon', 'burst'] as const
export type AvatarShape = (typeof AVATAR_SHAPES)[number]

/** Palette slots, mapped to Tape Deck colour tokens in index.css (`.avatar--c0` ... `.avatar--c5`). */
export const AVATAR_COLOURS = 6

export interface AvatarSpec {
  shape: AvatarShape
  colour: number
  initial: string
  bot: boolean
}

const COMBOS = AVATAR_SHAPES.length * AVATAR_COLOURS

/** Companions are named "Robo Ada", "Robo Turing"...: their last word is the distinctive one. */
export function avatarInitial(player: Pick<Player, 'nickname' | 'isCompanion'>): string {
  const words = player.nickname.trim().split(/\s+/)
  const word = (player.isCompanion ? words[words.length - 1] : words[0]) ?? ''
  return (Array.from(word)[0] ?? '?').toLocaleUpperCase()
}

function spec(combo: number, player: Player): AvatarSpec {
  return {
    shape: AVATAR_SHAPES[combo % AVATAR_SHAPES.length],
    colour: Math.floor(combo / AVATAR_SHAPES.length) % AVATAR_COLOURS,
    initial: avatarInitial(player),
    bot: player.isCompanion,
  }
}

/**
 * One avatar per player, derived from the player id (a shape and a palette colour). Players are taken in join order
 * and a player whose combination is already used at the table takes the next free one, so every seat looks distinct.
 */
export function assignAvatars(players: Player[]): Map<string, AvatarSpec> {
  const used = new Set<number>()
  const out = new Map<string, AvatarSpec>()
  for (const p of players) {
    let combo = hash(p.playerId) % COMBOS
    while (used.has(combo) && used.size < COMBOS) combo = (combo + 1) % COMBOS
    used.add(combo)
    out.set(p.playerId, spec(combo, p))
  }
  return out
}

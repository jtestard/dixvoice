import type { GameState } from './types'

export interface RoundResult {
  tone: 'success' | 'failure' | 'neutral'
  label: string
  points: number
  reason: string
  breakdown: string
}

export function roundResult(state: GameState): RoundResult | null {
  const round = state.round
  const reveal = round?.reveal
  if (!round || !reveal) return null

  const storytellerClip = reveal.results.find((result) => result.isStoryteller)
  if (!storytellerClip) return null

  const you = state.you.playerId
  const storyteller = round.storytellerId === you
  const found = storytellerClip.voterIds.length
  const everyone = found === state.players.length - 1
  const allOrNone = found === 0 || everyone
  const base = storyteller ? (allOrNone ? 0 : 3) : allOrNone ? 2 : storytellerClip.voterIds.includes(you) ? 3 : 0
  const bonus = storyteller ? 0 : (reveal.results.find((result) => result.ownerId === you)?.voterIds.length ?? 0)
  const points = reveal.points[you] ?? 0

  const reason = storyteller
    ? allOrNone
      ? `${everyone ? 'Everyone' : 'No one'} found your clip, so you earn 0 base points. Storytellers do not earn vote bonuses.`
      : 'Some, but not all, found your clip, so you earn 3 base points. Storytellers do not earn vote bonuses.'
    : allOrNone
      ? `${everyone ? 'Everyone' : 'No one'} found the storyteller's clip, so every other player earns 2 base points.`
      : storytellerClip.voterIds.includes(you)
        ? "You found the storyteller's clip, earning 3 base points."
        : "You did not find the storyteller's clip, earning 0 base points."

  return {
    tone: points === 0 ? 'failure' : points >= 2 ? 'success' : 'neutral',
    label: points === 0 ? 'Round loss' : points >= 2 ? 'Round win' : '1 point earned',
    points,
    reason,
    breakdown: storyteller
      ? `${base} base = ${points} points`
      : `${base} base + ${bonus} ${bonus === 1 ? 'vote' : 'votes'} on your clip = ${points} ${points === 1 ? 'point' : 'points'}`,
  }
}

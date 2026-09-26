import { useEffect, useRef } from 'react'
import { sfx } from './sfx'
import type { GameState } from './types'
import type { Notice } from './useGame'

/**
 * Sounds driven by server snapshots. The player's own actions play their sound on the click
 * (select / submit / stamp / click); this hook only covers what arrives from the server:
 * players joining, the deal, phase changes, the others' moves, the end of the game and errors.
 */
export function useSfxCues(state: GameState | null, notice: Notice | null): void {
  const prev = useRef<GameState | null>(null)

  useEffect(() => {
    const p = prev.current
    prev.current = state
    if (!state) return
    const r = state.round
    const pr = p?.round ?? null

    if (p && state.room.status === 'lobby' && state.players.length > p.players.length) sfx('join')

    if (r && (!pr || pr.number !== r.number || p?.room.status !== 'playing')) {
      for (let i = 0; i < 6; i++) sfx('deal', i)
    }

    if (r && pr && r.phase !== pr.phase) {
      if (r.phase === 'submit') sfx('clue')
      if (r.phase === 'vote') r.table.forEach((_, i) => sfx('flip', i))
      if (r.phase === 'reveal' && r.reveal) {
        r.reveal.results.forEach((_, i) => sfx('flip', i))
        const mine = r.reveal.points[state.you.playerId] ?? 0
        setTimeout(() => sfx('correct'), 420)
        setTimeout(() => sfx(mine >= 2 ? 'win' : mine === 0 ? 'lose' : 'select'), 900)
        for (let i = 0; i < Math.min(mine, 10); i++) setTimeout(() => sfx('tick', i), 1100 + i * 90)
      }
    } else if (r && pr && p) {
      const done = (s: GameState) => s.players.filter((x) => (r.phase === 'submit' ? x.hasSubmitted : x.hasVoted)).length
      const mineChanged = r.yourSubmission !== pr.yourSubmission || r.yourVote !== pr.yourVote
      if (!mineChanged && done(state) > done(p)) sfx('place')
    }

    if (state.room.status === 'finished' && p?.room.status !== 'finished') {
      setTimeout(() => sfx(state.winnerIds.includes(state.you.playerId) ? 'fanfare' : 'lose'), 300)
    }
  }, [state])

  useEffect(() => {
    if (notice?.kind === 'error') sfx('error')
  }, [notice])
}

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EndGame, Game } from '../components/Game'
import { roundResult } from '../roundResult'
import { REVEAL_ROUND, finishedState, playingState } from './fixtures'

const reveal = REVEAL_ROUND.reveal!

describe('Round result', () => {
  it('explains a win from finding the storyteller and getting a vote', () => {
    const state = playingState('p4', REVEAL_ROUND)
    expect(roundResult(state)).toMatchObject({
      tone: 'success',
      label: 'Round win',
      points: 4,
      reason: "You found the storyteller's clip, earning 3 base points.",
      breakdown: '3 base + 1 vote on your clip = 4 points',
    })

    render(<Game state={state} send={vi.fn()} />)
    const result = screen.getByRole('status', { name: 'Your round result' })
    expect(result).toHaveClass('round-result--success')
    expect(result).toHaveTextContent('Round win · +4')
    expect(result).toHaveTextContent('3 base + 1 vote on your clip = 4 points')
  })

  it('explains a loss with no correct vote or bonus votes', () => {
    const state = playingState('p4', {
      ...REVEAL_ROUND,
      yourVote: 't3',
      reveal: {
        results: reveal.results.map((result) =>
          result.clipId === 't1' ? { ...result, voterIds: ['p2'] } : result.clipId === 't3' ? { ...result, voterIds: ['p3', 'p4'] } : { ...result, voterIds: [] },
        ),
        points: { p1: 3, p2: 5, p3: 0, p4: 0 },
      },
    })
    expect(roundResult(state)).toMatchObject({
      tone: 'failure',
      points: 0,
      reason: "You did not find the storyteller's clip, earning 0 base points.",
      breakdown: '0 base + 0 votes on your clip = 0 points',
    })

    render(<Game state={state} send={vi.fn()} />)
    expect(screen.getByRole('status', { name: 'Your round result' })).toHaveClass('round-result--failure')
  })

  it('explains a one-point bonus without calling it a win or loss', () => {
    const state = playingState('p4', {
      ...REVEAL_ROUND,
      yourVote: 't3',
      reveal: {
        results: reveal.results.map((result) =>
          result.clipId === 't1' ? { ...result, voterIds: ['p2'] } : result.clipId === 't2' ? { ...result, voterIds: ['p3'] } : { ...result, voterIds: [] },
        ),
        points: { p1: 3, p2: 4, p3: 0, p4: 1 },
      },
    })
    expect(roundResult(state)).toMatchObject({
      tone: 'neutral',
      label: '1 point earned',
      breakdown: '0 base + 1 vote on your clip = 1 point',
    })
    render(<Game state={state} send={vi.fn()} />)
    expect(screen.getByRole('status', { name: 'Your round result' })).toHaveClass('round-result--neutral')
  })

  it('explains the two-point exception when everyone or no one finds the clip', () => {
    const noOne = playingState('p4', {
      ...REVEAL_ROUND,
      yourVote: 't4',
      reveal: {
        results: reveal.results.map((result) => result.clipId === 't1' ? { ...result, voterIds: [] } : result.clipId === 't2' ? { ...result, voterIds: ['p2'] } : result.clipId === 't3' ? { ...result, voterIds: ['p3'] } : { ...result, voterIds: ['p4'] }),
        points: { p1: 0, p2: 3, p3: 3, p4: 3 },
      },
    })
    expect(roundResult(noOne)).toMatchObject({
      tone: 'success',
      reason: "No one found the storyteller's clip, so every other player earns 2 base points.",
      breakdown: '2 base + 1 vote on your clip = 3 points',
    })

    const everyone = playingState('p4', {
      ...REVEAL_ROUND,
      reveal: {
        results: reveal.results.map((result) => result.clipId === 't1' ? { ...result, voterIds: ['p2', 'p3', 'p4'] } : { ...result, voterIds: [] }),
        points: { p1: 0, p2: 2, p3: 2, p4: 2 },
      },
    })
    expect(roundResult(everyone)).toMatchObject({
      tone: 'success',
      reason: "Everyone found the storyteller's clip, so every other player earns 2 base points.",
      breakdown: '2 base + 0 votes on your clip = 2 points',
    })
    expect(roundResult({ ...everyone, you: { ...everyone.you, playerId: 'p1' } })).toMatchObject({
      tone: 'failure',
      reason: 'Everyone found your clip, so you earn 0 base points. Storytellers do not earn vote bonuses.',
      breakdown: '0 base = 0 points',
    })
  })

  it('explains the storyteller win and has no result before reveal', () => {
    expect(roundResult(playingState('p1', { phase: 'vote' }))).toBeNull()
    expect(roundResult(playingState('p1', REVEAL_ROUND))).toMatchObject({
      tone: 'success',
      reason: 'Some, but not all, found your clip, so you earn 3 base points. Storytellers do not earn vote bonuses.',
      breakdown: '3 base = 3 points',
    })
  })
})

describe('End of game result', () => {
  it('highlights a win in green and a loss in red', () => {
    const state = finishedState()
    const { rerender } = render(<EndGame state={state} send={vi.fn()} />)
    expect(screen.getByText('Chloé wins!')).toHaveClass('winner-line--failure')
    rerender(<EndGame state={{ ...state, you: { ...state.you, playerId: 'p3' } }} send={vi.fn()} />)
    expect(screen.getByText('You win!')).toHaveClass('winner-line--success')
  })
})

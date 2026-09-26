import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { boardSlots, pawnLooks, railOrder, seatStatus, trackCells } from '../board'
import { Game } from '../components/Game'
import { PLAYERS, TABLE, player, playingState } from './fixtures'

const REVEAL = {
  results: [
    { clipId: 't1', ownerId: 'p1', isStoryteller: true, voterIds: ['p4'] },
    { clipId: 't2', ownerId: 'p4', isStoryteller: false, voterIds: [] },
    { clipId: 't3', ownerId: 'p2', isStoryteller: false, voterIds: ['p3'] },
    { clipId: 't4', ownerId: 'p3', isStoryteller: false, voterIds: [] },
  ],
  points: { p1: 3, p2: 1, p3: 0, p4: 3 },
}

describe('boardSlots', () => {
  it('is all empty while the storyteller chooses, one slot per player', () => {
    const slots = boardSlots(playingState('p4', { phase: 'storyteller' }))
    expect(slots.map((s) => s.kind)).toEqual(['empty', 'empty', 'empty', 'empty'])
  })

  it('shows a face-down card per clip played so far, the storyteller first', () => {
    const state = playingState('p4', { phase: 'submit', clue: 'rain' })
    state.players = state.players.map((p) => (p.playerId === 'p2' ? { ...p, hasSubmitted: true } : p))
    expect(boardSlots(state).map((s) => s.kind)).toEqual(['facedown', 'facedown', 'empty', 'empty'])
  })

  it('lays the shuffled clips face up for the vote', () => {
    const slots = boardSlots(playingState('p4', { phase: 'vote', clue: 'rain', table: TABLE }))
    expect(slots.map((s) => (s.kind === 'clip' ? s.clip.clipId : s.kind))).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('pairs every clip with its owner and votes at the reveal', () => {
    const slots = boardSlots(playingState('p4', { phase: 'reveal', clue: 'rain', table: TABLE, reveal: REVEAL }))
    const first = slots[0]
    expect(first.kind).toBe('result')
    if (first.kind === 'result') {
      expect(first.clip.clipId).toBe('t1')
      expect(first.result.voterIds).toEqual(['p4'])
    }
  })
})

describe('trackCells', () => {
  it('puts each pawn on its score and clamps past the target', () => {
    const cells = trackCells([...PLAYERS, player('p9', 'Zed', { score: 12 })], 10)
    expect(cells).toHaveLength(11)
    expect(cells[5].map((p) => p.nickname)).toEqual(['Ana'])
    expect(cells[10].map((p) => p.nickname)).toEqual(['Zed'])
    expect(cells[0]).toEqual([])
  })
})

describe('pawnLooks', () => {
  it('gives 8 players 8 distinct pawns, stable by join order', () => {
    const eight = Array.from({ length: 8 }, (_, i) => player(`p${i}`, `N${i}`))
    const looks = pawnLooks(eight)
    const keys = new Set([...looks.values()].map((l) => `${l.color}/${l.shape}`))
    expect(keys.size).toBe(8)
    expect(pawnLooks(eight).get('p5')).toEqual(looks.get('p5'))
    expect(looks.get('p3')?.initial).toBe('N')
  })
})

describe('seatStatus and railOrder', () => {
  it('marks the storyteller in every phase and done/waiting while playing and voting', () => {
    const submit = playingState('p4', { phase: 'submit', clue: 'rain' })
    submit.players = submit.players.map((p) => (p.playerId === 'p2' ? { ...p, hasSubmitted: true } : p))
    expect(submit.players.map((p) => seatStatus(submit, p))).toEqual(['storyteller', 'done', 'waiting', 'waiting'])
    const choosing = playingState('p4', { phase: 'storyteller' })
    expect(choosing.players.map((p) => seatStatus(choosing, p))).toEqual(['storyteller', 'idle', 'idle', 'idle'])
  })

  it('puts you first on the rail', () => {
    expect(railOrder(PLAYERS, 'p4').map((p) => p.playerId)).toEqual(['p4', 'p1', 'p2', 'p3'])
  })
})

describe('Board on screen', () => {
  it('stays visible in every phase', () => {
    for (const phase of ['storyteller', 'submit', 'vote', 'reveal'] as const) {
      const { unmount } = render(
        <Game state={playingState('p4', { phase, clue: phase === 'storyteller' ? null : 'rain', table: TABLE, reveal: phase === 'reveal' ? REVEAL : null })} send={vi.fn()} />,
      )
      expect(screen.getByRole('region', { name: 'Board' })).toBeInTheDocument()
      unmount()
    }
  })

  it('shows your own seat as the storyteller, with your clue label', () => {
    render(<Game state={playingState('p1', { phase: 'submit', clue: 'rain' })} send={vi.fn()} />)
    const rail = screen.getByRole('list', { name: 'Players' })
    const seats = within(rail).getAllByRole('listitem')
    expect(seats[0]).toHaveClass('seat--you', 'seat--storyteller')
    expect(within(seats[0]).getByText('storyteller')).toBeInTheDocument()
    expect(screen.getByText('Your clue')).toBeInTheDocument()
  })

  it('says who is choosing while the table is empty', () => {
    render(<Game state={playingState('p4', { phase: 'storyteller' })} send={vi.fn()} />)
    expect(screen.getByText(/Ana is choosing a clip and a clue/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Score track, first to 10: Ana 5, Ben 3, Chloé 7, You 4/)).toBeInTheDocument()
  })

  it('shows the points won on each seat at the reveal', () => {
    render(<Game state={playingState('p4', { phase: 'reveal', clue: 'rain', table: TABLE, reveal: REVEAL })} send={vi.fn()} />)
    const rail = screen.getByRole('list', { name: 'Players' })
    expect(within(rail).getAllByText('+3')).toHaveLength(2)
    expect(within(rail).getByText('+1')).toBeInTheDocument()
  })
})

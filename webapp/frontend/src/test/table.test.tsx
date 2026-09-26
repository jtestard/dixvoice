import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AVATAR_COLOURS, AVATAR_SHAPES, assignAvatars, avatarInitial } from '../avatar'
import { Game } from '../components/Game'
import { Lobby } from '../components/Lobby'
import { seatOrder, seatPoints, tableView } from '../table'
import { COMPANION, PLAYERS, REVEAL_ROUND, TABLE, lobbyState, player, playingState } from './fixtures'

const EIGHT = [...PLAYERS, COMPANION, player('p6', 'Fay'), player('p7', 'Gus'), player('p8', 'Hal')]

describe('seat layout', () => {
  it('keeps join order, rotated so you come first', () => {
    expect(seatOrder(PLAYERS, 'p1').map((p) => p.playerId)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(seatOrder(PLAYERS, 'p3').map((p) => p.playerId)).toEqual(['p3', 'p4', 'p1', 'p2'])
    expect(seatOrder(PLAYERS, 'p4').map((p) => p.playerId)).toEqual(['p4', 'p1', 'p2', 'p3'])
    expect(seatOrder(PLAYERS, 'nobody').map((p) => p.playerId)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('puts the first seat at the bottom centre and spreads the rest along the edges, never on a corner', () => {
    for (const shape of ['wide', 'tall'] as const) {
      for (const n of [4, 5, 6, 7, 8]) {
        const pts = seatPoints(n, shape)
        expect(pts).toHaveLength(n)
        expect(pts[0]).toEqual({ x: 50, y: 100 })
        expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(n)
        for (const p of pts) {
          const onEdge = p.x === 0 || p.x === 100 || p.y === 0 || p.y === 100
          const corner = (p.x === 0 || p.x === 100) && (p.y === 0 || p.y === 100)
          expect(onEdge && !corner).toBe(true)
        }
      }
    }
    const square = [
      { x: 50, y: 100 },
      { x: 0, y: 50 },
      { x: 50, y: 0 },
      { x: 100, y: 50 },
    ]
    expect(seatPoints(4, 'wide')).toEqual(square)
    expect(seatPoints(4, 'tall')).toEqual(square)
    // Clockwise from you: on your left first, then round the far side.
    expect(seatPoints(8, 'tall').map((p) => p.x)).toEqual([50, 0, 0, 0, 50, 100, 100, 100])
    expect(seatPoints(8, 'wide')).toEqual([
      { x: 50, y: 100 },
      { x: 25, y: 100 },
      { x: 0, y: 50 },
      { x: 25, y: 0 },
      { x: 50, y: 0 },
      { x: 75, y: 0 },
      { x: 100, y: 50 },
      { x: 75, y: 100 },
    ])
  })

  it('always seats you at the bottom, labelled You, whatever your join position', () => {
    for (const you of ['p1', 'p4'] as const) {
      const { seats } = tableView(playingState(you, { phase: 'storyteller' }))
      expect(seats).toHaveLength(4)
      expect(seats[0]).toMatchObject({ isYou: true, seat: { x: 50, y: 100 } })
      expect(seats[0].player?.playerId).toBe(you)
      expect(seats.filter((s) => s.isYou)).toHaveLength(1)
    }
    const eight = { ...playingState('p4', { phase: 'storyteller' }), players: EIGHT }
    expect(tableView(eight).seats.map((s) => s.player?.playerId)).toEqual(['p4', 'p5', 'p6', 'p7', 'p8', 'p1', 'p2', 'p3'])
  })

  it('shows open seats in the lobby, filling up as players join', () => {
    const three = tableView(lobbyState(PLAYERS.slice(0, 3)))
    expect(three.phase).toBe('lobby')
    expect(three.seats).toHaveLength(4)
    expect(three.seats.filter((s) => !s.player)).toHaveLength(1)
    expect(three.centre).toEqual({ kind: 'lobby', seated: 3, min: 4, max: 8 })
    expect(tableView(lobbyState(PLAYERS)).seats.filter((s) => !s.player)).toHaveLength(1)
    expect(tableView(lobbyState(EIGHT)).seats.filter((s) => !s.player)).toHaveLength(0)
    expect(tableView(lobbyState([])).seats).toHaveLength(4)
  })
})

describe('avatars', () => {
  it('are deterministic and distinct at the table', () => {
    const a = assignAvatars(EIGHT)
    expect(assignAvatars(EIGHT)).toEqual(a)
    const combos = [...a.values()].map((s) => `${s.shape}:${s.colour}`)
    expect(new Set(combos).size).toBe(EIGHT.length)
    for (const s of a.values()) {
      expect(AVATAR_SHAPES).toContain(s.shape)
      expect(s.colour).toBeGreaterThanOrEqual(0)
      expect(s.colour).toBeLessThan(AVATAR_COLOURS)
    }
    expect(a.get('p5')).toMatchObject({ bot: true, initial: 'A' })
    expect(a.get('p3')).toMatchObject({ bot: false, initial: 'C' })
  })

  it('use the distinctive word of a companion name', () => {
    expect(avatarInitial({ nickname: 'Robo Turing', isCompanion: true })).toBe('T')
    expect(avatarInitial({ nickname: 'élise', isCompanion: false })).toBe('É')
    expect(avatarInitial({ nickname: '  ', isCompanion: false })).toBe('?')
  })
})

describe('storyteller marker', () => {
  it('marks another player as storyteller', () => {
    const view = tableView(playingState('p4', { phase: 'storyteller' }))
    expect(view.seats.filter((s) => s.isStoryteller).map((s) => s.player?.playerId)).toEqual(['p1'])
    expect(view.centre).toMatchObject({ kind: 'choosing', youAreStoryteller: false, storyteller: { nickname: 'Ana' } })
  })

  it('marks your own bottom seat when you are the storyteller', () => {
    const view = tableView(playingState('p1', { phase: 'storyteller' }))
    expect(view.seats[0]).toMatchObject({ isYou: true, isStoryteller: true })
    expect(view.seats.filter((s) => s.isStoryteller)).toHaveLength(1)
    expect(view.centre).toMatchObject({ kind: 'choosing', youAreStoryteller: true })
  })

  it('renders the token on the storyteller seat and the centre text', () => {
    const { unmount } = render(<Game state={playingState('p1', { phase: 'storyteller' })} send={vi.fn()} />)
    const token = screen.getByTestId('storyteller-token')
    expect(token).toHaveAttribute('data-tutorial', 'storyteller')
    const mine = screen.getByTestId('seat-p1')
    expect(mine).toContainElement(token)
    expect(mine.querySelector('.seat__name')).toHaveTextContent(/^You \(Ana\)$/)
    expect(within(mine).getByText('storyteller')).toBeInTheDocument()
    expect(screen.getByTestId('table-centre')).toHaveTextContent("You're telling the story")
    unmount()

    render(<Game state={playingState('p4', { phase: 'storyteller' })} send={vi.fn()} />)
    expect(screen.getByTestId('seat-p1')).toContainElement(screen.getByTestId('storyteller-token'))
    expect(screen.getByTestId('table-centre')).toHaveTextContent('Ana is choosing a clip…')
  })
})

describe('what is on the table, by phase', () => {
  const inFront = (view: ReturnType<typeof tableView>) => Object.fromEntries(view.seats.map((s) => [s.key, s.inFront]))

  it('storyteller: only the clue placeholder, and a face-down card once the storyteller has picked', () => {
    expect(inFront(tableView(playingState('p1', { phase: 'storyteller' })))).toEqual({ p1: null, p2: null, p3: null, p4: null })
    expect(tableView(playingState('p1', { phase: 'storyteller' }), { storytellerPicked: true }).seats[0].inFront).toBe('facedown')
    const others = playingState('p4', { phase: 'storyteller' })
    expect(tableView(others, { storytellerPicked: true }).seats.every((s) => s.inFront === null)).toBe(true)
  })

  it('submit: the clue in the centre, face-down cards for the storyteller and whoever has submitted', () => {
    const state = playingState('p4', { phase: 'submit', clue: 'a door in the rain' })
    state.players = state.players.map((p) => (p.playerId === 'p2' ? { ...p, hasSubmitted: true } : p))
    const view = tableView(state)
    expect(view.centre).toMatchObject({ kind: 'clue', clue: 'a door in the rain' })
    expect(inFront(view)).toEqual({ p1: 'facedown', p2: 'facedown', p3: 'waiting', p4: 'waiting' })
    expect(Object.fromEntries(view.seats.map((s) => [s.key, s.status]))).toEqual({ p1: null, p2: 'done', p3: 'waiting', p4: 'waiting' })
  })

  it('vote: the submitted cards face up in the centre in table order, and vote tokens on the seats', () => {
    const state = playingState('p4', { phase: 'vote', clue: 'a door in the rain', table: TABLE, yourSubmission: 't2' })
    state.players = state.players.map((p) => (p.playerId === 'p3' ? { ...p, hasVoted: true } : p))
    const view = tableView(state)
    expect(view.seats.every((s) => s.inFront === null)).toBe(true)
    expect(Object.fromEntries(view.seats.map((s) => [s.key, s.vote]))).toEqual({ p1: null, p2: 'waiting', p3: 'placed', p4: 'waiting' })
    if (view.centre.kind !== 'vote') throw new Error('expected vote centre')
    expect(view.centre.cards.map((c) => [c.clip.clipId, c.isYours, c.canVote])).toEqual([
      ['t1', false, true],
      ['t2', true, false],
      ['t3', false, true],
      ['t4', false, true],
    ])
    const voted = tableView(playingState('p4', { phase: 'vote', table: TABLE, yourSubmission: 't2', yourVote: 't3' }))
    if (voted.centre.kind !== 'vote') throw new Error('expected vote centre')
    expect(voted.centre.cards.map((c) => [c.isYourVote, c.canVote])).toEqual([
      [false, false],
      [false, false],
      [true, false],
      [false, false],
    ])
    const teller = tableView(playingState('p1', { phase: 'vote', table: TABLE, yourSubmission: 't1' }))
    if (teller.centre.kind !== 'vote') throw new Error('expected vote centre')
    expect(teller.centre.cards.some((c) => c.canVote)).toBe(false)
  })

  it('reveal: owners, stacked voters, the storyteller card, and points at each seat', () => {
    const view = tableView(playingState('p4', REVEAL_ROUND))
    if (view.centre.kind !== 'reveal') throw new Error('expected reveal centre')
    expect(view.centre.cards.map((c) => [c.clip.clipId, c.owner?.playerId, c.isStoryteller, c.isYours, c.voters.map((v) => v.playerId)])).toEqual([
      ['t1', 'p1', true, false, ['p4']],
      ['t2', 'p4', false, true, ['p2']],
      ['t3', 'p2', false, false, []],
      ['t4', 'p3', false, false, ['p3']],
    ])
    expect(Object.fromEntries(view.seats.map((s) => [s.key, s.pointsWon]))).toEqual({ p4: 4, p1: 3, p2: 0, p3: 0 })
  })

  it('is a pure function of the state', () => {
    const state = playingState('p4', REVEAL_ROUND)
    const copy = structuredClone(state)
    expect(tableView(state)).toEqual(tableView(state))
    expect(state).toEqual(copy)
  })
})

describe('table rendering', () => {
  it('is always visible during the game, with tutorial anchors', () => {
    const rounds = [
      { phase: 'storyteller' as const },
      { phase: 'submit' as const, clue: 'x' },
      { phase: 'vote' as const, clue: 'x', table: TABLE },
      REVEAL_ROUND,
    ]
    for (const round of rounds) {
      const { container, unmount } = render(<Game state={playingState('p4', round)} send={vi.fn()} />)
      expect(screen.getByTestId('table')).toHaveAttribute('data-tutorial', 'table')
      expect(container.querySelector('[data-tutorial="seats"]')?.querySelectorAll('li')).toHaveLength(4)
      expect(container.querySelector('[data-tutorial="hand"]')).toHaveAccessibleName('Your hand')
      expect(container.querySelectorAll('[data-tutorial="storyteller"]')).toHaveLength(1)
      unmount()
    }
  })

  it('shows face-down cards in front of the seats that submitted', () => {
    const state = playingState('p4', { phase: 'submit', clue: 'a door in the rain' })
    state.players = state.players.map((p) => (p.playerId === 'p3' ? { ...p, hasSubmitted: true } : p))
    render(<Game state={state} send={vi.fn()} />)
    expect(screen.getAllByRole('img', { name: /face-down clip/ })).toHaveLength(2)
    expect(within(screen.getByTestId('spot-p3')).getByRole('img', { name: "Chloé's face-down clip" })).toBeInTheDocument()
    expect(screen.getByTestId('spot-p4')).not.toContainElement(screen.queryByRole('img', { name: /Your face-down/ }))
  })

  it('shows the storyteller its own face-down card as soon as it picks', async () => {
    render(<Game state={playingState('p1', { phase: 'storyteller' })} send={vi.fn()} />)
    expect(screen.queryByRole('img', { name: /face-down clip/ })).not.toBeInTheDocument()
    await userEvent.click(within(screen.getByTestId('clip-h2')).getByRole('button', { name: 'Pick' }))
    expect(within(screen.getByTestId('spot-p1')).getByRole('img', { name: 'Your face-down clip' })).toBeInTheDocument()
  })

  it('shows vote tokens without revealing the vote, and points at the seats on reveal', () => {
    const state = playingState('p4', { phase: 'vote', clue: 'x', table: TABLE, yourSubmission: 't2' })
    state.players = state.players.map((p) => (p.playerId === 'p2' ? { ...p, hasVoted: true } : p))
    const { unmount } = render(<Game state={state} send={vi.fn()} />)
    expect(within(screen.getByTestId('seat-p2')).getByText('voted')).toBeInTheDocument()
    expect(within(screen.getByTestId('seat-p3')).getByText('not voted yet')).toBeInTheDocument()
    expect(within(screen.getByTestId('seat-p1')).queryByText(/voted/)).not.toBeInTheDocument()
    unmount()

    render(<Game state={playingState('p4', REVEAL_ROUND)} send={vi.fn()} />)
    expect(screen.getByTestId('points-p4')).toHaveTextContent('+4')
    expect(screen.getByTestId('points-p1')).toHaveTextContent('+3')
    expect(within(screen.getByTestId('seat-p3')).getByText('7')).toBeInTheDocument()
  })

  it('reuses the table in the lobby with open seats and Start below', () => {
    render(<Lobby state={lobbyState(PLAYERS.slice(0, 2))} send={vi.fn()} />)
    const seats = within(screen.getByRole('list', { name: 'Seats' })).getAllByRole('listitem')
    expect(seats).toHaveLength(4)
    expect(seats.filter((s) => s.textContent?.includes('Open seat'))).toHaveLength(2)
    expect(screen.getByText('Players (2/8)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled()
  })
})

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EndGame, Game } from '../components/Game'
import { Lobby } from '../components/Lobby'
import { COMPANION, PLAYERS, REVEAL_ROUND, TABLE, finishedState, lobbyState, player, playingState } from './fixtures'

const eightPlayers = [...PLAYERS, COMPANION, ...['p6', 'p7', 'p8'].map((id) => player(id, `Robo ${id}`, { isCompanion: true }))]

describe('AI companions in the lobby', () => {
  it('sends add_companion', async () => {
    const send = vi.fn()
    render(<Lobby state={lobbyState()} send={send} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add AI companion' }))
    expect(send).toHaveBeenCalledWith({ type: 'add_companion' })
  })

  it('hides Add AI companion when the room has 8 players', () => {
    const { rerender } = render(<Lobby state={lobbyState(eightPlayers.slice(0, 7))} send={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add AI companion' })).toBeInTheDocument()
    rerender(<Lobby state={lobbyState(eightPlayers)} send={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Add AI companion' })).not.toBeInTheDocument()
    expect(screen.getByText('Players (8/8)')).toBeInTheDocument()
  })

  it('sends remove_companion with the companion playerId, and only for companions', async () => {
    const send = vi.fn()
    render(<Lobby state={lobbyState([...PLAYERS.slice(0, 3), COMPANION])} send={send} />)
    const removeButtons = screen.getAllByRole('button', { name: /^Remove / })
    expect(removeButtons).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Robo Ada' }))
    expect(send).toHaveBeenCalledWith({ type: 'remove_companion', playerId: 'p5' })
  })

  it('shows the bot badge next to companions only', () => {
    render(<Lobby state={lobbyState([...PLAYERS.slice(0, 3), COMPANION])} send={vi.fn()} />)
    const badges = screen.getAllByTestId('bot-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].closest('li')).toHaveTextContent('Robo Ada')
  })
})

describe('AI companions on the end-of-game screen', () => {
  it('shows bot badges without offering player changes after the session', () => {
    const send = vi.fn()
    const state = finishedState()
    state.players = [...state.players, COMPANION]
    render(<EndGame state={state} send={send} />)
    expect(screen.queryByRole('button', { name: 'Add AI companion' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Robo Ada' })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('bot-badge')).toHaveLength(2)
  })

  it('hides Add AI companion at 8 players', () => {
    const state = { ...finishedState(), players: eightPlayers }
    render(<EndGame state={state} send={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Add AI companion' })).not.toBeInTheDocument()
  })
})

describe('Bot badge during the game', () => {
  const withCompanionStoryteller = (round: Parameters<typeof playingState>[1]) => {
    const state = playingState('p4', round)
    state.players = state.players.map((p) => (p.playerId === 'p1' ? { ...p, isCompanion: true } : p))
    return state
  }

  it('is shown in the storyteller line and waiting indicators', () => {
    render(<Game state={withCompanionStoryteller({ phase: 'storyteller' })} send={vi.fn()} />)
    // storyteller seat + waiting message
    expect(screen.getAllByTestId('bot-badge')).toHaveLength(2)
    expect(screen.getByText(/Waiting for/).closest('p')).toHaveTextContent('Ana')
  })

  it('is shown in the submit waiting list', () => {
    const state = playingState('p4', { phase: 'submit', clue: 'a door in the rain' })
    state.players = state.players.map((p) => (p.playerId === 'p2' ? { ...p, isCompanion: true } : p))
    render(<Game state={state} send={vi.fn()} />)
    const badge = screen.getByTestId('bot-badge')
    expect(badge.closest('li')).toHaveTextContent('Ben')
    expect(badge.closest('li')).toHaveTextContent('waiting…')
  })

  it('is shown in the scoreboard', async () => {
    render(<Game state={withCompanionStoryteller({ phase: 'storyteller' })} send={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Scores' }))
    const table = screen.getByRole('table')
    expect(within(table).getAllByTestId('bot-badge')).toHaveLength(1)
    expect(within(table).getByTestId('bot-badge').closest('tr')).toHaveTextContent('Ana')
  })

  it('is shown in the reveal (owners, voters, points)', () => {
    render(<Game state={withCompanionStoryteller(REVEAL_ROUND)} send={vi.fn()} />)
    const st = screen.getByTestId('clip-t1')
    expect(within(st).getByTestId('bot-badge')).toBeInTheDocument()
    // storyteller seat (with its points) and owner of t1
    expect(within(screen.getByTestId('seat-p1')).getByTestId('bot-badge')).toBeInTheDocument()
    expect(screen.getAllByTestId('bot-badge').length).toBeGreaterThanOrEqual(2)
  })
})

describe('Clip metadata is never displayed', () => {
  const secret = /SECRET-(TEXT|EMOTION|VOICE)/

  it('in the hand', () => {
    const { container } = render(<Game state={playingState('p1', { phase: 'storyteller' })} send={vi.fn()} />)
    expect(container.innerHTML).not.toMatch(secret)
  })

  it('on the table and in the reveal', () => {
    const vote = render(<Game state={playingState('p4', { phase: 'vote', clue: 'x', table: TABLE, yourSubmission: 't2' })} send={vi.fn()} />)
    expect(vote.container.innerHTML).not.toMatch(secret)
    vote.unmount()
    const reveal = render(<Game state={playingState('p4', REVEAL_ROUND)} send={vi.fn()} />)
    expect(reveal.container.innerHTML).not.toMatch(secret)
  })
})

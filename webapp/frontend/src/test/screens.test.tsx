import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EndGame, Game } from '../components/Game'
import { Lobby } from '../components/Lobby'
import { HAND, PLAYERS, REVEAL_ROUND, TABLE, finishedState, lobbyState, player, playingState } from './fixtures'

describe('Lobby', () => {
  it('disables Start below 4 players and enables it at 4', async () => {
    const send = vi.fn()
    const { rerender } = render(<Lobby state={lobbyState(PLAYERS.slice(0, 3))} send={send} />)
    expect(screen.getByTestId('room-code')).toHaveTextContent('KXQP')
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled()
    expect(screen.getByText(/at least 4 players/)).toBeInTheDocument()

    rerender(<Lobby state={lobbyState(PLAYERS)} send={send} />)
    const start = screen.getByRole('button', { name: 'Start game' })
    expect(start).toBeEnabled()
    await userEvent.click(start)
    expect(send).toHaveBeenCalledWith({ type: 'start_game' })
  })

  it('asks for confirmation in the page before stopping', async () => {
    const send = vi.fn()
    render(<Lobby state={lobbyState()} send={send} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Yes, stop' }))
    expect(send).toHaveBeenCalledWith({ type: 'stop_game' })
  })

  it('sends leave_room', async () => {
    const send = vi.fn()
    render(<Lobby state={lobbyState()} send={send} />)
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(send).toHaveBeenCalledWith({ type: 'leave_room' })
  })
})

describe('Storyteller phase', () => {
  it('lets the storyteller pick a clip and send a clue', async () => {
    const send = vi.fn()
    render(<Game state={playingState('p1', { phase: 'storyteller' })} send={send} />)
    expect(screen.getByText(/You are the storyteller/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Play Clip/ })).toHaveLength(6)
    const sendClue = screen.getByRole('button', { name: 'Send clue' })
    expect(sendClue).toBeDisabled()

    await userEvent.click(within(screen.getByTestId('clip-h3')).getByRole('button', { name: 'Pick' }))
    await userEvent.type(screen.getByLabelText('Your clue'), 'a door in the rain')
    expect(sendClue).toBeEnabled()
    await userEvent.click(sendClue)
    expect(send).toHaveBeenCalledWith({ type: 'submit_clue', clipId: 'h3', clue: 'a door in the rain' })
  })

  it('shows the other players a waiting message and their hand', () => {
    render(<Game state={playingState('p4', { phase: 'storyteller' })} send={vi.fn()} />)
    expect(screen.getByText(/Waiting for Ana to pick a clip/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Play Clip/ })).toHaveLength(6)
    expect(screen.queryByRole('button', { name: 'Pick' })).not.toBeInTheDocument()
  })
})

describe('Submit phase', () => {
  const round = { phase: 'submit' as const, clue: 'a door in the rain' }

  it('lets a non-storyteller submit a clip and shows who is still missing', async () => {
    const send = vi.fn()
    render(<Game state={playingState('p4', round)} send={send} />)
    expect(screen.getByText('a door in the rain')).toBeInTheDocument()
    await userEvent.click(within(screen.getByTestId('clip-h2')).getByRole('button', { name: 'Submit' }))
    expect(send).toHaveBeenCalledWith({ type: 'submit_clip', clipId: 'h2' })
    expect(screen.getAllByText('waiting…')).toHaveLength(3)
  })

  it('shows the storyteller the submission progress', () => {
    const players = PLAYERS.map((p) => (p.playerId === 'p2' ? { ...p, hasSubmitted: true } : p))
    const state = { ...playingState('p1', round), players }
    render(<Game state={state} send={vi.fn()} />)
    expect(screen.getByText(/Waiting for the other players to submit/)).toBeInTheDocument()
    expect(screen.getAllByText('done')).toHaveLength(1)
    expect(screen.getAllByText('waiting…')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
  })

  it('marks the submitted clip and removes the submit action', () => {
    render(<Game state={playingState('p4', { ...round, yourSubmission: 'h2' })} send={vi.fn()} />)
    expect(screen.getByText(/Clip submitted/)).toBeInTheDocument()
    expect(screen.getByTestId('clip-h2')).toHaveClass('clip-card--selected')
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
  })
})

describe('Vote phase', () => {
  const round = { phase: 'vote' as const, clue: 'a door in the rain', table: TABLE, yourSubmission: 't2' }

  it('shows the shuffled table and excludes your own clip from voting', async () => {
    const send = vi.fn()
    render(<Game state={playingState('p4', round)} send={send} />)
    expect(screen.getAllByRole('button', { name: /^Play Clip/ })).toHaveLength(4)
    expect(screen.getAllByRole('button', { name: 'Vote' })).toHaveLength(3)
    const own = screen.getByTestId('clip-t2')
    expect(within(own).queryByRole('button', { name: 'Vote' })).not.toBeInTheDocument()
    expect(within(own).getByText('yours')).toBeInTheDocument()

    await userEvent.click(within(screen.getByTestId('clip-t1')).getByRole('button', { name: 'Vote' }))
    expect(send).toHaveBeenCalledWith({ type: 'vote', clipId: 't1' })
  })

  it('does not let the storyteller vote', () => {
    render(<Game state={playingState('p1', { ...round, yourSubmission: 't1' })} send={vi.fn()} />)
    expect(screen.getByText(/The others are voting/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Vote' })).not.toBeInTheDocument()
  })

  it('locks the vote once cast', () => {
    render(<Game state={playingState('p4', { ...round, yourVote: 't3' })} send={vi.fn()} />)
    expect(screen.getByText(/Vote cast/)).toBeInTheDocument()
    expect(screen.getByTestId('clip-t3')).toHaveClass('clip-card--selected')
    expect(screen.queryByRole('button', { name: 'Vote' })).not.toBeInTheDocument()
  })
})

describe('Reveal phase', () => {
  it('shows owners, votes and points, and lets anyone go to the next round', async () => {
    const send = vi.fn()
    render(<Game state={playingState('p4', REVEAL_ROUND)} send={send} />)
    const st = screen.getByTestId('clip-t1')
    expect(within(st).getByText('storyteller')).toBeInTheDocument()
    expect(within(st).getByText('Ana')).toBeInTheDocument()
    expect(within(st).getByText('You')).toBeInTheDocument()
    expect(within(screen.getByTestId('clip-t3')).getByText('none')).toBeInTheDocument()
    expect(screen.getByText('+4')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next round' }))
    expect(send).toHaveBeenCalledWith({ type: 'next_round' })
  })

  it('renders for the storyteller too', () => {
    render(<Game state={playingState('p1', { ...REVEAL_ROUND, yourSubmission: 't1', yourVote: null })} send={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Next round' })).toBeInTheDocument()
  })
})

describe('Scoreboard and end of game', () => {
  it('toggles the scoreboard during the game', async () => {
    render(<Game state={playingState('p4', { phase: 'storyteller' })} send={vi.fn()} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Scores' }))
    const table = screen.getByRole('table')
    expect(within(table).getByText('Chloé')).toBeInTheDocument()
    expect(within(table).getByText('7')).toBeInTheDocument()
  })

  it('shows final scores, the winner, Leave and Stop with no replay', () => {
    const send = vi.fn()
    render(<EndGame state={finishedState()} send={send} />)
    expect(screen.getByText('Chloé wins!')).toBeInTheDocument()
    expect(screen.getByText('winner')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New game' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('renders the hand of 6 clips', () => {
    render(<Game state={playingState('p4', { phase: 'storyteller' })} send={vi.fn()} />)
    for (const c of HAND) expect(screen.getByTestId(`clip-${c.clipId}`)).toBeInTheDocument()
  })

  it('shows offline players', () => {
    const state = lobbyState([...PLAYERS.slice(0, 3), player('p9', 'Zed', { connected: false })])
    render(<Lobby state={state} send={vi.fn()} />)
    expect(screen.getByText('offline')).toBeInTheDocument()
  })
})

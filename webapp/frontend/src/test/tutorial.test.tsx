import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { TOKEN_KEY } from '../api'
import { tutorialCue, type TutorialScreen } from '../tutorial'
import type { GameState, Round } from '../types'
import { PLAYERS, REVEAL_ROUND, finishedState, lobbyState, playingState } from './fixtures'

describe('tutorialCue', () => {
  it('chooses every screen and role-specific moment', () => {
    const cases: { screen: TutorialScreen; state: GameState | null; label: string; body: string }[] = [
      { screen: 'home', state: null, label: 'HOW TO PLAY', body: "Pick a nickname, then Quick start with AI companions, create a room, or join a friend's with their 4-letter code." },
      { screen: 'lobby', state: lobbyState(), label: 'HOW TO PLAY', body: 'Share the room code. You need 4 to 8 players, and anyone can press Start. Short on players? Add an AI companion.' },
      { screen: 'lobby', state: lobbyState(PLAYERS.concat(PLAYERS.map((p) => ({ ...p, playerId: `${p.playerId}b` })))), label: 'HOW TO PLAY', body: 'Share the room code. You need 4 to 8 players, and anyone can press Start.' },
      { screen: 'game', state: playingState('p1', { phase: 'storyteller' }), label: 'STEP 1/4', body: "You're the storyteller. Tap your clips to listen, pick one, and write a clue. Aim for a clue some players get, but not all." },
      { screen: 'game', state: playingState('p4', { phase: 'storyteller' }), label: 'STEP 1/4', body: 'The storyteller is choosing a clip and writing a clue. Listen to your hand in the meantime.' },
      { screen: 'game', state: playingState('p4', { phase: 'submit' }), label: 'STEP 2/4', body: "Pick the clip from your hand that best fits the clue. It will be shuffled in with the storyteller's." },
      { screen: 'game', state: playingState('p1', { phase: 'submit' }), label: 'STEP 2/4', body: 'Waiting for everyone to pick a clip.' },
      { screen: 'game', state: playingState('p4', { phase: 'submit', yourSubmission: 'h2' }), label: 'STEP 2/4', body: 'Waiting for everyone to pick a clip.' },
      { screen: 'game', state: playingState('p4', { phase: 'vote' }), label: 'STEP 3/4', body: "Listen to every clip and vote for the one you think is the storyteller's. You can't vote for your own." },
      { screen: 'game', state: playingState('p1', { phase: 'vote' }), label: 'STEP 3/4', body: 'Waiting for the votes. Storyteller: you want some players to find your clip, but not all.' },
      { screen: 'game', state: playingState('p4', { phase: 'vote', yourVote: 't1' }), label: 'STEP 3/4', body: 'Waiting for the votes. Storyteller: you want some players to find your clip, but not all.' },
      { screen: 'game', state: playingState('p4', REVEAL_ROUND), label: 'STEP 4/4', body: "If everyone or no one found the storyteller's clip, the storyteller scores 0 and everyone else 2. Otherwise the storyteller and each finder score 3. You also get 1 point per vote your clip received." },
      { screen: 'endGame', state: finishedState(), label: 'HOW TO PLAY', body: 'First to 10 points wins. The session is complete. Leave the room, or press Stop to close it for everyone.' },
    ]
    for (const { screen: currentScreen, state, label, body } of cases) {
      expect(tutorialCue(state, currentScreen)).toEqual(expect.objectContaining({ label, body }))
    }
    expect(tutorialCue(null, 'game')).toBeNull()
  })

  it('changes the moment key for a new round and for submission or vote', () => {
    const key = (round: Partial<Round>) => tutorialCue(playingState('p4', round), 'game')?.key
    expect(key({ phase: 'submit' })).not.toBe(key({ phase: 'submit', yourSubmission: 'h2' }))
    expect(key({ phase: 'vote' })).not.toBe(key({ phase: 'vote', yourVote: 't1' }))
    expect(key({ phase: 'reveal' })).not.toBe(tutorialCue({ ...playingState('p4', { phase: 'reveal' }), round: { ...playingState('p4', { phase: 'reveal' }).round!, number: 3 } }, 'game')?.key)
  })
})

class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  readyState = 0
  constructor() {
    FakeSocket.instances.push(this)
  }
  send() {}
  close() {}
  receive(state: GameState) {
    this.onmessage?.({ data: JSON.stringify(state) })
  }
}

const receive = (state: GameState) => act(() => FakeSocket.instances.at(-1)!.receive(state))

describe('tutorial interactions', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    localStorage.setItem(TOKEN_KEY, 'test-token')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('starts on, persists the toggle, and hides cards while off', async () => {
    const { unmount } = render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    const toggle = screen.getByRole('button', { name: 'How to play: On' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('STEP 1/4')
    await userEvent.click(toggle)
    expect(localStorage.getItem('dixvoice.tutorial')).toBe('off')
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
    unmount()

    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    expect(screen.getByRole('button', { name: 'How to play: Off' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'How to play: Off' }))
    expect(localStorage.getItem('dixvoice.tutorial')).toBe('on')
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('STEP 1/4')
  })

  it('keeps the storyteller draft when toggling or dismissing guidance', async () => {
    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    await userEvent.click(within(screen.getByTestId('clip-h1')).getByRole('button', { name: 'Pick' }))
    await userEvent.type(screen.getByLabelText('Your clue'), 'A quiet midnight train')
    await userEvent.click(screen.getByRole('button', { name: 'How to play: On' }))
    expect(screen.getByLabelText('Your clue')).toHaveValue('A quiet midnight train')
    expect(screen.getByTestId('clip-h1')).toHaveClass('clip-card--selected')
    expect(screen.getByRole('button', { name: 'Send clue' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'How to play: Off' }))
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(screen.getByLabelText('Your clue')).toHaveValue('A quiet midnight train')
    expect(screen.getByRole('button', { name: 'Send clue' })).toBeEnabled()
  })

  it('dismisses a card until the moment changes, including submitted and voted states', async () => {
    render(<App />)
    receive(playingState('p4', { phase: 'submit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
    receive(playingState('p4', { phase: 'submit' }))
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
    receive(playingState('p4', { phase: 'submit', yourSubmission: 'h2' }))
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Waiting for everyone to pick a clip.')
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    receive(playingState('p4', { phase: 'vote', table: [], yourSubmission: 'h2' }))
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('STEP 3/4')
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    receive(playingState('p4', { phase: 'vote', table: [], yourSubmission: 'h2', yourVote: 't1' }))
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Waiting for the votes.')
  })

  it('keeps the scored reveal visible until the next-round transition', async () => {
    render(<App />)
    const reveal = playingState('p4', REVEAL_ROUND)
    receive({ ...reveal, players: reveal.players.map((p) => p.playerId === 'p3' ? { ...p, score: 11 } : p) })
    expect(screen.getByRole('status', { name: 'Your round result' })).toHaveTextContent('Round win · +4')
    expect(screen.getByRole('button', { name: 'Next round' })).toBeInTheDocument()
    expect(screen.queryByText('Game over')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Next round' }))
    receive(finishedState())
    expect(screen.getByText('Game over')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New game' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('The session is complete.')
  })

  it('keeps working if tutorial storage is unavailable', async () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'dixvoice.tutorial') throw new Error('blocked')
      return get.call(this, key)
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'dixvoice.tutorial') throw new Error('blocked')
      set.call(this, key, value)
    })
    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    expect(screen.getByLabelText('How to play cue')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'How to play: On' }))
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
  })
})

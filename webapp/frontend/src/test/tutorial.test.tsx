import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { TOKEN_KEY } from '../api'
import { TOUR_SECTIONS, listNames, plainText, revealExplanation, roleBanner, tourStep, tutorialCue, visibleSections, type TourSection, type TutorialScreen } from '../tutorial'
import { TOUR_KEY } from '../useTour'
import type { GameState, Round } from '../types'
import { PLAYERS, REVEAL_ROUND, TABLE, finishedState, lobbyState, playingState } from './fixtures'

describe('tutorialCue', () => {
  it('chooses every screen and role-specific moment', () => {
    const cases: { screen: TutorialScreen; state: GameState | null; label: string; body: string }[] = [
      { screen: 'lobby', state: lobbyState(), label: 'HOW TO PLAY', body: 'Share the room code. 4 to 8 players sit at the table; anyone can press Start. Short on players? Add an AI companion.' },
      { screen: 'lobby', state: lobbyState(PLAYERS.concat(PLAYERS.map((p) => ({ ...p, playerId: `${p.playerId}b` })))), label: 'HOW TO PLAY', body: 'Share the room code. 4 to 8 players sit at the table; anyone can press Start.' },
      { screen: 'game', state: playingState('p1', { phase: 'storyteller' }), label: 'STEP 1/4', body: 'Tap your clips to listen, pick one, and write a clue for it. Aim for a clue some players get, but not all.' },
      { screen: 'game', state: playingState('p4', { phase: 'storyteller' }), label: 'STEP 1/4', body: 'Ana is choosing a clip and writing a clue. Listen to your hand in the meantime.' },
      { screen: 'game', state: playingState('p4', { phase: 'submit', clue: 'a door in the rain' }), label: 'STEP 2/4', body: "Pick the clip from your hand that best fits Ana's clue \u201ca door in the rain\u201d. It will be shuffled in with Ana's." },
      { screen: 'game', state: playingState('p1', { phase: 'submit' }), label: 'STEP 2/4', body: 'Waiting for 3 players to pick a clip. Their clips will be shuffled in with yours.' },
      { screen: 'game', state: submitted(playingState('p4', { phase: 'submit', yourSubmission: 'h2' }), ['p4', 'p2']), label: 'STEP 2/4', body: 'Waiting for 1 player to pick a clip.' },
      { screen: 'game', state: playingState('p4', { phase: 'vote', table: TABLE }), label: 'STEP 3/4', body: "Listen to the 4 clips and vote for the one you think is Ana's. You can't vote for your own." },
      { screen: 'game', state: playingState('p1', { phase: 'vote' }), label: 'STEP 3/4', body: 'Waiting for 3 players to vote. You want some of them to find your clip, but not all.' },
      { screen: 'game', state: playingState('p4', { phase: 'vote', yourVote: 't1' }), label: 'STEP 3/4', body: 'Waiting for 3 players to vote.' },
      { screen: 'game', state: playingState('p4', REVEAL_ROUND), label: 'STEP 4/4', body: 'You score +4 this round. Press Next round to keep going: first to 10 wins.' },
      { screen: 'game', state: playingState('p1', REVEAL_ROUND), label: 'STEP 4/4', body: 'You score +3 this round. Press Next round to keep going: first to 10 wins.' },
    ]
    for (const { screen: currentScreen, state, label, body } of cases) {
      expect(tutorialCue(state, currentScreen)).toEqual(expect.objectContaining({ label, body }))
    }
    expect(tutorialCue(null, 'game')).toBeNull()
    expect(tutorialCue(null, 'home')).toBeNull()
    expect(tutorialCue(finishedState(), 'endGame')).toBeNull()
  })

  it('changes the moment key for a new round and for submission or vote', () => {
    const key = (round: Partial<Round>) => tutorialCue(playingState('p4', round), 'game')?.key
    expect(key({ phase: 'submit' })).not.toBe(key({ phase: 'submit', yourSubmission: 'h2' }))
    expect(key({ phase: 'vote' })).not.toBe(key({ phase: 'vote', yourVote: 't1' }))
    expect(key({ phase: 'reveal' })).not.toBe(tutorialCue({ ...playingState('p4', { phase: 'reveal' }), round: { ...playingState('p4', { phase: 'reveal' }).round!, number: 3 } }, 'game')?.key)
  })
})

function submitted(state: GameState, ids: string[]): GameState {
  return { ...state, players: state.players.map((p) => (ids.includes(p.playerId) ? { ...p, hasSubmitted: true } : p)) }
}

function voted(state: GameState, ids: string[]): GameState {
  return { ...state, players: state.players.map((p) => (ids.includes(p.playerId) ? { ...p, hasVoted: true } : p)) }
}

describe('listNames', () => {
  it('joins names in English', () => {
    expect(listNames([])).toBe('nobody')
    expect(listNames(['Ada'])).toBe('Ada')
    expect(listNames(['Ada', 'Robo Ben'])).toBe('Ada and Robo Ben')
    expect(listNames(['Ada', 'Ben', 'Chlo\u00e9'])).toBe('Ada, Ben and Chlo\u00e9')
    expect(listNames(['Ada', 'Ben', 'Chlo\u00e9', 'Dan'])).toBe('Ada, Ben, Chlo\u00e9 and 1 other')
    expect(listNames(['Ada', 'Ben', 'Chlo\u00e9', 'Dan', 'Eve'])).toBe('Ada, Ben, Chlo\u00e9 and 2 others')
  })
})

describe('roleBanner', () => {
  const banner = (state: GameState) => {
    const b = roleBanner(state)!
    return { role: b.role, headline: plainText(b.headline), detail: b.detail }
  }

  it('is empty outside a round', () => {
    expect(roleBanner(null)).toBeNull()
    expect(roleBanner(lobbyState())).toBeNull()
  })

  it('tells the storyteller what their role means in each phase', () => {
    expect(banner(playingState('p1', { phase: 'storyteller' }))).toEqual({
      role: 'storyteller',
      headline: "You're the STORYTELLER this round.",
      detail: 'Choose a clip and give a clue. You score 3 only if some players find your clip, but not all.',
    })
    expect(banner(playingState('p1', { phase: 'submit' })).headline).toBe('Waiting for Ben, Chlo\u00e9 and Me to pick a clip.')
    expect(banner(submitted(playingState('p1', { phase: 'submit' }), ['p2'])).headline).toBe('Waiting for Chlo\u00e9 and Me to pick a clip.')
    expect(banner(voted(playingState('p1', { phase: 'vote' }), ['p2', 'p3']))).toEqual({
      role: 'storyteller',
      headline: 'Waiting for Me to vote.',
      detail: 'You score 3 only if some players find your clip, but not all.',
    })
    expect(banner(playingState('p1', REVEAL_ROUND)).headline).toBe('Round 2 is over. You were the STORYTELLER.')
  })

  it('tells a player who the storyteller is and what to do in each phase', () => {
    expect(banner(playingState('p4', { phase: 'storyteller' }))).toEqual({
      role: 'player',
      headline: "You're a PLAYER. Ana is the storyteller.",
      detail: "Match their clue with one of your clips, then find their clip among everyone's.",
    })
    expect(banner(playingState('p4', { phase: 'submit' }))).toEqual({
      role: 'player',
      headline: "You're a PLAYER. Ana is the storyteller.",
      detail: "Match Ana's clue with one of your clips. Later you'll look for theirs among everyone's.",
    })
    expect(banner(submitted(playingState('p4', { phase: 'submit', yourSubmission: 'h2' }), ['p4'])).headline).toBe('Waiting for Ben and Chlo\u00e9 to pick a clip.')
    expect(banner(playingState('p4', { phase: 'vote' })).detail).toBe("Find Ana's clip among everyone's. You can't vote for your own.")
    expect(banner(voted(playingState('p4', { phase: 'vote', yourVote: 't1' }), ['p4', 'p3'])).headline).toBe('Waiting for Ben to vote.')
    expect(banner(playingState('p4', REVEAL_ROUND)).headline).toBe('Round 2 is over. Ana was the storyteller.')
  })

  it('keeps named players as objects so the UI can badge companions', () => {
    const state = playingState('p4', { phase: 'storyteller' })
    state.players = state.players.map((p) => (p.playerId === 'p1' ? { ...p, isCompanion: true } : p))
    expect(roleBanner(state)!.headline[1]).toEqual(expect.objectContaining({ nickname: 'Ana', isCompanion: true }))
  })
})

describe('tour', () => {
  const none = new Set<TourSection>()
  const ui = { scoresOpen: false }

  it('lists the sections on each screen in order of appearance', () => {
    expect(visibleSections(null, 'home', ui)).toEqual(['nickname', 'quickstart', 'rooms'])
    expect(visibleSections(lobbyState(), 'lobby', ui)).toEqual(['roomCode', 'players', 'start'])
    expect(visibleSections(playingState('p1', { phase: 'storyteller' }), 'game', ui)).toEqual(['header', 'role', 'hand'])
    expect(visibleSections(playingState('p4', { phase: 'storyteller' }), 'game', ui)).toEqual(['header', 'role', 'hand'])
    expect(visibleSections(playingState('p1', { phase: 'submit' }), 'game', ui)).toEqual(['header', 'role', 'clue', 'table'])
    expect(visibleSections(playingState('p4', { phase: 'submit' }), 'game', ui)).toEqual(['header', 'role', 'clue', 'table', 'hand'])
    expect(visibleSections(playingState('p4', { phase: 'vote' }), 'game', ui)).toEqual(['header', 'role', 'clue', 'vote'])
    expect(visibleSections(playingState('p4', REVEAL_ROUND), 'game', ui)).toEqual(['header', 'role', 'clue', 'reveal'])
    expect(visibleSections(playingState('p4', { phase: 'reveal', reveal: null }), 'game', ui)).toEqual(['header', 'role', 'clue'])
    expect(visibleSections(playingState('p4', { phase: 'vote' }), 'game', { scoresOpen: true })).toEqual(['header', 'role', 'scores', 'clue', 'vote'])
    expect(visibleSections(finishedState(), 'endGame', ui)).toEqual(['scores'])
    expect(visibleSections(null, 'game', ui)).toEqual([])
  })

  it('explains the first visible section not yet explained, then stops', () => {
    const state = playingState('p4', { phase: 'submit', clue: 'a door in the rain' })
    expect(tourStep(state, 'game', ui, none)?.section).toBe('header')
    expect(tourStep(state, 'game', ui, new Set(['header']))?.section).toBe('role')
    expect(tourStep(state, 'game', ui, new Set(['header', 'role']))?.section).toBe('hand')
    expect(tourStep(state, 'game', ui, new Set(['header', 'role', 'hand']))?.section).toBe('clue')
    expect(tourStep(state, 'game', ui, new Set(['header', 'role', 'hand', 'clue']))?.section).toBe('table')
    expect(tourStep(state, 'game', ui, new Set(['header', 'role', 'clue', 'table', 'hand']))).toBeNull()
    expect(tourStep(state, 'game', ui, new Set(TOUR_SECTIONS))).toBeNull()
    expect(tourStep(null, 'home', ui, new Set(['nickname', 'quickstart']))?.section).toBe('rooms')
  })

  it('does not explain sections that are not on the page yet', () => {
    expect(tourStep(playingState('p1', { phase: 'storyteller' }), 'game', ui, new Set(['header', 'role']))?.section).toBe('hand')
    expect(tourStep(playingState('p1', { phase: 'storyteller' }), 'game', ui, new Set(['header', 'role', 'hand']))).toBeNull()
    expect(tourStep(playingState('p1', { phase: 'submit' }), 'game', ui, new Set(['header', 'role', 'hand']))?.section).toBe('clue')
  })

  it('writes role-specific copy with the real storyteller, clue and result', () => {
    const explained = new Set<TourSection>(['header', 'role', 'hand'])
    expect(tourStep(playingState('p4', { phase: 'submit', clue: 'a door in the rain' }), 'game', ui, explained)?.body).toBe(
      "\u201ca door in the rain\u201d is Ana's clue for one of their clips. Everyone matches it with a clip of their own.",
    )
    expect(tourStep(playingState('p1', { phase: 'submit', clue: 'a door in the rain' }), 'game', ui, explained)?.body).toBe(
      'Your clue, \u201ca door in the rain\u201d. Every player now picks the clip from their hand that best fits it.',
    )
    const beforeVote = new Set<TourSection>([...explained, 'clue', 'table'])
    expect(tourStep(playingState('p4', { phase: 'vote', table: TABLE }), 'game', ui, beforeVote)?.body).toBe(
      "All submitted clips, shuffled anonymously. Find Ana's; you can't vote for your own.",
    )
    expect(tourStep(playingState('p1', { phase: 'vote', table: TABLE }), 'game', ui, beforeVote)?.body).toBe(
      "All submitted clips, shuffled anonymously. The players are now trying to find yours among the others'.",
    )
    expect(tourStep(playingState('p4', { phase: 'storyteller' }), 'game', ui, new Set(['header', 'role']))).toEqual({
      section: 'hand',
      label: 'YOUR HAND',
      body: 'Your 6 clips are your cards. Tap one to listen. Nobody else hears your hand. Clips are 2 seconds; you get a fresh hand every round.',
    })
    expect(tourStep(finishedState(), 'endGame', ui, none)?.body).toBe('First to 10 points wins the game ("dix" means ten in French). The session is complete.')
  })

  it('explains the scoring rule on the actual result of the round', () => {
    const beforeReveal = new Set<TourSection>(['header', 'role', 'hand', 'clue', 'table', 'vote'])
    const reveal = (you: 'p1' | 'p4', voterIds: string[]) => {
      const results = REVEAL_ROUND.reveal!.results.map((r) => (r.isStoryteller ? { ...r, voterIds } : r))
      return playingState(you, { ...REVEAL_ROUND, reveal: { ...REVEAL_ROUND.reveal!, results } })
    }
    expect(revealExplanation(reveal('p4', ['p2', 'p3', 'p4']))).toBe("Everyone found Ana's clip, so Ana scores 0 and everyone else 2.")
    expect(revealExplanation(reveal('p1', ['p2', 'p3', 'p4']))).toBe('Everyone found your clip, so you score 0 and everyone else 2.')
    expect(revealExplanation(reveal('p4', []))).toBe("No one found Ana's clip, so Ana scores 0 and everyone else 2.")
    expect(revealExplanation(reveal('p4', ['p4']))).toBe("You found Ana's clip (some, but not all), so Ana and each finder score 3.")
    expect(revealExplanation(reveal('p1', ['p2', 'p4']))).toBe('Ben and Me found your clip (some, but not all), so you and each finder score 3.')
    expect(revealExplanation(playingState('p4', { phase: 'vote' }))).toBeNull()
    expect(tourStep(reveal('p4', ['p4']), 'game', ui, beforeReveal)).toEqual({
      section: 'reveal',
      label: 'REVEAL',
      body: "You found Ana's clip (some, but not all), so Ana and each finder score 3. Each clip shows its owner and who voted for it. Players also score 1 per vote their own clip received.",
    })
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
    localStorage.setItem(TOUR_KEY, JSON.stringify(TOUR_SECTIONS))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('walks the sections one at a time with Next, highlighting each anchor, then shows the cue card', async () => {
    localStorage.removeItem(TOUR_KEY)
    render(<App />)
    receive(playingState('p4', { phase: 'storyteller' }))
    const step = () => screen.getByTestId('tour-step')
    expect(step()).toHaveFocus()
    expect(step()).toHaveTextContent('TOUR · GAME HEADER')
    expect(document.querySelector('[data-tutorial="header"]')).toHaveClass('tutorial-target')
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(step()).toHaveTextContent('TOUR · YOUR ROLE')
    expect(document.querySelector('[data-tutorial="header"]')).not.toHaveClass('tutorial-target')
    expect(screen.getByTestId('role-strip')).toHaveClass('tutorial-target')

    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(step()).toHaveTextContent('Your 6 clips are your cards.')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.queryByTestId('tour-step')).not.toBeInTheDocument()
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Ana is choosing a clip')
    expect(JSON.parse(localStorage.getItem(TOUR_KEY)!)).toEqual(['header', 'role', 'hand'])

    receive(playingState('p4', { phase: 'submit', clue: 'a door in the rain' }))
    expect(step()).toHaveTextContent('TOUR · CLUE')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(step()).toHaveTextContent('TOUR · ON THE TABLE')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent("Pick the clip from your hand that best fits Ana's clue")
  })

  it('skips the whole tour with the button or Escape, and Replay tour brings it back', async () => {
    localStorage.removeItem(TOUR_KEY)
    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    expect(screen.getByTestId('tour-step')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('tour-step')).not.toBeInTheDocument()
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Tap your clips to listen')
    expect(new Set(JSON.parse(localStorage.getItem(TOUR_KEY)!))).toEqual(new Set(TOUR_SECTIONS))

    await userEvent.click(screen.getByRole('button', { name: 'Replay tour' }))
    expect(localStorage.getItem(TOUR_KEY)).toBe('[]')
    expect(screen.getByTestId('tour-step')).toHaveTextContent('TOUR · GAME HEADER')
    await userEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(screen.queryByTestId('tour-step')).not.toBeInTheDocument()
  })

  it('shows the full role banner while the tutorial is on and only the first sentence when off', async () => {
    render(<App />)
    receive(playingState('p4', { phase: 'storyteller' }))
    const strip = screen.getByTestId('role-strip')
    expect(strip).toHaveTextContent("You're a PLAYER. Ana is the storyteller. Match their clue with one of your clips, then find their clip among everyone's.")
    await userEvent.click(screen.getByRole('button', { name: 'Help: on' }))
    expect(screen.getByTestId('role-strip')).toHaveTextContent("You're a PLAYER. Ana is the storyteller.")
    expect(screen.getByTestId('role-strip')).not.toHaveTextContent('Match their clue')
    expect(screen.queryByTestId('tour-step')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replay tour' })).not.toBeInTheDocument()
    receive(playingState('p1', { phase: 'vote' }))
    expect(screen.getByTestId('role-strip')).toHaveTextContent('Waiting for Ben, Chloé and Me to vote.')
  })

  it('tours the home and lobby sections', async () => {
    localStorage.removeItem(TOUR_KEY)
    localStorage.removeItem(TOKEN_KEY)
    render(<App />)
    expect(screen.getByTestId('tour-step')).toHaveTextContent('TOUR · NICKNAME')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('tour-step')).toHaveTextContent('a solo game against 3 AI companions')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('tour-step')).toHaveTextContent('TOUR · PLAY WITH FRIENDS')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.queryByTestId('tour-step')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
  })

  it('starts on, persists the toggle, and hides cards while off', async () => {
    const { unmount } = render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    const toggle = screen.getByRole('button', { name: 'Help: on' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Tap your clips to listen')
    await userEvent.click(toggle)
    expect(localStorage.getItem('dixvoice.tutorial')).toBe('off')
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
    unmount()

    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    expect(screen.getByRole('button', { name: 'Help: off' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Help: off' }))
    expect(localStorage.getItem('dixvoice.tutorial')).toBe('on')
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Tap your clips to listen')
  })

  it('keeps the storyteller draft when toggling or dismissing guidance', async () => {
    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    await userEvent.click(within(screen.getByTestId('clip-h1')).getByRole('button', { name: 'Pick' }))
    await userEvent.type(screen.getByLabelText('Your clue'), 'A quiet midnight train')
    await userEvent.click(screen.getByRole('button', { name: 'Help: on' }))
    expect(screen.getByLabelText('Your clue')).toHaveValue('A quiet midnight train')
    expect(screen.getByTestId('clip-h1')).toHaveClass('clip-card--selected')
    expect(screen.getByRole('button', { name: 'Send clue' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Help: off' }))
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
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Waiting for 3 players to pick a clip.')
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    receive(playingState('p4', { phase: 'vote', table: [], yourSubmission: 'h2' }))
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent("vote for the one you think is Ana's")
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    receive(playingState('p4', { phase: 'vote', table: [], yourSubmission: 'h2', yourVote: 't1' }))
    expect(screen.getByLabelText('How to play cue')).toHaveTextContent('Waiting for 3 players to vote.')
  })

  it('keeps the scored reveal visible until the next-round transition', async () => {
    render(<App />)
    const reveal = playingState('p4', REVEAL_ROUND)
    receive({ ...reveal, players: reveal.players.map((p) => p.playerId === 'p3' ? { ...p, score: 11 } : p) })
    expect(screen.getByRole('status', { name: 'Round result' })).toHaveTextContent('You score 4')
    expect(screen.getByRole('button', { name: 'See final scores' })).toBeInTheDocument()
    expect(screen.queryByText('Game over')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'See final scores' }))
    receive(finishedState())
    expect(screen.getByText('Game over')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New game' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
  })

  it('keeps working if tutorial storage is unavailable', async () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.startsWith('dixvoice.tutorial')) throw new Error('blocked')
      return get.call(this, key)
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('dixvoice.tutorial')) throw new Error('blocked')
      set.call(this, key, value)
    })
    render(<App />)
    receive(playingState('p1', { phase: 'storyteller' }))
    expect(screen.getByTestId('tour-step')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(screen.getByLabelText('How to play cue')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Help: on' }))
    expect(screen.queryByLabelText('How to play cue')).not.toBeInTheDocument()
  })
})

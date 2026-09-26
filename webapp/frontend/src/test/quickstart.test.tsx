import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { QUICK_START_TIMEOUT_MS } from '../useQuickStart'
import { COMPANION, PLAYERS, lobbyState, player } from './fixtures'

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  url: string
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  types() {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type)
  }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]
const me = PLAYERS[3]
const companions = ['p5', 'p6', 'p7'].map((id, i) => player(id, `Robo ${i}`, { isCompanion: true }))
const withCompanions = (n: number) => lobbyState([me, ...companions.slice(0, n)])

function stubCreateRoom() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ roomCode: 'KXQP', playerId: 'p4', token: 'tok-q' }),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function quickStartIntoLobby(user: ReturnType<typeof userEvent.setup>) {
  const fetchMock = stubCreateRoom()
  render(<App />)
  await user.type(screen.getByLabelText('Nickname'), 'Me')
  await user.click(screen.getByRole('button', { name: 'Quick start' }))
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/rooms$/), expect.objectContaining({ method: 'POST', body: JSON.stringify({ nickname: 'Me' }) }))
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
  act(() => {
    last().open()
    last().receive(withCompanions(0))
  })
  return last()
}

describe('Quick start', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('is the first action on Home and is disabled until a nickname is entered', async () => {
    render(<App />)
    const buttons = within(screen.getByRole('main')).getAllByRole('button')
    expect(buttons[0]).toHaveTextContent('Quick start')
    expect(buttons[0]).toHaveClass('btn--primary')
    expect(buttons[0]).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Nickname'), '   ')
    expect(buttons[0]).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Nickname'), 'Me')
    expect(buttons[0]).toBeEnabled()
  })

  it('adds 3 companions one at a time, then starts the game exactly once', async () => {
    const ws = await quickStartIntoLobby(userEvent.setup())
    expect(ws.types()).toEqual(['add_companion'])
    expect(screen.getByTestId('quick-progress')).toHaveTextContent('Adding companions… 0/3')
    expect(screen.getByRole('button', { name: 'Add AI companion' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled()

    act(() => ws.receive(withCompanions(0)))
    expect(ws.types()).toEqual(['add_companion'])

    act(() => ws.receive(withCompanions(1)))
    expect(ws.types()).toEqual(['add_companion', 'add_companion'])
    expect(screen.getByTestId('quick-progress')).toHaveTextContent('Adding companions… 1/3')

    act(() => ws.receive(withCompanions(2)))
    expect(ws.types()).toEqual(['add_companion', 'add_companion', 'add_companion'])
    expect(screen.getByTestId('quick-progress')).toHaveTextContent('Adding companions… 2/3')

    act(() => ws.receive(withCompanions(3)))
    expect(ws.types()).toEqual(['add_companion', 'add_companion', 'add_companion', 'start_game'])
    expect(screen.getByTestId('quick-progress')).toHaveTextContent('Starting…')
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled()

    act(() => ws.receive(withCompanions(3)))
    expect(ws.types().filter((t) => t === 'start_game')).toHaveLength(1)

    act(() => ws.receive({ ...withCompanions(3), room: { code: 'KXQP', status: 'playing', targetScore: 10 } }))
    expect(screen.queryByTestId('quick-progress')).not.toBeInTheDocument()
  })

  it('stops and shows an error on companion_unavailable, leaving the lobby usable', async () => {
    const user = userEvent.setup()
    const ws = await quickStartIntoLobby(user)
    act(() => ws.receive({ type: 'error', code: 'companion_unavailable', message: 'down' }))
    expect(screen.queryByTestId('quick-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('quick-failed')).toHaveTextContent(/Quick start stopped/)
    expect(screen.getAllByRole('alert').some((el) => /AI companions are unavailable/.test(el.textContent ?? ''))).toBe(true)
    expect(screen.getByTestId('room-code')).toHaveTextContent('KXQP')
    expect(screen.getByRole('button', { name: 'Add AI companion' })).toBeEnabled()

    act(() => ws.receive(withCompanions(3)))
    expect(ws.types()).toEqual(['add_companion'])
    expect(screen.getByRole('button', { name: 'Start game' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Add AI companion' }))
    expect(ws.types()).toEqual(['add_companion', 'add_companion'])
  })

  it('gives up after the timeout when companions do not join', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ws = await quickStartIntoLobby(userEvent.setup({ advanceTimers: vi.advanceTimersByTime }))
    act(() => ws.receive(withCompanions(1)))
    expect(ws.types()).toEqual(['add_companion', 'add_companion'])
    act(() => {
      vi.advanceTimersByTime(QUICK_START_TIMEOUT_MS - 1000)
    })
    expect(screen.getByTestId('quick-progress')).toHaveTextContent('Adding companions… 1/3')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByTestId('quick-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('quick-failed')).toHaveTextContent(/did not join in time/)
    expect(screen.getByRole('button', { name: 'Add AI companion' })).toBeEnabled()
    act(() => ws.receive(withCompanions(3)))
    expect(ws.types()).toEqual(['add_companion', 'add_companion'])
  })

  it('does not run the sequence for the normal Create a room flow', async () => {
    stubCreateRoom()
    render(<App />)
    await userEvent.type(screen.getByLabelText('Nickname'), 'Me')
    await userEvent.click(screen.getByRole('button', { name: 'Create a room' }))
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    act(() => {
      last().open()
      last().receive(lobbyState([me, COMPANION]))
    })
    expect(last().sent).toEqual([])
    expect(screen.queryByTestId('quick-progress')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add AI companion' })).toBeEnabled()
  })
})

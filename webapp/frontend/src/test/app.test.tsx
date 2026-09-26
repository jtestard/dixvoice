import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { TOKEN_KEY } from '../api'
import { lobbyState } from './fixtures'

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
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]

describe('App', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows Home without a token and joins a room via the HTTP API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ roomCode: 'KXQP', playerId: 'p4', token: 'tok-1' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await userEvent.type(screen.getByLabelText('Nickname'), 'Me')
    await userEvent.type(screen.getByLabelText('Room code'), 'kxqp')
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/rooms\/KXQP\/join$/), expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-1'))
    expect(last().url).toMatch(/^ws:\/\/.*\/ws\?token=tok-1$/)
    act(() => {
      last().open()
      last().receive(lobbyState())
    })
    expect(await screen.findByTestId('room-code')).toHaveTextContent('KXQP')
  })

  it('shows join errors clearly, including "no more room"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'room_full', message: 'Room full' }) }),
    )
    render(<App />)
    await userEvent.type(screen.getByLabelText('Nickname'), 'Me')
    await userEvent.type(screen.getByLabelText('Room code'), 'KXQP')
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No more room/)
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('reconnects with the stored token and shows server error messages', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-2')
    render(<App />)
    expect(screen.getByText('Connecting…')).toBeInTheDocument()
    act(() => {
      last().open()
      last().receive(lobbyState())
    })
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled()
    act(() => last().receive({ type: 'error', code: 'not_enough_players', message: 'nope' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/At least 4 players/)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns to Home and clears the token on room_closed', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-3')
    render(<App />)
    act(() => {
      last().open()
      last().receive(lobbyState())
    })
    expect(screen.getByTestId('room-code')).toHaveTextContent('KXQP')
    act(() => {
      last().receive({ type: 'room_closed', reason: 'stopped' })
      last().close()
    })
    expect(await screen.findByLabelText('Nickname')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/room was stopped/)
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('reconnects automatically after the socket drops', async () => {
    vi.useFakeTimers()
    localStorage.setItem(TOKEN_KEY, 'tok-4')
    render(<App />)
    act(() => {
      last().open()
      last().receive(lobbyState())
    })
    const first = last()
    act(() => first.close(1006, ''))
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(FakeSocket.instances).toHaveLength(2)
    expect(last()).not.toBe(first)
    act(() => {
      last().open()
      last().receive(lobbyState())
    })
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument()
  })
})

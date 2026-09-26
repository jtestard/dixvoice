import type { JoinResponse } from './types'

export const BACKEND_URL: string = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080').replace(/\/$/, '')

export const TOKEN_KEY = 'dixvoice.token'

export class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export const ERROR_TEXT: Record<string, string> = {
  room_not_found: 'Unknown room code.',
  room_full: 'No more room: this room already has 8 players.',
  game_started: 'This game has already started.',
  invalid_nickname: 'Please enter a valid nickname.',
  invalid_phase: 'That action is not allowed right now.',
  not_your_turn: 'It is not your turn.',
  clip_not_in_hand: 'That clip is not in your hand.',
  already_submitted: 'You already submitted.',
  cannot_vote_own: 'You cannot vote for your own clip.',
  not_enough_players: 'At least 4 players are needed to start.',
  not_a_companion: 'That player is not an AI companion.',
  companion_unavailable: 'AI companions are unavailable right now. Please try again later.',
  invalid_sound: 'Write a text of 1 to 100 characters and an emotion of 1 to 30.',
  custom_slot_busy: 'You already created a sound this round.',
  network: 'Could not reach the server.',
}

export function errorText(code: string, message?: string): string {
  return ERROR_TEXT[code] ?? message ?? `Error: ${code}`
}

async function post(path: string, body: unknown): Promise<JoinResponse> {
  let res: Response
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('network', ERROR_TEXT.network)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = (data ?? {}) as { code?: string; error?: string; message?: string }
    const code = err.code ?? err.error ?? `http_${res.status}`
    throw new ApiError(code, errorText(code, err.message))
  }
  return data as JoinResponse
}

export function createRoom(nickname: string): Promise<JoinResponse> {
  return post('/rooms', { nickname })
}

export function joinRoom(code: string, nickname: string): Promise<JoinResponse> {
  return post(`/rooms/${encodeURIComponent(code)}/join`, { nickname })
}

export function wsUrl(token: string): string {
  const base = BACKEND_URL.replace(/^http/, 'ws')
  return `${base}/ws?token=${encodeURIComponent(token)}`
}

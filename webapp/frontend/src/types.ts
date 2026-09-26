export type RoomStatus = 'lobby' | 'playing' | 'finished'
export type Phase = 'storyteller' | 'submit' | 'vote' | 'reveal'

export interface Clip {
  clipId: string
  clipUrl: string
  text: string
  emotion: string
  voiceId: string
}

export interface Player {
  playerId: string
  nickname: string
  connected: boolean
  score: number
  isStoryteller: boolean
  hasSubmitted: boolean
  hasVoted: boolean
  isCompanion: boolean
}

export interface RevealResult {
  clipId: string
  ownerId: string
  isStoryteller: boolean
  voterIds: string[]
}

export interface Reveal {
  results: RevealResult[]
  points: Record<string, number>
}

export interface Round {
  number: number
  phase: Phase
  storytellerId: string
  clue: string | null
  yourSubmission: string | null
  yourVote: string | null
  table: Clip[]
  reveal: Reveal | null
}

export interface GameState {
  type: 'state'
  room: { code: string; status: RoomStatus; targetScore: number }
  you: { playerId: string; hand: Clip[] }
  players: Player[]
  round: Round | null
  winnerIds: string[]
}

export interface ErrorMessage {
  type: 'error'
  code: string
  message: string
}

export interface RoomClosedMessage {
  type: 'room_closed'
  reason: string
}

export type ServerMessage = GameState | ErrorMessage | RoomClosedMessage

export type ClientMessage =
  | { type: 'start_game' }
  | { type: 'stop_game' }
  | { type: 'leave_room' }
  | { type: 'add_companion' }
  | { type: 'remove_companion'; playerId: string }
  | { type: 'next_round' }
  | { type: 'submit_clue'; clipId: string; clue: string }
  | { type: 'submit_clip'; clipId: string }
  | { type: 'vote'; clipId: string }

export interface JoinResponse {
  roomCode: string
  playerId: string
  token: string
}

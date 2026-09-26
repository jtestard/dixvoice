import type { Clip, GameState, Player, Round } from '../types'

export const clip = (id: string): Clip => ({
  clipId: id,
  clipUrl: `https://cdn.example.com/audio/${id}.mp3`,
  text: `SECRET-TEXT-${id}`,
  emotion: `SECRET-EMOTION-${id}`,
  voiceId: `SECRET-VOICE-${id}`,
})

export const HAND = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(clip)
export const TABLE = ['t1', 't2', 't3', 't4'].map(clip)

export function player(id: string, nickname: string, extra: Partial<Player> = {}): Player {
  return { playerId: id, nickname, connected: true, score: 0, isStoryteller: false, hasSubmitted: false, hasVoted: false, isCompanion: false, ...extra }
}

export const PLAYERS: Player[] = [
  player('p1', 'Ana', { isStoryteller: true, score: 5 }),
  player('p2', 'Ben', { score: 3 }),
  player('p3', 'Chloé', { score: 7 }),
  player('p4', 'Me', { score: 4 }),
]

export const COMPANION = player('p5', 'Robo Ada', { isCompanion: true })

export function lobbyState(players: Player[] = PLAYERS.slice(0, 3)): GameState {
  return {
    type: 'state',
    room: { code: 'KXQP', status: 'lobby', targetScore: 10 },
    you: { playerId: 'p4', hand: [] },
    players: players.map((p) => ({ ...p, isStoryteller: false, score: 0 })),
    round: null,
    winnerIds: [],
  }
}

export function playingState(you: 'p1' | 'p4', round: Partial<Round>): GameState {
  return {
    type: 'state',
    room: { code: 'KXQP', status: 'playing', targetScore: 10 },
    you: { playerId: you, hand: HAND },
    players: PLAYERS,
    round: {
      number: 2,
      phase: 'storyteller',
      storytellerId: 'p1',
      clue: null,
      yourSubmission: null,
      yourVote: null,
      table: [],
      reveal: null,
      ...round,
    },
    winnerIds: [],
  }
}

export const REVEAL_ROUND: Partial<Round> = {
  phase: 'reveal',
  clue: 'a door in the rain',
  table: TABLE,
  yourSubmission: 't2',
  yourVote: 't1',
  reveal: {
    results: [
      { clipId: 't1', ownerId: 'p1', isStoryteller: true, voterIds: ['p4'] },
      { clipId: 't2', ownerId: 'p4', isStoryteller: false, voterIds: ['p2'] },
      { clipId: 't3', ownerId: 'p2', isStoryteller: false, voterIds: [] },
      { clipId: 't4', ownerId: 'p3', isStoryteller: false, voterIds: ['p3'] },
    ],
    points: { p1: 3, p2: 0, p3: 0, p4: 4 },
  },
}

export function finishedState(): GameState {
  return {
    type: 'state',
    room: { code: 'KXQP', status: 'finished', targetScore: 10 },
    you: { playerId: 'p4', hand: [] },
    players: PLAYERS.map((p) => ({ ...p, isStoryteller: false, score: p.playerId === 'p3' ? 11 : p.score })),
    round: null,
    winnerIds: ['p3'],
  }
}

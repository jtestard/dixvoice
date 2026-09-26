import type { GameState } from './types'

export type TutorialScreen = 'home' | 'lobby' | 'game' | 'endGame'

export interface TutorialCue {
  key: string
  label: string
  body: string
}

export function tutorialCue(state: GameState | null, screen: TutorialScreen): TutorialCue | null {
  // Home explains itself (table illustration + 4 steps); the end screen needs no cue.
  if (screen === 'home' || screen === 'endGame' || !state) return null

  const room = state.room.code
  if (screen === 'lobby') {
    return {
      key: `${room}:lobby`,
      label: 'HOW TO PLAY',
      body: `Share the room code. 4 to 8 players sit at the table; anyone can press Start.${
        state.players.length < 4 ? ' Short on players? Add an AI companion.' : ''
      }`,
    }
  }

  const round = state.round
  if (!round) return null
  const storyteller = round.storytellerId === state.you.playerId
  const moment = `${room}:${round.number}:${round.phase}`

  switch (round.phase) {
    case 'storyteller':
      return {
        key: `${moment}:${storyteller ? 'storyteller' : 'player'}`,
        label: 'STEP 1/4',
        body: storyteller
          ? "You're the storyteller: tap clips to listen, pick one and write a clue some players will get, but not all."
          : 'The storyteller is picking a clip and writing a clue. Listen to your hand meanwhile.',
      }
    case 'submit': {
      const waiting = storyteller || round.yourSubmission !== null
      return {
        key: `${moment}:${waiting ? 'waiting' : 'pick'}`,
        label: 'STEP 2/4',
        body: waiting ? 'Everyone puts a clip face down on the table.' : "Pick the clip from your hand that best fits the clue. It's shuffled in with the storyteller's.",
      }
    }
    case 'vote': {
      const waiting = storyteller || round.yourVote !== null
      return {
        key: `${moment}:${waiting ? 'waiting' : 'vote'}`,
        label: 'STEP 3/4',
        body: waiting ? 'Waiting for the votes.' : "Listen to every clip and vote for the storyteller's. Not your own.",
      }
    }
    case 'reveal':
      return {
        key: moment,
        label: 'STEP 4/4',
        body: "The green clip is the storyteller's. Finders and storyteller score 3; if everyone or no one found it, others get 2. +1 per vote on your clip.",
      }
  }
}

import type { GameState } from './types'

export type TutorialScreen = 'home' | 'lobby' | 'game' | 'endGame'

export interface TutorialCue {
  key: string
  label: string
  body: string
}

export function tutorialCue(state: GameState | null, screen: TutorialScreen): TutorialCue | null {
  if (screen === 'home') {
    return {
      key: 'home',
      label: 'HOW TO PLAY',
      body: "Pick a nickname, then create a room or join a friend's with their 4-letter code.",
    }
  }
  if (!state) return null

  const room = state.room.code
  if (screen === 'lobby') {
    return {
      key: `${room}:lobby`,
      label: 'HOW TO PLAY',
      body: `Share the room code. You need 4 to 8 players, and anyone can press Start.${
        state.players.length < 8 ? ' Short on players? Add an AI companion.' : ''
      }`,
    }
  }
  if (screen === 'endGame') {
    return {
      key: `${room}:endGame`,
      label: 'HOW TO PLAY',
      body: 'First to 10 points wins. The session is complete. Leave the room, or press Stop to close it for everyone.',
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
          ? "You're the storyteller. Tap your clips to listen, pick one, and write a clue. Aim for a clue some players get, but not all."
          : 'The storyteller is choosing a clip and writing a clue. Listen to your hand in the meantime.',
      }
    case 'submit': {
      const waiting = storyteller || round.yourSubmission !== null
      return {
        key: `${moment}:${waiting ? 'waiting' : 'pick'}`,
        label: 'STEP 2/4',
        body: waiting
          ? 'Waiting for everyone to pick a clip.'
          : "Pick the clip from your hand that best fits the clue. It will be shuffled in with the storyteller's.",
      }
    }
    case 'vote': {
      const waiting = storyteller || round.yourVote !== null
      return {
        key: `${moment}:${waiting ? 'waiting' : 'vote'}`,
        label: 'STEP 3/4',
        body: waiting
          ? 'Waiting for the votes. Storyteller: you want some players to find your clip, but not all.'
          : "Listen to every clip and vote for the one you think is the storyteller's. You can't vote for your own.",
      }
    }
    case 'reveal':
      return {
        key: moment,
        label: 'STEP 4/4',
        body: "If everyone or no one found the storyteller's clip, the storyteller scores 0 and everyone else 2. Otherwise the storyteller and each finder score 3. You also get 1 point per vote your clip received.",
      }
  }
}

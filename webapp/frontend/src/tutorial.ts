import type { GameState, Player } from './types'

export type TutorialScreen = 'home' | 'lobby' | 'game' | 'endGame'

export const TARGET_SCORE = 10

/** Text with the named players kept as objects, so the UI can render them with their bot badge. */
export type RichText = (string | Player)[]

export const plainText = (parts: RichText) => parts.map((p) => (typeof p === 'string' ? p : p.nickname)).join('')

/** Joins items as "Ada", "Ada and Ben", "Ada, Ben and Chloé", "Ada, Ben, Chloé and 2 others". */
export function joinList<T>(items: T[], max = 3): (T | string)[] {
  if (items.length === 0) return ['nobody']
  if (items.length === 1) return [items[0]]
  const shown = items.length <= max ? items : items.slice(0, max)
  const out: (T | string)[] = []
  shown.forEach((item, i) => {
    if (i > 0) out.push(i === shown.length - 1 && items.length <= max ? ' and ' : ', ')
    out.push(item)
  })
  if (items.length > max) {
    const rest = items.length - max
    out.push(` and ${rest} other${rest > 1 ? 's' : ''}`)
  }
  return out
}

export const listNames = (names: string[], max = 3) => joinList(names, max).join('')

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function waitingOn(state: GameState, phase: 'submit' | 'vote'): Player[] {
  return state.players.filter((p) => !p.isStoryteller && (phase === 'submit' ? !p.hasSubmitted : !p.hasVoted))
}

// ---------------------------------------------------------------------------------------------------------------------
// Role banner
// ---------------------------------------------------------------------------------------------------------------------

export interface RoleBanner {
  role: 'storyteller' | 'player'
  /** First sentence, shown even when the tutorial is off. */
  headline: RichText
  /** What the role means for you right now, shown while the tutorial is on. */
  detail: string
}

export function roleBanner(state: GameState | null): RoleBanner | null {
  const round = state?.round
  if (!state || !round) return null
  const you = state.you.playerId
  const isStoryteller = round.storytellerId === you
  const st: string | Player = state.players.find((p) => p.playerId === round.storytellerId) ?? 'The storyteller'
  const name = typeof st === 'string' ? st : st.nickname
  const role = isStoryteller ? 'storyteller' : 'player'
  const player = (detail: string): RoleBanner => ({ role, headline: ["You're a PLAYER. ", st, ' is the storyteller.'], detail })

  switch (round.phase) {
    case 'storyteller':
      return isStoryteller
        ? {
            role,
            headline: ["You're the STORYTELLER this round."],
            detail: 'Choose a clip and give a clue. You score 3 only if some players find your clip, but not all.',
          }
        : player("Match their clue with one of your clips, then find their clip among everyone's.")
    case 'submit': {
      if (!isStoryteller && round.yourSubmission === null) {
        return player(`Match ${name}'s clue with one of your clips. Later you'll look for theirs among everyone's.`)
      }
      return {
        role,
        headline: ['Waiting for ', ...joinList(waitingOn(state, 'submit')), ' to pick a clip.'],
        detail: isStoryteller
          ? 'Every player is matching your clue with one clip from their hand.'
          : `Your clip is in. Once everyone has picked, you'll look for ${name}'s clip among all of them.`,
      }
    }
    case 'vote': {
      if (!isStoryteller && round.yourVote === null) {
        return player(`Find ${name}'s clip among everyone's. You can't vote for your own.`)
      }
      return {
        role,
        headline: ['Waiting for ', ...joinList(waitingOn(state, 'vote')), ' to vote.'],
        detail: isStoryteller
          ? 'You score 3 only if some players find your clip, but not all.'
          : `Your vote is in. You score 3 if you found ${name}'s clip, plus 1 per vote on yours.`,
      }
    }
    case 'reveal':
      return {
        role,
        headline: isStoryteller ? [`Round ${round.number} is over. You were the STORYTELLER.`] : [`Round ${round.number} is over. `, st, ' was the storyteller.'],
        detail: 'See who found the clip and the points won, then press Next round.',
      }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Progressive tour of the page sections
// ---------------------------------------------------------------------------------------------------------------------

export const TOUR_SECTIONS = [
  'nickname',
  'quickstart',
  'rooms',
  'roomCode',
  'players',
  'start',
  'header',
  'role',
  'hand',
  'clue',
  'table',
  'vote',
  'reveal',
  'scores',
] as const

export type TourSection = (typeof TOUR_SECTIONS)[number]

export interface TourStep {
  section: TourSection
  label: string
  body: string
}

export interface TourUi {
  /** The scoreboard panel is open in the game header. */
  scoresOpen: boolean
}

/** Sections currently rendered on the page, as a pure function of the app state. */
export function visibleSections(state: GameState | null, screen: TutorialScreen, ui: TourUi): TourSection[] {
  if (screen === 'home') return ['nickname', 'quickstart', 'rooms']
  if (!state) return []
  if (screen === 'lobby') return ['roomCode', 'players', 'start']
  if (screen === 'endGame') return ['scores']

  const round = state.round
  if (!round) return []
  const isStoryteller = round.storytellerId === state.you.playerId
  const sections: TourSection[] = ['header', 'role']
  if (ui.scoresOpen) sections.push('scores')
  switch (round.phase) {
    case 'storyteller':
      sections.push('hand')
      break
    case 'submit':
      sections.push('clue', 'table')
      if (!isStoryteller) sections.push('hand')
      break
    case 'vote':
      sections.push('clue', 'vote')
      break
    case 'reveal':
      sections.push('clue')
      if (round.reveal) sections.push('reveal')
      break
  }
  return sections
}

/** How the scoring rule applied to this round, e.g. "Everyone found Ada's clip, so Ada scores 0 and everyone else 2." */
export function revealExplanation(state: GameState): string | null {
  const round = state.round
  const reveal = round?.reveal
  if (!round || !reveal) return null
  const storytellerClip = reveal.results.find((r) => r.isStoryteller)
  if (!storytellerClip) return null
  const you = state.you.playerId
  const isStoryteller = round.storytellerId === you
  const storyteller = isStoryteller ? 'you' : (state.players.find((p) => p.playerId === round.storytellerId)?.nickname ?? 'the storyteller')
  const byId = new Map(state.players.map((p) => [p.playerId, p.nickname]))
  const finders = storytellerClip.voterIds
  const others = state.players.length - 1
  const whose = isStoryteller ? 'your' : `${storyteller}'s`
  const st = isStoryteller ? 'you' : storyteller
  const stScore = (n: number) => (isStoryteller ? `you score ${n}` : `${storyteller} scores ${n}`)

  if (finders.length === 0) return `No one found ${whose} clip, so ${stScore(0)} and everyone else 2.`
  if (finders.length === others) return `Everyone found ${whose} clip, so ${stScore(0)} and everyone else 2.`
  const names = listNames(finders.map((id) => (id === you ? 'you' : (byId.get(id) ?? id))))
  return `${names.charAt(0).toUpperCase()}${names.slice(1)} found ${whose} clip (some, but not all), so ${st} and each finder score 3.`
}

const CLIP_LEN = '2 seconds'

function tourStepFor(section: TourSection, state: GameState | null, screen: TutorialScreen): TourStep {
  const round = state?.round ?? null
  const isStoryteller = !!round && round.storytellerId === state?.you.playerId
  const storyteller = state?.players.find((p) => p.playerId === round?.storytellerId)?.nickname ?? 'the storyteller'
  const step = (label: string, body: string): TourStep => ({ section, label, body })

  switch (section) {
    case 'nickname':
      return step('NICKNAME', "This is how the other players will see you. It's remembered on this device.")
    case 'quickstart':
      return step('QUICK START', 'One tap starts a solo game against 3 AI companions. The best way to learn the game.')
    case 'rooms':
      return step('PLAY WITH FRIENDS', "Create a room and share its code, or join a friend's room with the code they sent you.")
    case 'roomCode':
      return step('ROOM CODE', 'Share this code to invite friends: they type it on the Home screen to join you.')
    case 'players':
      return step('PLAYERS', 'Everyone in the room. You need 4 to 8 players; AI companions are marked as bots.')
    case 'start':
      return step('START', 'Anyone can press Start once there are at least 4 players.')
    case 'header':
      return step('GAME HEADER', 'The round number and phase, the Help toggle for these tips, and the Scores button.')
    case 'role':
      return step('YOUR ROLE', 'This strip says who you are this round and what that means for you. It updates as the round moves on.')
    case 'hand':
      return step(
        'YOUR HAND',
        `Your clips are your cards: 5 dealt, plus a slot where you can create your own sound. Tap one to listen. Nobody else hears your hand. Clips are ${CLIP_LEN}; you get a fresh hand every round.`,
      )
    case 'clue': {
      const clue = round?.clue ? `“${round.clue}”` : 'the clue'
      return step(
        'CLUE',
        isStoryteller
          ? `Your clue, ${clue}. Every player now picks the clip from their hand that best fits it.`
          : `${clue} is ${storyteller}'s clue for one of their clips. Everyone matches it with a clip of their own.`,
      )
    }
    case 'table':
      return step('ON THE TABLE', "The clips submitted so far, face down. Below, the player list shows who's done and who we're waiting for.")
    case 'vote':
      return step(
        'VOTE',
        isStoryteller
          ? "All submitted clips, shuffled anonymously. The players are now trying to find yours among the others'."
          : `All submitted clips, shuffled anonymously. Find ${storyteller}'s; you can't vote for your own.`,
      )
    case 'reveal': {
      const rule = state ? revealExplanation(state) : null
      return step(
        'REVEAL',
        `${rule ? `${rule} ` : ''}Each clip shows its owner and who voted for it. Players also score 1 per vote their own clip received.`,
      )
    }
    case 'scores':
      return step('SCORE TRACK', `First to ${TARGET_SCORE} points wins the game ("dix" means ten in French).${screen === 'endGame' ? ' The session is complete.' : ''}`)
  }
}

/**
 * The next section to explain: the first one, in order of appearance, that is on the page and hasn't been explained
 * yet. `null` when the tour has nothing to say for this moment.
 */
export function tourStep(state: GameState | null, screen: TutorialScreen, ui: TourUi, explained: ReadonlySet<TourSection>): TourStep | null {
  const visible = new Set(visibleSections(state, screen, ui))
  const next = TOUR_SECTIONS.find((s) => visible.has(s) && !explained.has(s))
  return next ? tourStepFor(next, state, screen) : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-moment cue card
// ---------------------------------------------------------------------------------------------------------------------

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
  const you = state.you.playerId
  const isStoryteller = round.storytellerId === you
  const storyteller = state.players.find((p) => p.playerId === round.storytellerId)?.nickname ?? 'the storyteller'
  const moment = `${room}:${round.number}:${round.phase}`

  switch (round.phase) {
    case 'storyteller':
      return {
        key: `${moment}:${isStoryteller ? 'storyteller' : 'player'}`,
        label: 'STEP 1/4',
        body: isStoryteller
          ? 'Tap your clips to listen, pick one, and write a clue for it. Aim for a clue some players get, but not all.'
          : `${storyteller} is choosing a clip and writing a clue. Listen to your hand in the meantime.`,
      }
    case 'submit': {
      const waiting = isStoryteller || round.yourSubmission !== null
      const pending = waitingOn(state, 'submit').length
      return {
        key: `${moment}:${waiting ? 'waiting' : 'pick'}`,
        label: 'STEP 2/4',
        body: waiting
          ? `Waiting for ${plural(pending, 'player')} to pick a clip.${isStoryteller ? ' Their clips will be shuffled in with yours.' : ''}`
          : `Pick the clip from your hand that best fits ${storyteller}'s clue${round.clue ? ` “${round.clue}”` : ''}. It will be shuffled in with ${storyteller}'s.`,
      }
    }
    case 'vote': {
      const waiting = isStoryteller || round.yourVote !== null
      const pending = waitingOn(state, 'vote').length
      return {
        key: `${moment}:${waiting ? 'waiting' : 'vote'}`,
        label: 'STEP 3/4',
        body: waiting
          ? `Waiting for ${plural(pending, 'player')} to vote.${isStoryteller ? ' You want some of them to find your clip, but not all.' : ''}`
          : `Listen to the ${round.table.length} clips and vote for the one you think is ${storyteller}'s. You can't vote for your own.`,
      }
    }
    case 'reveal': {
      const points = round.reveal?.points[you] ?? 0
      return {
        key: moment,
        label: 'STEP 4/4',
        body: `You score +${points} this round. Press Next round to keep going: first to ${TARGET_SCORE} wins.`,
      }
    }
  }
}

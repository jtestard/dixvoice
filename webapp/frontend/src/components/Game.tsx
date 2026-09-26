import { useState, type ReactNode } from 'react'
import { roundResult } from '../roundResult'
import { tableView } from '../table'
import type { ClientMessage, GameState, Round } from '../types'
import { ClipCard } from './ClipCard'
import { PlayerList, PlayerName, Scoreboard, StopButton } from './Common'
import { GameTable } from './Table'

interface Props {
  state: GameState
  send: (msg: ClientMessage) => void
}

const PHASE_TITLE: Record<Round['phase'], string> = {
  storyteller: 'Storyteller',
  submit: 'Pick a clip',
  vote: 'Vote',
  reveal: 'Reveal',
}

export function Game({ state, send, tutorialEnabled, onToggleTutorial }: Props & { tutorialEnabled?: boolean; onToggleTutorial?: () => void }) {
  const [showScores, setShowScores] = useState(false)
  const { round } = state

  return (
    <main className="screen screen--game">
      <header className="game-header">
        <div className="game-header__meta">
          <span className="label">
            Room <strong className="game-header__code">{state.room.code}</strong>
          </span>
          {round && (
            <span className="label">
              Round {round.number} · {PHASE_TITLE[round.phase]}
            </span>
          )}
        </div>
        <div className="game-header__actions">
          {onToggleTutorial && (
            <button type="button" className="btn btn--secondary" onClick={onToggleTutorial} aria-pressed={tutorialEnabled}>
              How to play: {tutorialEnabled ? 'On' : 'Off'}
            </button>
          )}
          <button type="button" className="btn btn--secondary" onClick={() => setShowScores((s) => !s)} aria-expanded={showScores}>
            {showScores ? 'Hide scores' : 'Scores'}
          </button>
        </div>
      </header>

      {showScores && (
        <section className="panel score-panel" aria-label="Scoreboard">
          <Scoreboard players={state.players} youId={state.you.playerId} targetScore={state.room.targetScore} />
        </section>
      )}

      <RoundView key={round?.number ?? 0} state={state} send={send} />
    </main>
  )
}

/** The table, your hand in front of your seat, and the action bar for the current phase. Local drafts reset each round. */
function RoundView({ state, send }: Props) {
  const [picked, setPicked] = useState<string | null>(null)
  const [clue, setClue] = useState('')
  const round = state.round
  const you = state.you.playerId
  const isStoryteller = round?.storytellerId === you
  const phase = round?.phase
  const telling = phase === 'storyteller' && isStoryteller
  const view = tableView(state, { storytellerPicked: telling && picked !== null })
  const storyteller = state.players.find((p) => p.playerId === round?.storytellerId)
  const ready = picked !== null && clue.trim().length > 0

  let status: ReactNode = null
  let hand: ReactNode = <Hand state={state} selected={null} />
  let action: ReactNode = null

  if (phase === 'storyteller') {
    if (telling) {
      status = <p className="game-status">You are the storyteller. Listen, pick a clip and write a clue for it.</p>
      hand = <Hand state={state} selected={picked} onSelect={setPicked} />
      action = (
        <form
          className="clue-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && picked) send({ type: 'submit_clue', clipId: picked, clue: clue.trim() })
          }}
        >
          <label className="field field--grow">
            <span>Your clue</span>
            <input value={clue} onChange={(e) => setClue(e.target.value)} maxLength={100} placeholder="a door in the rain" />
          </label>
          <button type="submit" className="btn btn--primary" disabled={!ready}>
            Send clue
          </button>
        </form>
      )
    } else {
      status = (
        <p className="game-status waiting">
          Waiting for {storyteller ? <PlayerName player={storyteller} /> : 'the storyteller'} to pick a clip and write a clue…
        </p>
      )
    }
  } else if (phase === 'submit' && round) {
    if (isStoryteller) {
      status = <p className="game-status waiting">Waiting for the other players to submit a clip…</p>
    } else if (round.yourSubmission) {
      status = <p className="game-status waiting">Clip submitted. Waiting for the others…</p>
      hand = <Hand state={state} selected={round.yourSubmission} />
    } else {
      status = <p className="game-status">Pick the clip from your hand that best matches the clue.</p>
      hand = <Hand state={state} selected={null} onSelect={(clipId) => send({ type: 'submit_clip', clipId })} actionLabel="Submit" />
    }
  } else if (phase === 'vote' && round) {
    status = isStoryteller ? (
      <p className="game-status waiting">The others are voting on your clue…</p>
    ) : round.yourVote ? (
      <p className="game-status waiting">Vote cast. Waiting for the others…</p>
    ) : (
      <p className="game-status">Which clip is the storyteller&apos;s? Tap to listen, then vote. Not your own.</p>
    )
    hand = <HandStrip state={state} />
  } else if (phase === 'reveal') {
    const result = roundResult(state)
    status = result && (
      <section className={`round-result round-result--${result.tone}`} aria-label="Your round result" role="status">
        <strong className="round-result__label">
          {result.label} · +{result.points}
        </strong>
        <p className="round-result__reason">{result.reason}</p>
        <p className="round-result__breakdown">{result.breakdown}</p>
      </section>
    )
    hand = <HandStrip state={state} />
    action = (
      <button type="button" className="btn btn--primary btn--grow" onClick={() => send({ type: 'next_round' })}>
        Next round
      </button>
    )
  }

  return (
    <>
      <GameTable view={view} onVote={(clipId) => send({ type: 'vote', clipId })} />
      {status}
      {hand}
      <footer className="game-footer action-bar">
        {action}
        <StopButton onStop={() => send({ type: 'stop_game' })} />
      </footer>
    </>
  )
}

function Hand({ state, selected, onSelect, actionLabel }: { state: GameState; selected: string | null; onSelect?: (id: string) => void; actionLabel?: string }) {
  return (
    <section className="hand-area" aria-label="Your hand" data-tutorial="hand">
      <h2 className="hand-area__title">Your cards in hand</h2>
      <div className={`hand hand--dealt${onSelect ? ' hand--actions' : ''}`}>
        {state.you.hand.map((clip, i) => (
          <div key={clip.clipId} className="hand__cell">
            <ClipCard clip={clip} index={i} selected={selected === clip.clipId} onSelect={onSelect} actionLabel={actionLabel} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Vote and reveal: the hand stays in front of your seat, set aside, so the cards on the table have the room. */
function HandStrip({ state }: { state: GameState }) {
  const n = state.you.hand.length
  return (
    <section className="hand-area hand-area--strip" aria-label="Your hand" data-tutorial="hand">
      <h2 className="hand-area__title">
        Your cards in hand <span className="muted">· {n}</span>
      </h2>
      <div className="hand-strip" aria-hidden="true">
        {state.you.hand.map((clip) => (
          <span key={clip.clipId} className="hand-strip__card" />
        ))}
      </div>
    </section>
  )
}

export function EndGame({ state, send }: Props) {
  const you = state.you.playerId
  const won = state.winnerIds.includes(you)
  const winners = state.players.filter((p) => state.winnerIds.includes(p.playerId)).map((p) => p.nickname)
  return (
    <main className="screen">
      <h1 className="title">Game over</h1>
      <p className={`winner-line${winners.length ? won ? ' winner-line--success' : ' winner-line--failure' : ''}`}>
        {won ? 'You win!' : winners.length ? `${winners.join(' and ')} ${winners.length > 1 ? 'win' : 'wins'}!` : 'No winner.'}
      </p>
      <Scoreboard players={state.players} youId={you} winnerIds={state.winnerIds} targetScore={state.room.targetScore} />
      <h2>Players</h2>
      <PlayerList players={state.players} youId={you} />
      <div className="actions">
        <div className="row">
          <button type="button" className="btn btn--secondary" onClick={() => send({ type: 'leave_room' })}>
            Leave
          </button>
          <StopButton onStop={() => send({ type: 'stop_game' })} />
        </div>
      </div>
    </main>
  )
}

import { useState } from 'react'
import { roundResult } from '../roundResult'
import type { ClientMessage, GameState, Round } from '../types'
import { Board } from './Board'
import { ClipCard } from './ClipCard'
import { PlayerList, PlayerName, Scoreboard, StopButton } from './Common'

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
  const you = state.you.playerId
  const isStoryteller = round?.storytellerId === you

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
        <section className="panel" aria-label="Scoreboard">
          <Scoreboard players={state.players} youId={you} targetScore={state.room.targetScore} />
        </section>
      )}

      {round && <Board state={state} onVote={round.phase === 'vote' && !isStoryteller && !round.yourVote ? (clipId) => send({ type: 'vote', clipId }) : undefined} />}

      {round?.phase === 'storyteller' &&
        (isStoryteller ? <StorytellerPhase state={state} send={send} /> : <WaitForClue state={state} />)}
      {round?.phase === 'submit' &&
        (isStoryteller ? <WaitForSubmissions /> : <SubmitPhase state={state} send={send} />)}
      {round?.phase === 'vote' && <VoteStatus state={state} isStoryteller={isStoryteller} />}
      {round?.phase === 'reveal' && <RevealPhase state={state} send={send} />}

      <footer className="game-footer">
        <StopButton onStop={() => send({ type: 'stop_game' })} />
      </footer>
    </main>
  )
}

function Hand({ state, selected, onSelect, actionLabel, disabled }: { state: GameState; selected: string | null; onSelect?: (id: string) => void; actionLabel?: string; disabled?: boolean }) {
  return (
    <section aria-label="Your hand" data-tutorial="hand">
      <h2>Your hand</h2>
      <div className="hand hand--dealt">
        {state.you.hand.map((clip, i) => (
          <ClipCard
            key={clip.clipId}
            clip={clip}
            index={i}
            selected={selected === clip.clipId}
            onSelect={onSelect}
            actionLabel={actionLabel}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  )
}

function StorytellerPhase({ state, send }: Props) {
  const [clipId, setClipId] = useState<string | null>(null)
  const [clue, setClue] = useState('')
  const ready = clipId !== null && clue.trim().length > 0
  return (
    <>
      <p>You are the storyteller. Listen to your clips, pick one and write a clue for it.</p>
      <Hand state={state} selected={clipId} onSelect={setClipId} />
      <form
        className="clue-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && clipId) send({ type: 'submit_clue', clipId, clue: clue.trim() })
        }}
      >
        <label className="field">
          <span>Your clue</span>
          <input value={clue} onChange={(e) => setClue(e.target.value)} maxLength={100} placeholder="a door in the rain" />
        </label>
        <button type="submit" className="btn btn--primary btn--block" disabled={!ready}>
          Send clue
        </button>
      </form>
    </>
  )
}

function WaitForClue({ state }: { state: GameState }) {
  const storyteller = state.players.find((p) => p.isStoryteller)
  return (
    <>
      <p className="waiting">
        Waiting for {storyteller ? <PlayerName player={storyteller} /> : 'the storyteller'} to pick a clip and write a clue…
      </p>
      <Hand state={state} selected={null} />
    </>
  )
}

function SubmitPhase({ state, send }: Props) {
  const submitted = state.round!.yourSubmission
  return (
    <>
      {submitted ? (
        <p className="waiting">Clip submitted. Waiting for the others…</p>
      ) : (
        <p>Pick the clip from your hand that best matches the clue.</p>
      )}
      <Hand
        state={state}
        selected={submitted}
        onSelect={submitted ? undefined : (clipId) => send({ type: 'submit_clip', clipId })}
        actionLabel="Submit"
      />
    </>
  )
}

function WaitForSubmissions() {
  return <p className="waiting">Waiting for the other players to submit a clip…</p>
}

function VoteStatus({ state, isStoryteller }: { state: GameState; isStoryteller: boolean }) {
  if (isStoryteller) return <p className="waiting">The others are voting on your clue…</p>
  if (state.round!.yourVote) return <p className="waiting">Vote cast. Waiting for the others…</p>
  return <p>Which clip on the board is the storyteller&apos;s? Listen, then vote. You cannot vote for your own.</p>
}

function RevealPhase({ state, send }: Props) {
  const result = roundResult(state)
  return (
    <>
      {result && (
        <section className={`round-result round-result--${result.tone}`} aria-label="Your round result" role="status">
          <strong className="round-result__label">{result.label} · +{result.points}</strong>
          <p>{result.reason}</p>
          <p className="round-result__breakdown">{result.breakdown}</p>
        </section>
      )}
      <button type="button" className="btn btn--primary btn--block" onClick={() => send({ type: 'next_round' })}>
        Next round
      </button>
    </>
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

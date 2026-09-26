import { useState } from 'react'
import type { ClientMessage, GameState, Player, Round } from '../types'
import { ClipCard } from './ClipCard'
import { AddCompanionButton, PlayerList, PlayerName, Scoreboard, StopButton } from './Common'

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

export function Game({ state, send }: Props) {
  const [showScores, setShowScores] = useState(false)
  const { round } = state
  const you = state.you.playerId
  const isStoryteller = round?.storytellerId === you
  const storyteller = state.players.find((p) => p.playerId === round?.storytellerId)

  return (
    <main className="screen screen--game">
      <header className="game-header">
        <div>
          <span className="muted">Room </span>
          <strong className="mono">{state.room.code}</strong>
          {round && (
            <span className="muted">
              {' · '}Round {round.number} · {PHASE_TITLE[round.phase]}
            </span>
          )}
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => setShowScores((s) => !s)} aria-expanded={showScores}>
          {showScores ? 'Hide scores' : 'Scores'}
        </button>
      </header>

      {showScores && (
        <section className="panel" aria-label="Scoreboard">
          <Scoreboard players={state.players} youId={you} targetScore={state.room.targetScore} />
        </section>
      )}

      {round && (
        <p className="storyteller-line">
          Storyteller: <strong>{isStoryteller ? 'you' : <PlayerName player={storyteller} />}</strong>
        </p>
      )}

      {round?.phase === 'storyteller' &&
        (isStoryteller ? <StorytellerPhase state={state} send={send} /> : <WaitForClue state={state} />)}
      {round?.phase === 'submit' &&
        (isStoryteller ? <WaitForSubmissions state={state} /> : <SubmitPhase state={state} send={send} />)}
      {round?.phase === 'vote' && <VotePhase state={state} send={send} isStoryteller={isStoryteller} />}
      {round?.phase === 'reveal' && <RevealPhase state={state} send={send} />}

      <footer className="game-footer">
        <StopButton onStop={() => send({ type: 'stop_game' })} />
      </footer>
    </main>
  )
}

function Clue({ round }: { round: Round }) {
  return (
    <blockquote className="clue">
      <span className="muted">Clue</span>
      <div className="clue__text">{round.clue ?? '…'}</div>
    </blockquote>
  )
}

function Hand({ state, selected, onSelect, actionLabel, disabled }: { state: GameState; selected: string | null; onSelect?: (id: string) => void; actionLabel?: string; disabled?: boolean }) {
  return (
    <section aria-label="Your hand">
      <h2>Your hand</h2>
      <div className="hand">
        {state.you.hand.map((clip, i) => (
          <ClipCard
            key={clip.clipId}
            clip={clip}
            label={`Clip ${i + 1}`}
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
  const round = state.round!
  const submitted = round.yourSubmission
  const waitingOn = (p: Player) => !p.isStoryteller && !p.hasSubmitted
  return (
    <>
      <Clue round={round} />
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
      <h2>Players</h2>
      <PlayerList players={state.players.filter((p) => !p.isStoryteller)} youId={state.you.playerId} waitingOn={waitingOn} />
    </>
  )
}

function WaitForSubmissions({ state }: { state: GameState }) {
  const round = state.round!
  const waitingOn = (p: Player) => !p.isStoryteller && !p.hasSubmitted
  return (
    <>
      <Clue round={round} />
      <p className="waiting">Waiting for the other players to submit a clip…</p>
      <PlayerList players={state.players.filter((p) => !p.isStoryteller)} youId={state.you.playerId} waitingOn={waitingOn} />
    </>
  )
}

function VotePhase({ state, send, isStoryteller }: Props & { isStoryteller: boolean }) {
  const round = state.round!
  const voted = round.yourVote
  const waitingOn = (p: Player) => !p.isStoryteller && !p.hasVoted
  const canVote = !isStoryteller && !voted
  return (
    <>
      <Clue round={round} />
      {isStoryteller ? (
        <p className="waiting">The others are voting on your clue…</p>
      ) : voted ? (
        <p className="waiting">Vote cast. Waiting for the others…</p>
      ) : (
        <p>Which clip is the storyteller&apos;s? You cannot vote for your own.</p>
      )}
      <section aria-label="Table">
        <div className="hand">
          {round.table.map((clip, i) => {
            const own = clip.clipId === round.yourSubmission
            return (
              <ClipCard
                key={clip.clipId}
                clip={clip}
                label={`Clip ${i + 1}`}
                selected={voted === clip.clipId}
                badge={own ? 'yours' : undefined}
                onSelect={canVote && !own ? (clipId) => send({ type: 'vote', clipId }) : undefined}
                actionLabel="Vote"
              />
            )
          })}
        </div>
      </section>
      <h2>Players</h2>
      <PlayerList players={state.players.filter((p) => !p.isStoryteller)} youId={state.you.playerId} waitingOn={waitingOn} />
    </>
  )
}

function RevealPhase({ state, send }: Props) {
  const round = state.round!
  const reveal = round.reveal
  const byId = new Map(state.players.map((p) => [p.playerId, p]))
  const name = (id: string) => {
    const p = byId.get(id)
    return p ? <PlayerName key={id} player={p} /> : id
  }
  const clipFor = (clipId: string) => round.table.find((c) => c.clipId === clipId)
  return (
    <>
      <Clue round={round} />
      {reveal && (
        <>
          <section aria-label="Results">
            <div className="hand">
              {reveal.results.map((r, i) => {
                const clip = clipFor(r.clipId) ?? { clipId: r.clipId, clipUrl: '', text: '', emotion: '', voiceId: '' }
                return (
                  <ClipCard
                    key={r.clipId}
                    clip={clip}
                    label={`Clip ${i + 1}`}
                    selected={r.isStoryteller}
                    badge={r.isStoryteller ? 'storyteller' : undefined}
                  >
                    <div className="reveal-info">
                      <div>
                        <span className="muted">Owner: </span>
                        <strong>{name(r.ownerId)}</strong>
                      </div>
                      <div>
                        <span className="muted">Votes: </span>
                        {r.voterIds.length
                          ? r.voterIds.map((id, i) => (
                              <span key={id}>
                                {i > 0 && ', '}
                                {name(id)}
                              </span>
                            ))
                          : 'none'}
                      </div>
                    </div>
                  </ClipCard>
                )
              })}
            </div>
          </section>
          <h2>Points this round</h2>
          <ul className="points">
            {state.players.map((p) => (
              <li key={p.playerId}>
                <span>
                  <PlayerName player={p} />
                </span>
                <span className="num">
                  +{reveal.points[p.playerId] ?? 0} <span className="muted">({p.score})</span>
                </span>
              </li>
            ))}
          </ul>
        </>
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
      <p className="winner-line">
        {won ? 'You win!' : winners.length ? `${winners.join(' and ')} ${winners.length > 1 ? 'win' : 'wins'}!` : 'No winner.'}
      </p>
      <Scoreboard players={state.players} youId={you} winnerIds={state.winnerIds} targetScore={state.room.targetScore} />
      <h2>Players</h2>
      <PlayerList players={state.players} youId={you} onRemoveCompanion={(playerId) => send({ type: 'remove_companion', playerId })} />
      <div className="actions">
        <AddCompanionButton players={state.players} onAdd={() => send({ type: 'add_companion' })} />
        <button type="button" className="btn btn--primary btn--block" disabled={state.players.length < 4} onClick={() => send({ type: 'start_game' })}>
          New game
        </button>
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

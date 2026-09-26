import { useState } from 'react'
import { roundResult } from '../roundResult'
import type { ClientMessage, GameState, Player, Round } from '../types'
import { ClipCard, FaceDownCard } from './ClipCard'
import { PlayerList, PlayerName, Scoreboard, Sheet, StopButton } from './Common'

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
  const me = state.players.find((p) => p.playerId === you)
  const isStoryteller = round?.storytellerId === you
  const storyteller = state.players.find((p) => p.playerId === round?.storytellerId)
  const others = state.players.filter((p) => !p.isStoryteller)

  return (
    <main className="screen screen--game">
      <header className="game-header">
        <p className="game-header__meta label">
          <span className="game-header__room">
            <span className="game-header__word">Room </span>
            <strong className="game-header__code">{state.room.code}</strong>
          </span>
          {round && (
            <span>
              <span aria-hidden="true"> · </span>
              <span className="game-header__word">Round </span>
              <span className="game-header__abbr">R</span>
              {round.number}
              <span className="game-header__word"> · {PHASE_TITLE[round.phase]}</span>
            </span>
          )}
          {me && (
            <span>
              <span aria-hidden="true"> · </span>
              <strong className="game-header__score">{me.score}</strong> pts
            </span>
          )}
        </p>
        <div className="game-header__actions">
          {onToggleTutorial && (
            <button
              type="button"
              className={`btn btn--secondary btn--compact${tutorialEnabled ? '' : ' btn--off'}`}
              onClick={onToggleTutorial}
              aria-pressed={tutorialEnabled}
              aria-label={`How to play: ${tutorialEnabled ? 'On' : 'Off'}`}
              title={`How to play: ${tutorialEnabled ? 'On' : 'Off'}`}
            >
              ?
            </button>
          )}
          <button type="button" className="btn btn--secondary btn--compact" onClick={() => setShowScores(true)} aria-expanded={showScores}>
            Scores
          </button>
          <StopButton onStop={() => send({ type: 'stop_game' })} />
        </div>
      </header>

      {showScores && (
        <Sheet title="Scoreboard" onClose={() => setShowScores(false)}>
          <Scoreboard players={state.players} youId={you} targetScore={state.room.targetScore} />
          {round && round.phase !== 'storyteller' && (
            <>
              <h2>Players</h2>
              <PlayerList players={others} youId={you} waitingOn={round.phase === 'submit' ? notSubmitted : round.phase === 'vote' ? notVoted : undefined} />
            </>
          )}
        </Sheet>
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
    </main>
  )
}

/** Phone grid shape for n cards: 2x2 up to 4 cards, 3x2 up to 6, 4x2 beyond. */
const gridClass = (n: number) => (n <= 4 ? ' hand--pair' : n > 6 ? ' hand--dense' : '')

const notSubmitted = (p: Player) => !p.isStoryteller && !p.hasSubmitted
const notVoted = (p: Player) => !p.isStoryteller && !p.hasVoted

function Clue({ round }: { round: Round }) {
  const [expanded, setExpanded] = useState(false)
  const text = round.clue ?? '…'
  const long = text.length > 40
  return (
    <blockquote className={`clue${expanded ? ' clue--expanded' : ''}`}>
      <span className="clue__label">Clue</span>
      <div className="clue__text">{text}</div>
      {long && (
        <button type="button" className="clue__more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </blockquote>
  )
}

function Hand({ state, selected, onSelect, actionLabel, disabled }: { state: GameState; selected: string | null; onSelect?: (id: string) => void; actionLabel?: string; disabled?: boolean }) {
  return (
    <section className="table" aria-label="Your hand">
      <h2>Your hand</h2>
      <div className={`hand hand--dealt${onSelect ? ' hand--actions' : ''}`} style={{ '--n': state.you.hand.length } as React.CSSProperties}>
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

function FaceDownTable({ state, large = false }: { state: GameState; large?: boolean }) {
  const count = 1 + state.players.filter((p) => !p.isStoryteller && p.hasSubmitted).length
  const cards = Array.from({ length: count }, (_, i) => <FaceDownCard key={i} />)
  if (large) {
    return (
      <section className="table" aria-label={`${count} ${count > 1 ? 'clips' : 'clip'} on the table`}>
        <h2>On the table</h2>
        <div className={`hand${gridClass(count)}`} style={{ '--n': count } as React.CSSProperties}>
          {cards}
        </div>
      </section>
    )
  }
  return (
    <section className="table-preview" aria-label={`${count} ${count > 1 ? 'clips' : 'clip'} on the table`}>
      <h2>On the table</h2>
      <div className="hand--facedown">{cards}</div>
    </section>
  )
}

function StorytellerPhase({ state, send }: Props) {
  const [clipId, setClipId] = useState<string | null>(null)
  const [clue, setClue] = useState('')
  const ready = clipId !== null && clue.trim().length > 0
  return (
    <>
      <div className="screen__body">
        <p className="hint-line">You are the storyteller. Listen to your clips, pick one and write a clue for it.</p>
        <Hand state={state} selected={clipId} onSelect={setClipId} />
      </div>
      <form
        className="clue-form action-bar"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && clipId) send({ type: 'submit_clue', clipId, clue: clue.trim() })
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
    </>
  )
}

function WaitForClue({ state }: { state: GameState }) {
  const storyteller = state.players.find((p) => p.isStoryteller)
  return (
    <div className="screen__body">
      <p className="waiting">
        Waiting for {storyteller ? <PlayerName player={storyteller} /> : 'the storyteller'} to pick a clip and write a clue…
      </p>
      <Hand state={state} selected={null} />
    </div>
  )
}

function SubmitPhase({ state, send }: Props) {
  const round = state.round!
  const submitted = round.yourSubmission
  return (
    <div className="screen__body">
      <Clue round={round} />
      {submitted ? (
        <p className="waiting">Clip submitted. Waiting for the others…</p>
      ) : (
        <p className="hint-line">Pick the clip from your hand that best matches the clue.</p>
      )}
      <FaceDownTable state={state} />
      <Hand
        state={state}
        selected={submitted}
        onSelect={submitted ? undefined : (clipId) => send({ type: 'submit_clip', clipId })}
        actionLabel="Submit"
      />
      <PlayerList variant="strip" players={state.players.filter((p) => !p.isStoryteller)} youId={state.you.playerId} waitingOn={notSubmitted} />
    </div>
  )
}

function WaitForSubmissions({ state }: { state: GameState }) {
  const round = state.round!
  return (
    <div className="screen__body">
      <Clue round={round} />
      <p className="waiting">Waiting for the other players to submit a clip…</p>
      <FaceDownTable state={state} large />
      <PlayerList variant="strip" players={state.players.filter((p) => !p.isStoryteller)} youId={state.you.playerId} waitingOn={notSubmitted} />
    </div>
  )
}

function VotePhase({ state, send, isStoryteller }: Props & { isStoryteller: boolean }) {
  const round = state.round!
  const voted = round.yourVote
  const canVote = !isStoryteller && !voted
  const n = round.table.length
  return (
    <div className="screen__body">
      <Clue round={round} />
      {isStoryteller ? (
        <p className="waiting">The others are voting on your clue…</p>
      ) : voted ? (
        <p className="waiting">Vote cast. Waiting for the others…</p>
      ) : (
        <p className="hint-line">Which clip is the storyteller&apos;s? You cannot vote for your own.</p>
      )}
      <section className="table" aria-label="Table">
        <div className={`hand hand--flip${canVote ? ' hand--actions' : ''}${gridClass(n)}`} style={{ '--n': n } as React.CSSProperties}>
          {round.table.map((clip, i) => {
            const own = clip.clipId === round.yourSubmission
            return (
              <ClipCard
                key={clip.clipId}
                clip={clip}
                index={i}
                selected={voted === clip.clipId}
                badge={own ? 'yours' : undefined}
                onSelect={canVote && !own ? (clipId) => send({ type: 'vote', clipId }) : undefined}
                actionLabel="Vote"
              />
            )
          })}
        </div>
      </section>
      <PlayerList variant="strip" players={state.players.filter((p) => !p.isStoryteller)} youId={state.you.playerId} waitingOn={notVoted} />
    </div>
  )
}

function RevealPhase({ state, send }: Props) {
  const round = state.round!
  const reveal = round.reveal
  const result = roundResult(state)
  const byId = new Map(state.players.map((p) => [p.playerId, p]))
  const name = (id: string) => {
    const p = byId.get(id)
    return p ? <PlayerName key={id} player={p} /> : id
  }
  const clipFor = (clipId: string) => round.table.find((c) => c.clipId === clipId)
  const n = reveal?.results.length ?? 0
  return (
    <>
      <div className="screen__body">
        <Clue round={round} />
        {reveal && (
          <>
            {result && (
              <section className={`round-result round-result--${result.tone}`} aria-label="Your round result" role="status">
                <strong className="round-result__label">
                  {result.label} · +{result.points}
                </strong>
                <p className="round-result__reason">{result.reason}</p>
                <p className="round-result__breakdown">{result.breakdown}</p>
              </section>
            )}
            <section className="table" aria-label="Results">
              <div className={`hand hand--flip hand--info${gridClass(n)}`} style={{ '--n': n } as React.CSSProperties}>
                {reveal.results.map((r, i) => {
                  const clip = clipFor(r.clipId) ?? { clipId: r.clipId, clipUrl: '', text: '', emotion: '', voiceId: '' }
                  return (
                    <ClipCard
                      key={r.clipId}
                      clip={clip}
                      index={i}
                      selected={r.isStoryteller}
                      badge={r.isStoryteller ? 'storyteller' : undefined}
                      badgeKind="accent"
                    >
                      <div className="reveal-info">
                        <div className="reveal-info__line">
                          <span className="label">Owner </span>
                          <strong>{name(r.ownerId)}</strong>
                        </div>
                        <div className="reveal-info__line">
                          <span className="label">Votes </span>
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
            <section aria-label="Points this round">
              <h2>Points this round</h2>
              <ul className="points">
                {state.players.map((p) => (
                  <li key={p.playerId} className={p.playerId === state.you.playerId ? 'you' : undefined}>
                    <span className="points__name">
                      <PlayerName player={p} />
                    </span>
                    <span className="num">
                      <span className="points__won">+{reveal.points[p.playerId] ?? 0}</span> <span className="muted">({p.score})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
      <div className="action-bar">
        <button type="button" className="btn btn--primary btn--block" onClick={() => send({ type: 'next_round' })}>
          Next round
        </button>
      </div>
    </>
  )
}

export function EndGame({ state, send }: Props) {
  const you = state.you.playerId
  const won = state.winnerIds.includes(you)
  const winners = state.players.filter((p) => state.winnerIds.includes(p.playerId)).map((p) => p.nickname)
  return (
    <main className="screen screen--end">
      <h1 className="title">Game over</h1>
      <p className={`winner-line${winners.length ? won ? ' winner-line--success' : ' winner-line--failure' : ''}`}>
        {won ? 'You win!' : winners.length ? `${winners.join(' and ')} ${winners.length > 1 ? 'win' : 'wins'}!` : 'No winner.'}
      </p>
      <div className="screen__body screen__body--scroll">
        <Scoreboard players={state.players} youId={you} winnerIds={state.winnerIds} targetScore={state.room.targetScore} />
        <h2>Players</h2>
        <PlayerList players={state.players} youId={you} />
      </div>
      <div className="actions action-bar">
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

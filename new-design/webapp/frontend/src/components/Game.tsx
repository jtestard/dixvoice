import { useState } from 'react'
import { roundResult } from '../roundResult'
import { setSfxEnabled, sfx, sfxEnabled } from '../sfx'
import type { TutorialCue as Cue } from '../tutorial'
import type { ClientMessage, GameState, Round } from '../types'
import { ClipCard } from './ClipCard'
import { Avatar, Confetti, PlayerName, Podium, ScoreTrack, Scoreboard, StopButton, playerColor } from './Common'
import { Table } from './Table'
import { TutorialCue } from './TutorialCard'

interface Props {
  state: GameState
  send: (msg: ClientMessage) => void
}

interface GameProps extends Props {
  tutorialEnabled?: boolean
  onToggleTutorial?: () => void
  cue?: Cue | null
}

export function Game({ state, send, tutorialEnabled, onToggleTutorial, cue = null }: GameProps) {
  const [showScores, setShowScores] = useState(false)
  const [sound, setSound] = useState(sfxEnabled())
  const { round } = state
  const you = state.you.playerId
  const isStoryteller = round?.storytellerId === you

  const toggleSound = () => {
    const on = !sound
    setSfxEnabled(on)
    setSound(on)
    if (on) sfx('click')
  }

  return (
    <main className="screen board">
      <div className="board__side">
        <Table state={state} />
        {tutorialEnabled && <TutorialCue cue={cue} />}
      </div>

      <div className="board__main">
        <header className="game-header">
          <span className="label game-header__room">
            Room <strong className="game-header__code">{state.room.code}</strong>
            {round && <> · Round {round.number}</>}
          </span>
          <div className="game-header__actions">
            <button type="button" className="btn btn--secondary btn--small" onClick={toggleSound} aria-pressed={sound}>
              Sound: {sound ? 'on' : 'off'}
            </button>
            {onToggleTutorial && (
              <button type="button" className="btn btn--secondary btn--small" onClick={onToggleTutorial} aria-pressed={tutorialEnabled}>
                Help: {tutorialEnabled ? 'on' : 'off'}
              </button>
            )}
            <button type="button" className="btn btn--secondary btn--small" onClick={() => setShowScores((s) => !s)} aria-expanded={showScores}>
              {showScores ? 'Hide scores' : 'Scores'}
            </button>
          </div>
        </header>

        {showScores && (
          <section className="panel" aria-label="Scoreboard">
            <Scoreboard players={state.players} youId={you} targetScore={state.room.targetScore} />
          </section>
        )}

        {round?.phase === 'storyteller' &&
          (isStoryteller ? <StorytellerPhase state={state} send={send} /> : <WaitForClue state={state} />)}
        {round?.phase === 'submit' &&
          (isStoryteller ? <WaitForSubmissions state={state} /> : <SubmitPhase state={state} send={send} />)}
        {round?.phase === 'vote' && <VotePhase state={state} send={send} isStoryteller={isStoryteller} />}
        {round?.phase === 'reveal' && <RevealPhase state={state} send={send} />}

        <footer className="game-footer">
          <StopButton onStop={() => send({ type: 'stop_game' })} label="Stop game" className="btn btn--small btn--ghost-danger" />
        </footer>
      </div>
    </main>
  )
}

function Clue({ round, state, compact = false }: { round: Round; state: GameState; compact?: boolean }) {
  const st = state.players.find((p) => p.playerId === round.storytellerId)
  const mine = round.storytellerId === state.you.playerId
  return (
    <blockquote className={`clue${compact ? ' clue--compact' : ''}`}>
      <span className="clue__label">{mine ? 'Your clue' : st ? `${st.nickname}'s clue` : 'Clue'}</span>
      <div className="clue__text">{round.clue ?? '…'}</div>
    </blockquote>
  )
}

function Hand({
  state,
  selected,
  onSelect,
  actionLabel,
  disabled,
  flyingId = null,
}: {
  state: GameState
  selected: string | null
  onSelect?: (id: string) => void
  actionLabel?: string
  disabled?: boolean
  flyingId?: string | null
}) {
  return (
    <section aria-label="Your hand">
      <div className="hand hand--dealt">
        {state.you.hand.map((clip, i) => (
          <ClipCard
            key={clip.clipId}
            clip={clip}
            index={i}
            selected={selected === clip.clipId}
            flying={flyingId === clip.clipId}
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
      <p className="instruction">Listen to your clips, pick one and write a clue for it.</p>
      <Hand
        state={state}
        selected={clipId}
        onSelect={(id) => {
          sfx('select')
          setClipId((cur) => (cur === id ? null : id))
        }}
      />
      <form
        className="clue-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && clipId) send({ type: 'submit_clue', clipId, clue: clue.trim() })
        }}
      >
        <input
          className="input"
          value={clue}
          onChange={(e) => {
            sfx('type')
            setClue(e.target.value)
          }}
          maxLength={100}
          placeholder="Your clue, e.g. a door in the rain"
          aria-label="Your clue"
        />
        <button type="submit" className="btn btn--primary" disabled={!ready}>
          {clipId ? 'Send clue' : 'Pick a clip'}
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
        Waiting for {storyteller ? <PlayerName player={storyteller} /> : 'the storyteller'} to write a clue
        <span className="dots">…</span>
      </p>
      <Hand state={state} selected={null} />
    </>
  )
}

function SubmitPhase({ state, send }: Props) {
  const round = state.round!
  const submitted = round.yourSubmission
  const [flyId, setFlyId] = useState<string | null>(null)
  return (
    <>
      <Clue round={round} state={state} />
      {submitted ? (
        <p className="waiting">
          Clip on the table. Waiting for the others<span className="dots">…</span>
        </p>
      ) : (
        <p className="instruction">Pick the clip from your hand that best matches the clue.</p>
      )}
      <Hand
        state={state}
        selected={submitted}
        flyingId={flyId}
        onSelect={
          submitted
            ? undefined
            : (clipId) => {
                setFlyId(clipId)
                sfx('submit')
                send({ type: 'submit_clip', clipId })
              }
        }
        actionLabel="Play this"
      />
    </>
  )
}

function WaitForSubmissions({ state }: { state: GameState }) {
  const round = state.round!
  return (
    <>
      <Clue round={round} state={state} />
      <p className="waiting">
        The others are picking a clip<span className="dots">…</span>
      </p>
    </>
  )
}

function VotePhase({ state, send, isStoryteller }: Props & { isStoryteller: boolean }) {
  const round = state.round!
  const voted = round.yourVote
  const canVote = !isStoryteller && !voted
  return (
    <>
      <Clue round={round} state={state} />
      {isStoryteller ? (
        <p className="waiting">
          The others are voting on your clue<span className="dots">…</span>
        </p>
      ) : voted ? (
        <p className="waiting">
          Vote cast. Waiting for the others<span className="dots">…</span>
        </p>
      ) : (
        <p className="instruction">Which clip is the storyteller&apos;s? Not your own.</p>
      )}
      <section aria-label="Table">
        <div className="hand hand--table hand--flip">
          {round.table.map((clip, i) => {
            const own = clip.clipId === round.yourSubmission
            return (
              <ClipCard
                key={clip.clipId}
                clip={clip}
                index={i}
                selected={voted === clip.clipId}
                voted={voted === clip.clipId}
                badge={own ? 'yours' : undefined}
                onSelect={
                  canVote && !own
                    ? (clipId) => {
                        sfx('stamp')
                        send({ type: 'vote', clipId })
                      }
                    : undefined
                }
                actionLabel="Vote"
              />
            )
          })}
        </div>
      </section>
    </>
  )
}

function RevealPhase({ state, send }: Props) {
  const round = state.round!
  const reveal = round.reveal
  const result = roundResult(state)
  const byId = new Map(state.players.map((p) => [p.playerId, p]))
  const name = (id: string) => (id === state.you.playerId ? 'you' : (byId.get(id)?.nickname ?? id))
  const clipFor = (clipId: string) => round.table.find((c) => c.clipId === clipId)
  const target = state.room.targetScore || 10
  const gameOver = state.players.some((p) => p.score >= target)
  return (
    <>
      <Clue round={round} state={state} compact />
      {reveal && (
        <>
          <section aria-label="Results">
            <div className="hand hand--table hand--flip">
              {reveal.results.map((r, i) => {
                const clip = clipFor(r.clipId) ?? { clipId: r.clipId, clipUrl: '', text: '', emotion: '', voiceId: '' }
                return (
                  <ClipCard key={r.clipId} clip={clip} index={i} correct={r.isStoryteller} voted={round.yourVote === r.clipId}>
                    <div className="reveal-info">
                      <div className="reveal-info__owner">
                        <Avatar color={playerColor(state.players, r.ownerId)} size="dot" />
                        <strong>{name(r.ownerId)}</strong>
                      </div>
                      {r.voterIds.length > 0 && (
                        <div className="reveal-info__voters">
                          {r.voterIds.map((id, k) => (
                            <span key={id} className="chip" style={{ animationDelay: `${260 + k * 70}ms` }}>
                              <Avatar color={playerColor(state.players, id)} size="tiny" />
                              {name(id)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </ClipCard>
                )
              })}
            </div>
          </section>
          <section className={`round-result${result ? ` round-result--${result.tone}` : ''}`} aria-label="Round result" role="status">
            {result && (
              <div className="round-result__head">
                <strong className="round-result__label">{result.points === 0 ? 'No points for you' : `You score ${result.points}`}</strong>
                <span className="round-result__reason">{result.reason}</span>
              </div>
            )}
            <ul className="points">
              {state.players.map((p) => {
                const won = reveal.points[p.playerId] ?? 0
                return (
                  <li key={p.playerId} className={p.playerId === state.you.playerId ? 'you' : undefined}>
                    <Avatar color={playerColor(state.players, p.playerId)} size="dot" />
                    <span className="points__name">
                      <PlayerName player={p} />
                      {p.playerId === state.you.playerId && <span className="muted"> (you)</span>}
                    </span>
                    <ScoreTrack score={p.score} target={target} gained={won} />
                    <span className="num">
                      <span className={`points__won${won === 0 ? ' points__won--zero' : ''}`}>+{won}</span> <span className="muted">({p.score})</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
      <button type="button" className="btn btn--primary btn--block btn--next" onClick={() => send({ type: 'next_round' })}>
        {gameOver ? 'See final scores' : 'Next round'}
      </button>
    </>
  )
}

export function EndGame({ state, send }: Props) {
  const you = state.you.playerId
  const won = state.winnerIds.includes(you)
  const winners = state.players.filter((p) => state.winnerIds.includes(p.playerId)).map((p) => p.nickname)
  const sorted = [...state.players].sort((a, b) => b.score - a.score)
  const others = sorted.slice(3)
  return (
    <main className="screen" style={{ justifyContent: 'center' }}>
      <h1 className="title">Game over</h1>
      <p className={`winner-line${winners.length ? (won ? ' winner-line--success' : ' winner-line--failure') : ''}`}>
        {won
          ? winners.length > 1
            ? 'You share the win!'
            : 'You win!'
          : winners.length
            ? `${winners.join(' and ')} ${winners.length > 1 ? 'win' : 'wins'}!`
            : 'No winner.'}
      </p>
      <Podium players={state.players} youId={you} />
      {others.length > 0 && (
        <ul className="points" style={{ background: 'var(--color-surface)', border: 'var(--line) solid var(--color-border)', borderRadius: 'var(--radius)' }}>
          {others.map((p, i) => (
            <li key={p.playerId} className={p.playerId === you ? 'you' : undefined}>
              <span className="mono">{i + 4}</span>
              <Avatar color={playerColor(state.players, p.playerId)} size="dot" />
              <span className="points__name">
                <PlayerName player={p} />
                {p.playerId === you && <span className="muted"> (you)</span>}
              </span>
              <span className="scoreboard__score">{p.score}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <div className="row">
          <button type="button" className="btn btn--secondary" onClick={() => send({ type: 'leave_room' })}>
            Leave
          </button>
          <StopButton onStop={() => send({ type: 'stop_game' })} />
        </div>
      </div>
      {won && <Confetti />}
    </main>
  )
}

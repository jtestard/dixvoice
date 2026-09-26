import { useMemo, useState } from 'react'
import { ApiError, createRoom, joinRoom } from '../api'
import type { GameState, Player } from '../types'
import type { Notice } from '../useGame'
import { NoticeLabel } from './Common'
import { Table } from './Table'

interface Props {
  notice: Notice | null
  onDismissNotice: () => void
  onJoined: (token: string) => void
  onQuickStart: (token: string) => void
}

const NICK_KEY = 'dixvoice.nickname'

const STEPS = [
  'The storyteller picks a clip and writes a clue.',
  'Everyone else plays a clip that fits, face down.',
  "Clips are shuffled: vote for the storyteller's.",
  'Score points. First to 10 wins.',
]

/** A frozen table (phase 2, everyone has played) so the concept reads before the first game. */
function demoState(nickname: string): GameState {
  const mk = (playerId: string, nick: string, isStoryteller = false): Player => ({
    playerId,
    nickname: nick,
    connected: true,
    score: 0,
    isStoryteller,
    hasSubmitted: true,
    hasVoted: false,
    isCompanion: false,
  })
  const players = [mk('h1', nickname || 'You'), mk('h2', 'Ben'), mk('h3', 'Robo Ada', true), mk('h4', 'Chloé')]
  return {
    type: 'state',
    room: { code: 'DEMO', status: 'playing', targetScore: 10 },
    you: { playerId: 'h1', hand: [] },
    players,
    round: { number: 1, phase: 'submit', storytellerId: 'h3', clue: 'a door in the rain', yourSubmission: null, yourVote: null, table: [], reveal: null },
    winnerIds: [],
  }
}

export function Home({ notice, onDismissNotice, onJoined, onQuickStart }: Props) {
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICK_KEY) ?? '')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const nick = nickname.trim()
  const demo = useMemo(() => demoState(nick), [nick])

  async function run(action: () => Promise<{ token: string }>, done: (token: string) => void = onJoined) {
    setError(null)
    onDismissNotice()
    if (!nick) {
      setError('Please enter a nickname.')
      return
    }
    setBusy(true)
    try {
      localStorage.setItem(NICK_KEY, nick)
      const res = await action()
      done(res.token)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen board board--center">
      <div className="board__side board__side--wide">
        <h1 className="wordmark">
          <img className="wordmark__mark" src={`${import.meta.env.BASE_URL}cassette.svg`} alt="" width={92} height={64} />
          <span>
            <span className="wordmark__dix">dix</span>voice
          </span>
        </h1>
        <p className="tagline">Dixit, with sounds instead of cards.</p>
        <Table state={demo} className="table--wide" />
        <div className="steps">
          {STEPS.map((text, i) => (
            <div key={i} className="step">
              <span className="step__n">{i + 1}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="board__main board__main--narrow form-stack">
        {notice && (
          <div className={`notice notice--${notice.kind}`} role="status">
            <NoticeLabel kind={notice.kind} />
            <span>{notice.text}</span>
          </div>
        )}

        <label className="field">
          <span>Nickname</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="Your name" />
        </label>

        <button type="button" className="btn btn--primary btn--block btn--quick" disabled={busy || !nick} onClick={() => run(() => createRoom(nick), onQuickStart)}>
          Quick start
        </button>
        <p className="hint">Sit down with 3 AI companions.</p>

        <div className="divider">or with friends</div>

        <button type="button" className="btn btn--secondary btn--block" disabled={busy} onClick={() => run(() => createRoom(nick))}>
          Create a room
        </button>

        <form
          className="join-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (!code.trim()) {
              setError('Please enter a room code.')
              return
            }
            run(() => joinRoom(code.trim().toUpperCase(), nick))
          }}
        >
          <input
            className="input input--code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="ROOM CODE"
            aria-label="Room code"
          />
          <button type="submit" className="btn btn--secondary" disabled={busy}>
            Join
          </button>
        </form>

        {error && (
          <div className="notice notice--error" role="alert">
            <NoticeLabel kind="error" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </main>
  )
}

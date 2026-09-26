import { useState } from 'react'
import { ApiError, createRoom, joinRoom } from '../api'
import type { Notice } from '../useGame'
import { NoticeLabel } from './Common'

interface Props {
  notice: Notice | null
  onDismissNotice: () => void
  onJoined: (token: string) => void
}

const NICK_KEY = 'dixvoice.nickname'

export function Home({ notice, onDismissNotice, onJoined }: Props) {
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICK_KEY) ?? '')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const nick = nickname.trim()

  async function run(action: () => Promise<{ token: string }>) {
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
      onJoined(res.token)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen screen--home">
      <h1 className="wordmark">
        <img className="wordmark__mark" src={`${import.meta.env.BASE_URL}cassette.svg`} alt="" width={92} height={64} />
        <span>
          <span className="wordmark__dix">dix</span>voice
        </span>
      </h1>
      <p className="tagline">Dixit, with sounds instead of cards.</p>

      {notice && (
        <div className={`notice notice--${notice.kind}`} role="status">
          <NoticeLabel kind={notice.kind} />
          <span>{notice.text}</span>
        </div>
      )}

      <label className="field">
        <span>Nickname</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={20}
          autoComplete="nickname"
          placeholder="Your name"
        />
      </label>

      <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => run(() => createRoom(nick))}>
        Create a room
      </button>

      <div className="divider">or join a room</div>

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
        <label className="field field--grow">
          <span>Room code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="KXQP"
            className="input--code"
          />
        </label>
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
    </main>
  )
}

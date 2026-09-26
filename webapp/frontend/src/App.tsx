import { useCallback } from 'react'
import { EndGame, Game } from './components/Game'
import { Home } from './components/Home'
import { Lobby } from './components/Lobby'
import { NoticeLabel } from './components/Common'
import type { ClientMessage } from './types'
import { useGame } from './useGame'
import { useQuickStart } from './useQuickStart'

export default function App() {
  const game = useGame()
  const { token, state, conn, notice, setToken, send, dismissNotice } = game
  const { quick, begin, dismiss } = useQuickStart({ token, state, conn, notice, send })

  const onJoined = useCallback(
    (t: string) => {
      dismiss()
      setToken(t)
    },
    [setToken, dismiss],
  )

  const onQuickStart = useCallback(
    (t: string) => {
      begin()
      setToken(t)
    },
    [setToken, begin],
  )

  const sendAndMaybeLeave = useCallback(
    (msg: ClientMessage) => {
      send(msg)
      if (msg.type === 'leave_room') setToken(null)
    },
    [send, setToken],
  )

  if (!token) {
    return <Home notice={notice} onDismissNotice={dismissNotice} onJoined={onJoined} onQuickStart={onQuickStart} />
  }

  return (
    <>
      {conn !== 'open' && (
        <div className="banner banner--conn" role="status">
          <NoticeLabel kind="warning" />
          <span className="banner__text">{conn === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Connecting…'}</span>
          <button type="button" className="btn btn--link" onClick={() => setToken(null)}>
            Leave
          </button>
        </div>
      )}
      {notice && (
        <div className={`banner banner--${notice.kind}`} role="alert">
          <NoticeLabel kind={notice.kind} />
          <span className="banner__text">{notice.text}</span>
          <button type="button" className="btn btn--link" onClick={dismissNotice} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {!state ? (
        <main className="screen">
          <p className="waiting">Loading room…</p>
        </main>
      ) : state.room.status === 'lobby' ? (
        <Lobby state={state} send={sendAndMaybeLeave} quick={quick} onDismissQuick={dismiss} />
      ) : state.room.status === 'finished' ? (
        <EndGame state={state} send={sendAndMaybeLeave} />
      ) : (
        <Game state={state} send={send} />
      )}
    </>
  )
}

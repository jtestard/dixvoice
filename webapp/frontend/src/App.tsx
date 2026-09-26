import { useCallback } from 'react'
import { EndGame, Game } from './components/Game'
import { Home } from './components/Home'
import { Lobby } from './components/Lobby'
import type { ClientMessage } from './types'
import { useGame } from './useGame'

export default function App() {
  const game = useGame()
  const { token, state, conn, notice, setToken, send, dismissNotice } = game

  const sendAndMaybeLeave = useCallback(
    (msg: ClientMessage) => {
      send(msg)
      if (msg.type === 'leave_room') setToken(null)
    },
    [send, setToken],
  )

  if (!token) {
    return <Home notice={notice} onDismissNotice={dismissNotice} onJoined={setToken} />
  }

  return (
    <>
      {conn !== 'open' && (
        <div className="banner banner--conn" role="status">
          {conn === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Connecting…'}
          <button type="button" className="btn btn--link" onClick={() => setToken(null)}>
            Leave
          </button>
        </div>
      )}
      {notice && (
        <div className={`banner banner--${notice.kind}`} role="alert">
          <span>{notice.text}</span>
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
        <Lobby state={state} send={sendAndMaybeLeave} />
      ) : state.room.status === 'finished' ? (
        <EndGame state={state} send={sendAndMaybeLeave} />
      ) : (
        <Game state={state} send={send} />
      )}
    </>
  )
}

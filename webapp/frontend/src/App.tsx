import { useCallback, useState } from 'react'
import { EndGame, Game } from './components/Game'
import { Home } from './components/Home'
import { Lobby } from './components/Lobby'
import { NoticeLabel } from './components/Common'
import { TutorialLayout } from './components/TutorialCard'
import type { ClientMessage } from './types'
import { tutorialCue, type TutorialScreen } from './tutorial'
import { useGame } from './useGame'

const TUTORIAL_KEY = 'dixvoice.tutorial'

export default function App() {
  const game = useGame()
  const { token, state, conn, notice, setToken, send, dismissNotice } = game
  const [tutorialEnabled, setTutorialEnabled] = useState(() => {
    try {
      return localStorage.getItem(TUTORIAL_KEY) !== 'off'
    } catch {
      return true
    }
  })

  const toggleTutorial = () => {
    const enabled = !tutorialEnabled
    setTutorialEnabled(enabled)
    try {
      localStorage.setItem(TUTORIAL_KEY, enabled ? 'on' : 'off')
    } catch {
      return
    }
  }

  const sendAndMaybeLeave = useCallback(
    (msg: ClientMessage) => {
      send(msg)
      if (msg.type === 'leave_room') setToken(null)
    },
    [send, setToken],
  )

  const screen: TutorialScreen = !token ? 'home' : state?.room.status === 'lobby' ? 'lobby' : state?.room.status === 'finished' ? 'endGame' : 'game'
  const currentCue = tutorialEnabled ? tutorialCue(state, screen) : null

  return (
    <>
      {token && conn !== 'open' && (
        <div className="banner banner--conn" role="status">
          <NoticeLabel kind="warning" />
          <span className="banner__text">{conn === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Connecting…'}</span>
          <button type="button" className="btn btn--link" onClick={() => setToken(null)}>
            Leave
          </button>
        </div>
      )}
      {token && notice && (
        <div className={`banner banner--${notice.kind}`} role="alert">
          <NoticeLabel kind={notice.kind} />
          <span className="banner__text">{notice.text}</span>
          <button type="button" className="btn btn--link" onClick={dismissNotice} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <TutorialLayout key={currentCue?.key ?? 'none'} cue={currentCue}>
        {!token ? (
          <Home notice={notice} onDismissNotice={dismissNotice} onJoined={setToken} />
        ) : !state ? (
          <main className="screen">
            <p className="waiting">Loading room…</p>
          </main>
        ) : state.room.status === 'lobby' ? (
          <Lobby state={state} send={sendAndMaybeLeave} />
        ) : state.room.status === 'finished' ? (
          <EndGame state={state} send={sendAndMaybeLeave} />
        ) : (
          <Game state={state} send={send} tutorialEnabled={tutorialEnabled} onToggleTutorial={toggleTutorial} />
        )}
      </TutorialLayout>
    </>
  )
}

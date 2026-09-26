import { useCallback, useEffect, useState } from 'react'
import { EndGame, Game } from './components/Game'
import { Home } from './components/Home'
import { Lobby } from './components/Lobby'
import { NoticeLabel } from './components/Common'
import type { TourControls } from './components/TutorialCard'
import { sfx } from './sfx'
import type { ClientMessage } from './types'
import { tourStep, tutorialCue, type TutorialScreen } from './tutorial'
import { useGame } from './useGame'
import { useQuickStart } from './useQuickStart'
import { useSfxCues } from './useSfxCues'
import { useTour } from './useTour'

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

  const { explained, markExplained, skipTour, replayTour } = useTour()
  const [showScores, setShowScores] = useState(false)

  useSfxCues(state, notice)

  // One click sound for every .btn, delegated.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('.btn')) sfx('click')
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const toggleTutorial = () => {
    const enabled = !tutorialEnabled
    setTutorialEnabled(enabled)
    try {
      localStorage.setItem(TUTORIAL_KEY, enabled ? 'on' : 'off')
    } catch {
      return
    }
  }
  const { quick, begin, dismiss } = useQuickStart({
    token,
    state,
    conn,
    notice,
    send,
  })

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

  const screen: TutorialScreen = !token ? 'home' : state?.room.status === 'lobby' ? 'lobby' : state?.room.status === 'finished' ? 'endGame' : 'game'
  const currentCue = tutorialEnabled ? tutorialCue(state, screen) : null
  const step = tutorialEnabled ? tourStep(state, screen, { scoresOpen: showScores }, explained) : null
  const tour: TourControls | null = step ? { step, onNext: () => markExplained(step.section), onSkip: skipTour } : null

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
      {!token ? (
        <Home notice={notice} onDismissNotice={dismissNotice} onJoined={onJoined} onQuickStart={onQuickStart} tour={tour} />
      ) : !state ? (
        <main className="screen">
          <p className="waiting">Loading room…</p>
        </main>
      ) : state.room.status === 'lobby' ? (
        <Lobby state={state} send={sendAndMaybeLeave} quick={quick} onDismissQuick={dismiss} cue={currentCue} tour={tour} />
      ) : state.room.status === 'finished' ? (
        <EndGame state={state} send={sendAndMaybeLeave} tour={tour} />
      ) : (
        <Game
          state={state}
          send={send}
          tutorialEnabled={tutorialEnabled}
          onToggleTutorial={toggleTutorial}
          onReplayTour={replayTour}
          cue={currentCue}
          tour={tour}
          showScores={showScores}
          onToggleScores={() => setShowScores((s) => !s)}
        />
      )}
    </>
  )
}

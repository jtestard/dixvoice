import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, GameState } from './types'
import type { ConnStatus, Notice } from './useGame'

export const QUICK_START_COMPANIONS = 3
export const QUICK_START_MIN_PLAYERS = 4
export const QUICK_START_TIMEOUT_MS = 20000

const RETRY_TEXT = 'You can add AI companions manually or invite friends with the room code.'
export const QUICK_START_STOPPED_TEXT = `Quick start stopped. ${RETRY_TEXT}`
export const QUICK_START_TIMEOUT_TEXT = `The AI companions did not join in time. ${RETRY_TEXT}`

export type QuickStart = { status: 'adding'; added: number } | { status: 'failed'; text: string }

export function isQuickStartActive(quick: QuickStart | null): boolean {
  return quick !== null && quick.status !== 'failed'
}

interface Input {
  token: string | null
  state: GameState | null
  conn: ConnStatus
  notice: Notice | null
  send: (msg: ClientMessage) => void
}

export interface QuickStartControls {
  quick: QuickStart | null
  begin: () => void
  dismiss: () => void
}

interface Run {
  failedText: string | null
}

function deriveQuick(run: Run | null, token: string | null, state: GameState | null): QuickStart | null {
  if (!run || !token) return null
  if (run.failedText) return { status: 'failed', text: run.failedText }
  if (!state) return { status: 'adding', added: 0 }
  if (state.room.status !== 'lobby') return null
  // Once the table is full enough, quick start is done: the player presses Start themselves.
  if (state.players.length >= QUICK_START_MIN_PLAYERS) return null
  return { status: 'adding', added: state.players.filter((p) => p.isCompanion).length }
}

// Drives the Quick start sequence over the normal protocol: once connected to the lobby, send `add_companion`
// one at a time (waiting for each companion to appear in the state). It does NOT start the game: the Start
// button arms itself and the player presses it.
export function useQuickStart({ token, state, conn, notice, send }: Input): QuickStartControls {
  const [run, setRun] = useState<Run | null>(null)
  const sentRef = useRef(0)

  const quick = deriveQuick(run, token, state)
  const active = isQuickStartActive(quick)

  const begin = useCallback(() => {
    sentRef.current = 0
    setRun({ failedText: null })
  }, [])

  const dismiss = useCallback(() => setRun(null), [])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => setRun({ failedText: QUICK_START_TIMEOUT_TEXT }), QUICK_START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [active])

  useEffect(() => {
    if (!active) return
    if (notice?.kind === 'error') {
      // Latch the failure so it survives the banner being dismissed.
      // oxlint-disable-next-line react/set-state-in-effect
      setRun({ failedText: QUICK_START_STOPPED_TEXT })
      return
    }
    if (!state || conn !== 'open' || state.room.status !== 'lobby') return
    if (state.players.length >= QUICK_START_MIN_PLAYERS) return
    const joined = state.players.filter((p) => p.isCompanion).length
    if (sentRef.current < QUICK_START_COMPANIONS && joined >= sentRef.current) {
      sentRef.current += 1
      send({ type: 'add_companion' })
    }
  }, [active, state, conn, notice, send])

  return { quick, begin, dismiss }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { TOKEN_KEY, errorText, wsUrl } from './api'
import type { ClientMessage, GameState, ServerMessage } from './types'

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting'

export interface Notice {
  kind: 'error' | 'info'
  text: string
}

export interface Game {
  token: string | null
  state: GameState | null
  conn: ConnStatus
  notice: Notice | null
  setToken: (token: string | null) => void
  send: (msg: ClientMessage) => void
  dismissNotice: () => void
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10000

const ROOM_CLOSED_TEXT: Record<string, string> = {
  stopped: 'The room was stopped.',
  removed: 'You were removed from the room.',
}

export function roomClosedText(reason: string): string {
  return ROOM_CLOSED_TEXT[reason] ?? `Room closed (${reason}).`
}

export function useGame(): Game {
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [state, setState] = useState<GameState | null>(null)
  const [conn, setConn] = useState<ConnStatus>('idle')
  const [notice, setNotice] = useState<Notice | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  const setToken = useCallback((t: string | null) => {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
    setTokenState(t)
    if (!t) {
      setState(null)
      setConn('idle')
    }
  }, [])

  useEffect(() => {
    if (!token) return
    let closed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let everOpened = false

    const connect = () => {
      setConn(everOpened ? 'reconnecting' : 'connecting')
      const ws = new WebSocket(wsUrl(token))
      socketRef.current = ws

      ws.onopen = () => {
        attempt = 0
        everOpened = true
        setConn('open')
      }
      ws.onmessage = (ev) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage
        } catch {
          return
        }
        if (msg.type === 'state') {
          setState(msg)
        } else if (msg.type === 'error') {
          setNotice({ kind: 'error', text: errorText(msg.code, msg.message) })
        } else if (msg.type === 'room_closed') {
          closed = true
          ws.close()
          setToken(null)
          setNotice({ kind: 'info', text: roomClosedText(msg.reason) })
        }
      }
      ws.onclose = (ev) => {
        if (socketRef.current === ws) socketRef.current = null
        if (closed) return
        // 4xxx codes are used by the backend for permanent rejections (e.g. unknown token).
        if (ev.code >= 4000 && ev.code < 5000) {
          closed = true
          setToken(null)
          setNotice({ kind: 'error', text: ev.reason || 'Your session is no longer valid.' })
          return
        }
        attempt += 1
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 4))
        setConn('reconnecting')
        timer = setTimeout(connect, delay)
      }
      ws.onerror = () => {
        /* onclose follows */
      }
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      const ws = socketRef.current
      socketRef.current = null
      if (ws) ws.close()
    }
  }, [token, setToken])

  const send = useCallback((msg: ClientMessage) => {
    const ws = socketRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      setNotice({ kind: 'error', text: 'Not connected. Reconnecting…' })
    }
  }, [])

  const dismissNotice = useCallback(() => setNotice(null), [])

  return { token, state, conn, notice, setToken, send, dismissNotice }
}

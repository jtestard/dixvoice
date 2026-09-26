let element: HTMLAudioElement | null = null
let unlocked = false
let listeners: Array<(key: string | null) => void> = []

function notify(key: string | null) {
  for (const l of listeners) l(key)
}

export function onPlayingChange(listener: (key: string | null) => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function unlock() {
  if (unlocked) return
  unlocked = true
  const nav = navigator as Navigator & { audioSession?: { type: string } }
  if (nav.audioSession) {
    try {
      nav.audioSession.type = 'playback'
    } catch {
      /* unsupported value */
    }
  }
}

function getElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio()
    element.preload = 'auto'
    element.addEventListener('ended', () => notify(null))
    element.addEventListener('pause', () => notify(null))
    element.addEventListener('error', () => notify(null))
  }
  return element
}

/** Plays a clip, identified by `key` for the playing indicator. Must be called from a user gesture (tap). */
export function playClip(url: string, key: string = url): void {
  unlock()
  const el = getElement()
  if (!el.paused) el.pause()
  el.src = url
  el.currentTime = 0
  notify(key)
  el.play().catch(() => notify(null))
}

export function stopClip(): void {
  if (element && !element.paused) element.pause()
}

let element: HTMLAudioElement | null = null
let context: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buffer: Uint8Array | null = null
let corsOk = true
let unlocked = false
let currentKey: string | null = null
let listeners: Array<(key: string | null) => void> = []

function notify(key: string | null) {
  currentKey = key
  for (const l of listeners) l(key)
}

export function onPlayingChange(listener: (key: string | null) => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

/** Shared AudioContext (also used by sfx.ts). Created lazily, always from a tap. */
export function audioContext(): AudioContext | null {
  if (!context) {
    const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    try {
      context = new AC()
    } catch {
      return null
    }
  }
  if (context.state === 'suspended') void context.resume().catch(() => {})
  return context
}

function unlock() {
  audioContext()
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

function build(live: boolean): HTMLAudioElement {
  if (element) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
  const el = new Audio()
  el.preload = 'auto'
  el.dataset.live = String(live)
  if (live) el.crossOrigin = 'anonymous'
  // `pause` also fires when src changes: only report a stop if the element really is stopped.
  const stopped = () => {
    if (el === element && (el.paused || el.ended)) notify(null)
  }
  el.addEventListener('ended', stopped)
  el.addEventListener('pause', stopped)
  el.addEventListener('error', () => {
    if (live && el === element && corsOk && currentKey) {
      corsOk = false // CORS refused: retry once without the analyser
      const src = el.currentSrc || el.src
      build(false).src = src
      element!.play().catch(() => notify(null))
      return
    }
    notify(null)
  })
  element = el
  analyser = null
  const ctx = live ? audioContext() : null
  if (ctx) {
    try {
      const node = ctx.createMediaElementSource(el)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      buffer = new Uint8Array(analyser.fftSize)
      node.connect(analyser)
      analyser.connect(ctx.destination)
    } catch {
      analyser = null
    }
  }
  return el
}

/** Plays a clip, identified by `key` for the playing indicator. Must be called from a user gesture (tap). */
export function playClip(url: string, key: string = url): void {
  unlock()
  const live = corsOk && audioContext() !== null
  if (!element || element.dataset.live !== String(live)) build(live)
  const el = element!
  if (!el.paused) el.pause()
  el.src = url
  el.currentTime = 0
  notify(key)
  el.play().catch(() => notify(null))
}

export function stopClip(): void {
  if (element && !element.paused) element.pause()
}

/** Fills `out` with RMS levels (0..1) of what is playing right now. False = no analyser (CORS fallback). */
export function sampleWave(out: Float32Array): boolean {
  if (!analyser || !buffer) return false
  analyser.getByteTimeDomainData(buffer)
  const chunk = Math.floor(buffer.length / out.length)
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let j = 0; j < chunk; j++) {
      const v = (buffer[i * chunk + j] - 128) / 128
      sum += v * v
    }
    out[i] = Math.sqrt(sum / chunk)
  }
  return true
}

/** 0..1 progress of the current clip. */
export function progress(): number {
  const el = element
  return el && el.duration ? Math.min(1, el.currentTime / el.duration) : 0
}

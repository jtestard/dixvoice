import { audioContext } from './audio'

const SFX_KEY = 'dixvoice.sfx'
let enabled = (() => {
  try {
    return localStorage.getItem(SFX_KEY) !== 'off'
  } catch {
    return true
  }
})()

export function sfxEnabled(): boolean {
  return enabled
}

export function setSfxEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(SFX_KEY, on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
}

interface Tone {
  f?: number
  f2?: number
  d?: number
  type?: OscillatorType
  g?: number
  t?: number
}

interface Noise {
  d?: number
  g?: number
  f?: number
  f2?: number
  q?: number
  t?: number
}

function tone({ f = 440, f2 = 0, d = 0.1, type = 'square', g = 0.06, t = 0 }: Tone) {
  const c = audioContext()
  if (!c) return
  const now = c.currentTime + t
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(f, now)
  if (f2) osc.frequency.exponentialRampToValueAtTime(f2, now + d)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(g, now + 0.006)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + d)
  osc.connect(gain).connect(c.destination)
  osc.start(now)
  osc.stop(now + d + 0.03)
}

function noise({ d = 0.08, g = 0.1, f = 1500, f2 = 0, q = 1, t = 0 }: Noise) {
  const c = audioContext()
  if (!c) return
  const len = Math.ceil(c.sampleRate * d)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const ch = buf.getChannelData(0)
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const flt = c.createBiquadFilter()
  flt.type = 'bandpass'
  flt.Q.value = q
  const now = c.currentTime + t
  flt.frequency.setValueAtTime(f, now)
  if (f2) flt.frequency.exponentialRampToValueAtTime(f2, now + d)
  const gain = c.createGain()
  gain.gain.setValueAtTime(g, now)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + d)
  src.connect(flt).connect(gain).connect(c.destination)
  src.start(now)
  src.stop(now + d + 0.03)
}

export type Sfx =
  | 'click'
  | 'deal'
  | 'select'
  | 'submit'
  | 'place'
  | 'flip'
  | 'stamp'
  | 'tick'
  | 'win'
  | 'lose'
  | 'join'
  | 'fanfare'
  | 'type'
  | 'clue'
  | 'correct'
  | 'error'

/** All sounds are synthesised (no files). `i` staggers repeats (deal, flip) or raises the pitch (tick). */
export function sfx(name: Sfx, i = 0): void {
  if (!enabled) return
  switch (name) {
    case 'click':
      noise({ d: 0.03, g: 0.12, f: 2500, q: 2 })
      tone({ f: 1200, d: 0.03, g: 0.02 })
      break
    case 'deal':
      noise({ d: 0.09, g: 0.14, f: 900, f2: 2600, q: 1.5, t: i * 0.05 })
      break
    case 'select':
      tone({ f: 520, f2: 780, d: 0.09, type: 'triangle', g: 0.08 })
      break
    case 'submit':
      noise({ d: 0.2, g: 0.14, f: 600, f2: 3200 })
      tone({ f: 160, f2: 70, d: 0.16, type: 'sine', g: 0.18, t: 0.16 })
      break
    case 'place':
      noise({ d: 0.06, g: 0.1, f: 1400, q: 2 })
      tone({ f: 200, f2: 120, d: 0.08, type: 'sine', g: 0.1 })
      break
    case 'flip':
      noise({ d: 0.05, g: 0.1, f: 3200, q: 3, t: i * 0.045 })
      break
    case 'stamp':
      tone({ f: 110, f2: 55, d: 0.14, type: 'sine', g: 0.3 })
      noise({ d: 0.05, g: 0.2, f: 700 })
      break
    case 'tick':
      tone({ f: 880 * Math.pow(1.06, i), d: 0.05, g: 0.04 })
      break
    case 'win':
      ;[523.25, 659.25, 783.99, 1046.5].forEach((f, k) => tone({ f, d: 0.18, type: 'triangle', g: 0.09, t: k * 0.09 }))
      break
    case 'lose':
      ;[392, 311.13, 261.63].forEach((f, k) => tone({ f, d: 0.22, type: 'triangle', g: 0.08, t: k * 0.14 }))
      break
    case 'join':
      tone({ f: 660, d: 0.07, type: 'sine', g: 0.08 })
      tone({ f: 990, d: 0.1, type: 'sine', g: 0.07, t: 0.07 })
      break
    case 'fanfare':
      ;[523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5].forEach((f, k) => tone({ f, d: 0.2, g: 0.045, t: k * 0.11 }))
      break
    case 'type':
      noise({ d: 0.02, g: 0.05, f: 4000, q: 2 })
      break
    case 'clue':
      tone({ f: 440, f2: 660, d: 0.12, type: 'sine', g: 0.07 })
      noise({ d: 0.08, g: 0.08, f: 2000, q: 2 })
      break
    case 'correct':
      ;[659.25, 987.77].forEach((f, k) => tone({ f, d: 0.16, type: 'sine', g: 0.08, t: k * 0.1 }))
      break
    case 'error':
      tone({ f: 220, f2: 180, d: 0.16, g: 0.05 })
      break
  }
}

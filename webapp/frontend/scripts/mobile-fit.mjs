#!/usr/bin/env node
/**
 * Mobile no-scroll check.
 *
 * Starts the mock backend and the Vite dev server, then drives a real game in headless
 * Chromium at phone portrait viewports. For every screen (home, lobby, each round phase as
 * storyteller and as a player, end of game) it asserts that
 *   - the page does not scroll: scrollHeight <= innerHeight and scrollWidth <= innerWidth,
 *   - the clue, every clip on the table / in the hand and the primary button are inside the viewport.
 * Runs with 4 players (short clue), 4 players (long clue) and 8 players (long clue).
 *
 * Usage: npm run check:mobile [-- --shots] [--viewports 360x640,390x844]
 * Screenshots go to mobile-fit/ (360x640 and 390x844 by default when --shots is given).
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const SHOTS = args.includes('--shots')
const SHOT_VIEWPORTS = new Set((process.env.SHOT_VIEWPORTS ?? '360x640,390x844').split(','))
const viewArg = args[args.indexOf('--viewports') + 1]
const VIEWPORTS = (args.includes('--viewports') && viewArg ? viewArg.split(',') : ['360x640', '375x667', '390x844', '412x915']).map((v) => {
  const [w, h] = v.split('x').map(Number)
  return { width: w, height: h, name: v }
})
const CONFIGS = [
  { players: 4, clue: 'a door in the rain' },
  { players: 4, clue: 'the last train leaving a station nobody remembers, somewhere between midnight and the morning news' },
  { players: 8, clue: 'the last train leaving a station nobody remembers, somewhere between midnight and the morning news' },
]

const MOCK_PORT = 18080
const VITE_PORT = 5175
const BACKEND = `http://localhost:${MOCK_PORT}`
const SHOT_DIR = path.join(root, 'mobile-fit')

// ---------------------------------------------------------------- servers
async function startMock() {
  const child = spawn(process.execPath, ['mock/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(MOCK_PORT), MOCK_BOT_DELAY_MS: '100' }, stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BACKEND}/healthz`)
      if (res.ok) return child
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error('mock backend did not start')
}

async function startVite() {
  process.env.VITE_BACKEND_URL = BACKEND
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: VITE_PORT, strictPort: true } })
  await server.listen()
  return server
}

// ---------------------------------------------------------------- mock room driven from node
async function api(url, body) {
  const res = await fetch(`${BACKEND}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`)
  return res.json()
}

/** Node-side player: keeps the latest state and lets the script act for that player. */
class Bot {
  constructor(nick, token, playerId) {
    this.nick = nick
    this.token = token
    this.playerId = playerId
    this.state = null
    this.ws = null
    this.waiters = []
  }
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${MOCK_PORT}/ws?token=${this.token}`)
      this.ws = ws
      ws.on('open', resolve)
      ws.on('error', reject)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'state') return
        this.state = msg
        this.waiters = this.waiters.filter((w) => !w(msg))
      })
    })
  }
  /** Drop the socket so the browser can take this seat (the mock replaces the socket anyway). */
  close() {
    if (this.ws) this.ws.close()
    this.ws = null
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg))
  }
  waitFor(pred, what, timeout = 10000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.nick}: timed out waiting for ${what}`)), timeout)
      this.waiters.push((s) => {
        if (!pred(s)) return false
        clearTimeout(t)
        resolve(s)
        return true
      })
    })
  }
}

async function createRoom(n) {
  const host = await api('/rooms', { nickname: 'You' })
  const bots = [new Bot('You', host.token, host.playerId)]
  for (let i = 1; i < n; i++) {
    const nick = ['Ana', 'Ben', 'Chloé', 'Dmitri', 'Esperanza', 'Fatoumata', 'Guillaume'][i - 1]
    const j = await api(`/rooms/${host.roomCode}/join`, { nickname: nick })
    bots.push(new Bot(nick, j.token, j.playerId))
  }
  for (const b of bots) await b.connect()
  return { code: host.roomCode, bots }
}

// ---------------------------------------------------------------- browser helpers
const failures = []
let checks = 0

function report(ok, label, detail) {
  checks++
  if (!ok) {
    failures.push(`${label}: ${detail}`)
    console.log(`  FAIL ${label}: ${detail}`)
  }
}

/** Load the app as the given seat (token in localStorage), waiting for the WebSocket to be open. */
async function loadAs(page, bot, url) {
  bot.close()
  await page.goto(url)
  await page.evaluate((t) => localStorage.setItem('dixvoice.token', t), bot.token)
  await page.reload()
  await page.locator('.banner--conn').waitFor({ state: 'hidden', timeout: 10000 })
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(450) // deal / flip animations
}

/**
 * Assert the page does not scroll and that the given elements are fully inside the viewport.
 * `expect` = { clue?: true, cards?: number, primary?: Locator | string }
 */
async function check(page, ctx, screen, expect = {}) {
  await settle(page)
  const label = `${ctx.viewport.name} ${ctx.players}p ${ctx.clueKind} ${screen}`
  const metrics = await page.evaluate(() => {
    const d = document.documentElement
    return { sh: d.scrollHeight, ih: window.innerHeight, sw: d.scrollWidth, iw: window.innerWidth, sy: window.scrollY, sx: window.scrollX }
  })
  report(metrics.sh <= metrics.ih, label, `page scrolls vertically: scrollHeight ${metrics.sh} > innerHeight ${metrics.ih}`)
  report(metrics.sw <= metrics.iw, label, `page scrolls horizontally: scrollWidth ${metrics.sw} > innerWidth ${metrics.iw}`)
  report(metrics.sy === 0 && metrics.sx === 0, label, `page is scrolled (${metrics.sx}, ${metrics.sy})`)

  const inView = async (locator, what) => {
    const boxes = await locator.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, w: r.width, h: r.height }
    }))
    boxes.forEach((b, i) => {
      const ok = b.w > 0 && b.h > 0 && b.top >= -0.5 && b.left >= -0.5 && b.bottom <= metrics.ih + 0.5 && b.right <= metrics.iw + 0.5
      report(ok, label, `${what}${boxes.length > 1 ? ` #${i + 1}` : ''} not inside viewport: ${JSON.stringify(b)} (viewport ${metrics.iw}x${metrics.ih})`)
    })
    return boxes
  }

  if (expect.clue) {
    const clue = page.locator('.clue__text')
    report((await clue.count()) === 1, label, 'clue missing')
    await inView(clue, 'clue')
  }
  if (expect.cards) {
    const tapes = page.locator('.hand .clip-card__tape, .hand .facedown')
    const n = await tapes.count()
    report(n === expect.cards, label, `expected ${expect.cards} clips, found ${n}`)
    const boxes = await inView(tapes, 'clip')
    boxes.forEach((b, i) => report(b.w >= 44 && b.h >= 44, label, `clip #${i + 1} smaller than a 44px tap target: ${b.w}x${b.h}`))
    const actions = page.locator('.hand .clip-card > .btn')
    const na = await actions.count()
    if (na) {
      const ab = await inView(actions, 'clip action button')
      ab.forEach((b, i) => report(b.h >= 44 && b.w >= 44, label, `clip action button #${i + 1} smaller than 44px: ${b.w}x${b.h}`))
    }
  }
  if (expect.primary) {
    const btn = typeof expect.primary === 'string' ? page.getByRole('button', { name: expect.primary, exact: true }) : expect.primary
    report((await btn.count()) >= 1, label, `primary button ${typeof expect.primary === 'string' ? expect.primary : ''} missing`)
    await inView(btn, `primary button`)
  }
  if (expect.focus) {
    const input = page.getByLabel(expect.focus)
    await input.focus()
    await inView(input, `focused input ${expect.focus}`)
  }

  if (SHOTS && SHOT_VIEWPORTS.has(ctx.viewport.name)) {
    const file = path.join(SHOT_DIR, `${ctx.viewport.name}-${ctx.players}p-${ctx.clueKind}-${screen}.png`)
    await page.screenshot({ path: file })
  }
}

// ---------------------------------------------------------------- the scenario
async function runScenario(browser, viewport, config) {
  const url = `http://localhost:${VITE_PORT}/`
  const clueKind = config.clue.length > 40 ? 'long' : 'short'
  const ctx = { viewport, players: config.players, clueKind }
  console.log(`\n== ${viewport.name}, ${config.players} players, ${clueKind} clue`)
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => report(false, `${viewport.name} ${config.players}p`, `page error: ${e.message}`))

  // Home (with the cue card, tutorial on by default)
  await page.goto(url)
  await page.getByLabel('Nickname').fill('You')
  await check(page, ctx, 'home', { primary: 'Quick start', focus: 'Room code' })

  // Lobby with N players
  const room = await createRoom(config.players)
  const [host] = room.bots
  await loadAs(page, host, url)
  await page.getByRole('button', { name: 'Start game' }).waitFor()
  await check(page, ctx, 'lobby', { primary: 'Start game' })

  // Start from the browser; the mock picks a random storyteller.
  await page.getByRole('button', { name: 'Start game' }).click()
  let s = await room.bots[1].waitFor((st) => st.room.status === 'playing', 'game start')
  const stId = s.round.storytellerId
  const S = room.bots.find((b) => b.playerId === stId)
  const others = room.bots.filter((b) => b !== S)
  const Q = others[0] // the seat the browser takes as "a player"
  const X = others[1] // everyone votes for X's clip so the game ends quickly
  const nodeOthers = others.filter((b) => b !== Q)
  const anyBot = X // never taken over by the browser, so its socket stays open

  // --- storyteller phase
  await loadAs(page, Q, url)
  await page.getByText(/Waiting for .* to pick a clip/).waitFor()
  await check(page, ctx, 'storyteller-player', { cards: 6 })
  await loadAs(page, S, url)
  await page.getByRole('button', { name: 'Send clue' }).waitFor()
  await check(page, ctx, 'storyteller-storyteller', { cards: 6, primary: 'Send clue', focus: 'Your clue' })
  await page.getByRole('button', { name: 'Pick' }).first().click()
  await page.getByLabel('Your clue').fill(config.clue)
  await page.getByRole('button', { name: 'Send clue' }).click()
  await anyBot.waitFor((st) => st.round?.phase === 'submit', 'submit phase')

  // --- submit phase: storyteller waits, then the player submits from the browser
  await page.getByText(/Waiting for the other players to submit/).waitFor()
  await check(page, ctx, 'submit-storyteller', { clue: true })
  await loadAs(page, Q, url)
  await page.getByRole('button', { name: 'Submit' }).first().waitFor()
  await check(page, ctx, 'submit-player', { clue: true, cards: 6, primary: page.getByRole('button', { name: 'Submit' }) })
  for (const b of nodeOthers) {
    await b.connect()
    b.send({ type: 'submit_clip', clipId: b.state.you.hand[0].clipId })
  }
  await page.getByRole('button', { name: 'Submit' }).first().click()
  s = await anyBot.waitFor((st) => st.round?.phase === 'vote', 'vote phase')
  const xClip = X.state.you.hand[0].clipId

  // --- vote phase: player votes from the browser (for X's clip), storyteller watches
  await page.getByRole('button', { name: 'Vote' }).first().waitFor()
  await check(page, ctx, 'vote-player', { clue: true, cards: config.players, primary: page.getByRole('button', { name: 'Vote' }) })
  await page.getByTestId(`clip-${xClip}`).getByRole('button', { name: 'Vote' }).click()
  await page.getByText(/Vote cast/).waitFor()
  await loadAs(page, S, url)
  await page.getByText(/The others are voting/).waitFor()
  await check(page, ctx, 'vote-storyteller', { clue: true, cards: config.players })
  for (const b of nodeOthers) {
    await b.connect()
    b.send({ type: 'vote', clipId: b === X ? s.round.table.find((c) => c.clipId !== xClip).clipId : xClip })
  }
  await anyBot.waitFor((st) => st.round?.phase === 'reveal', 'reveal phase')

  // --- reveal: both roles, then Next round from the browser
  await page.getByRole('button', { name: 'Next round' }).waitFor()
  await check(page, ctx, 'reveal-storyteller', { clue: true, cards: config.players, primary: 'Next round' })
  await loadAs(page, Q, url)
  await page.getByRole('button', { name: 'Next round' }).waitFor()
  await check(page, ctx, 'reveal-player', { clue: true, cards: config.players, primary: 'Next round' })

  // Scores sheet opened from the header
  await page.getByRole('button', { name: 'Scores' }).click()
  await page.getByRole('dialog').waitFor()
  await check(page, ctx, 'reveal-scores-sheet', { primary: page.getByRole('button', { name: 'Close' }) })
  await page.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'Next round' }).click()

  // --- play the remaining rounds from node until someone reaches the target
  await page.goto('about:blank')
  for (const b of room.bots) await b.connect()
  for (let guard = 0; guard < 12; guard++) {
    const st = await anyBot.waitFor((st) => st.room.status === 'finished' || (st.round && st.round.phase === 'storyteller'), 'next round or end')
    if (st.room.status === 'finished') break
    const num = st.round.number
    const inPhase = (phase) => (s2) => s2.round?.number === num && s2.round.phase === phase
    const storyteller = room.bots.find((b) => b.playerId === st.round.storytellerId)
    const rest = room.bots.filter((b) => b !== storyteller)
    const target = rest[0]
    const own = await storyteller.waitFor(inPhase('storyteller'), `round ${num}`)
    storyteller.send({ type: 'submit_clue', clipId: own.you.hand[0].clipId, clue: config.clue })
    for (const b of rest) {
      const mine = await b.waitFor(inPhase('submit'), 'submit')
      b.send({ type: 'submit_clip', clipId: mine.you.hand[0].clipId })
    }
    const targetClip = target.state.you.hand[0].clipId
    for (const b of rest) {
      const v = await b.waitFor(inPhase('vote'), 'vote')
      b.send({ type: 'vote', clipId: b === target ? v.round.table.find((c) => c.clipId !== targetClip).clipId : targetClip })
    }
    await anyBot.waitFor(inPhase('reveal'), 'reveal')
    anyBot.send({ type: 'next_round' })
  }
  await anyBot.waitFor((st) => st.room.status === 'finished', 'game end')

  // --- end of game
  await loadAs(page, host, url)
  await page.getByText('Game over').waitFor()
  await check(page, ctx, 'end', { primary: 'Leave' })

  for (const b of room.bots) b.close()
  await context.close()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------- main
const mock = await startMock()
const vite = await startVite()
const browser = await chromium.launch()
try {
  if (SHOTS) await mkdir(SHOT_DIR, { recursive: true })
  for (const viewport of VIEWPORTS) {
    for (const config of CONFIGS) {
      try {
        await runScenario(browser, viewport, config)
      } catch (e) {
        report(false, `${viewport.name} ${config.players}p`, `scenario aborted: ${e.message}`)
      }
    }
  }
} finally {
  await browser.close()
  await vite.close()
  mock.kill()
}

console.log(`\n${checks} checks, ${failures.length} failures`)
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'))
  process.exit(1)
}

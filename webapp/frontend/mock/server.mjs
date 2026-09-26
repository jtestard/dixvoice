// Dev mock of the Dixvoice backend (README > Web App > Back-End > Protocol).
// Every room gets 3 bot players so a single human can play a whole game.
// Not the real backend: no persistence, minimal validation, bots act after a short delay.
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8080)
const BOTS = Number(process.env.MOCK_BOTS ?? 3)
const BOT_DELAY_MS = Number(process.env.MOCK_BOT_DELAY_MS ?? 1500)
const TARGET_SCORE = 10
const HAND_SIZE = 6
const POOL_SIZE = Number(process.env.MOCK_POOL_SIZE ?? 240)

const clipsDir = resolve(import.meta.dirname, 'clips')
const clipFiles = readdirSync(clipsDir).filter((f) => f.endsWith('.mp3')).sort()
const clipData = new Map(clipFiles.map((f) => [f, readFileSync(resolve(clipsDir, f))]))
const BOT_NAMES = ['Ana', 'Ben', 'Chloé', 'Dmitri', 'Eve', 'Farid', 'Gus']
const BOT_CLUES = ['a door in the rain', 'lost in the fog', 'the last train', 'someone is watching', 'summer at grandma’s', 'broken glass', 'a secret', 'wake up']

const baseUrl = (req) => `http://${req.headers.host ?? `localhost:${PORT}`}`
const sounds = (req) =>
  Array.from({ length: POOL_SIZE }, (_, i) => ({
    id: `snd-${String(i + 1).padStart(4, '0')}`,
    clipUrl: `${baseUrl(req)}/clips/${clipFiles[i % clipFiles.length]}`,
  }))

const rooms = new Map() // code -> room
const tokens = new Map() // token -> { code, playerId }

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
const pick = (a) => a[Math.floor(Math.random() * a.length)]

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  let code
  do code = Array.from({ length: 4 }, () => pick(letters)).join('')
  while (rooms.has(code))
  return code
}

function addPlayer(room, nickname, bot = false) {
  const player = {
    playerId: `p${room.nextId++}`,
    nickname,
    connected: bot,
    score: 0,
    hand: [],
    submission: null,
    vote: null,
    bot,
    socket: null,
  }
  room.players.push(player)
  return player
}

function createRoom(req) {
  const room = {
    code: newCode(),
    status: 'lobby',
    players: [],
    nextId: 1,
    used: new Set(),
    pool: sounds(req),
    round: null,
    winnerIds: [],
    storytellerIndex: -1,
  }
  rooms.set(room.code, room)
  for (let i = 0; i < BOTS; i++) addPlayer(room, BOT_NAMES[i % BOT_NAMES.length], true)
  return room
}

function deleteRoom(room, reason) {
  for (const p of room.players) {
    if (p.socket) {
      sendTo(p, { type: 'room_closed', reason })
      p.socket.close(1000, 'room closed')
      p.socket = null
    }
  }
  for (const [t, v] of tokens) if (v.code === room.code) tokens.delete(t)
  rooms.delete(room.code)
  console.log(`room ${room.code} deleted (${reason})`)
}

// ---- game logic ----
function deal(room) {
  const available = shuffle(room.pool.filter((s) => !room.used.has(s.id)))
  if (available.length < room.players.length * HAND_SIZE) return false
  for (const p of room.players) {
    p.hand = available.splice(0, HAND_SIZE).map((s) => ({ clipId: s.id, clipUrl: s.clipUrl }))
    for (const c of p.hand) room.used.add(c.clipId)
    p.submission = null
    p.vote = null
  }
  return true
}

function startGame(room) {
  for (const p of room.players) p.score = 0
  room.winnerIds = []
  room.status = 'playing'
  room.storytellerIndex = Math.floor(Math.random() * room.players.length) - 1
  room.round = null
  startRound(room)
}

function startRound(room) {
  if (!deal(room)) return finishGame(room)
  room.storytellerIndex = (room.storytellerIndex + 1) % room.players.length
  room.round = {
    number: (room.round?.number ?? 0) + 1,
    phase: 'storyteller',
    storytellerId: room.players[room.storytellerIndex].playerId,
    clue: null,
    storytellerClip: null,
    table: [],
    reveal: null,
  }
  scheduleBots(room)
}

function finishGame(room) {
  room.status = 'finished'
  const max = Math.max(...room.players.map((p) => p.score))
  room.winnerIds = room.players.filter((p) => p.score === max && max > 0).map((p) => p.playerId)
  for (const p of room.players) p.hand = []
  room.round = null
}

function allSubmitted(room) {
  return room.players.every((p) => p.playerId === room.round.storytellerId || p.submission)
}
function allVoted(room) {
  return room.players.every((p) => p.playerId === room.round.storytellerId || p.vote)
}

function toVote(room) {
  const r = room.round
  r.phase = 'vote'
  r.table = shuffle(room.players.map((p) => p.submission).filter(Boolean))
  scheduleBots(room)
}

function toReveal(room) {
  const r = room.round
  const st = room.players.find((p) => p.playerId === r.storytellerId)
  const others = room.players.filter((p) => p !== st)
  const found = others.filter((p) => p.vote === st.submission.clipId)
  const points = Object.fromEntries(room.players.map((p) => [p.playerId, 0]))
  if (found.length === 0 || found.length === others.length) {
    for (const p of others) points[p.playerId] += 2
  } else {
    points[st.playerId] += 3
    for (const p of found) points[p.playerId] += 3
  }
  for (const voter of others) {
    const owner = others.find((p) => p.submission.clipId === voter.vote)
    if (owner) points[owner.playerId] += 1
  }
  for (const p of room.players) p.score += points[p.playerId]
  r.phase = 'reveal'
  r.reveal = {
    results: r.table.map((c) => {
      const owner = room.players.find((p) => p.submission?.clipId === c.clipId)
      return {
        clipId: c.clipId,
        ownerId: owner.playerId,
        isStoryteller: owner === st,
        voterIds: others.filter((p) => p.vote === c.clipId).map((p) => p.playerId),
      }
    }),
    points,
  }
}

function nextRound(room) {
  if (room.players.some((p) => p.score >= TARGET_SCORE)) finishGame(room)
  else startRound(room)
}

// ---- bots ----
function scheduleBots(room) {
  const r = room.round
  const roundNumber = r.number
  const phase = r.phase
  setTimeout(() => {
    if (rooms.get(room.code) !== room || room.round?.number !== roundNumber || room.round.phase !== phase) return
    for (const p of room.players.filter((p) => p.bot)) {
      const isSt = p.playerId === r.storytellerId
      if (phase === 'storyteller' && isSt) {
        handle(room, p, { type: 'submit_clue', clipId: pick(p.hand).clipId, clue: pick(BOT_CLUES) })
      } else if (phase === 'submit' && !isSt && !p.submission) {
        handle(room, p, { type: 'submit_clip', clipId: pick(p.hand).clipId })
      } else if (phase === 'vote' && !isSt && !p.vote) {
        const options = r.table.filter((c) => c.clipId !== p.submission.clipId)
        handle(room, p, { type: 'vote', clipId: pick(options).clipId })
      }
    }
    broadcast(room)
  }, BOT_DELAY_MS)
}

// ---- messages ----
function handle(room, player, msg) {
  const r = room.round
  const err = (code, message) => ({ type: 'error', code, message })
  const inHand = (id) => player.hand.find((c) => c.clipId === id)
  switch (msg.type) {
    case 'start_game':
      if (room.status === 'playing') return err('invalid_phase', 'Game already started')
      if (room.players.length < 4) return err('not_enough_players', 'At least 4 players are needed')
      startGame(room)
      return null
    case 'stop_game':
      deleteRoom(room, 'stopped')
      return null
    case 'leave_room': {
      if (room.status === 'playing') return err('invalid_phase', 'Cannot leave during a game')
      room.players = room.players.filter((p) => p !== player)
      for (const [t, v] of tokens) if (v.code === room.code && v.playerId === player.playerId) tokens.delete(t)
      if (player.socket) player.socket.close(1000, 'left')
      player.socket = null
      if (room.players.every((p) => p.bot)) deleteRoom(room, 'empty')
      return null
    }
    case 'submit_clue': {
      if (r?.phase !== 'storyteller') return err('invalid_phase', 'Not the storyteller phase')
      if (player.playerId !== r.storytellerId) return err('not_your_turn', 'You are not the storyteller')
      const clip = inHand(msg.clipId)
      if (!clip) return err('clip_not_in_hand', 'Clip not in hand')
      if (!msg.clue || typeof msg.clue !== 'string') return err('invalid_phase', 'Clue required')
      player.submission = clip
      r.clue = msg.clue.slice(0, 100)
      r.phase = 'submit'
      scheduleBots(room)
      return null
    }
    case 'submit_clip': {
      if (r?.phase !== 'submit') return err('invalid_phase', 'Not the submit phase')
      if (player.playerId === r.storytellerId) return err('not_your_turn', 'The storyteller does not submit')
      if (player.submission) return err('already_submitted', 'Already submitted')
      const clip = inHand(msg.clipId)
      if (!clip) return err('clip_not_in_hand', 'Clip not in hand')
      player.submission = clip
      if (allSubmitted(room)) toVote(room)
      return null
    }
    case 'vote': {
      if (r?.phase !== 'vote') return err('invalid_phase', 'Not the vote phase')
      if (player.playerId === r.storytellerId) return err('not_your_turn', 'The storyteller does not vote')
      if (player.vote) return err('already_submitted', 'Already voted')
      if (!r.table.some((c) => c.clipId === msg.clipId)) return err('clip_not_in_hand', 'Unknown clip')
      if (msg.clipId === player.submission?.clipId) return err('cannot_vote_own', 'Cannot vote for your own clip')
      player.vote = msg.clipId
      if (allVoted(room)) toReveal(room)
      return null
    }
    case 'next_round':
      if (r?.phase !== 'reveal') return err('invalid_phase', 'Not the reveal phase')
      nextRound(room)
      return null
    default:
      return err('invalid_phase', `Unknown message type ${msg.type}`)
  }
}

function snapshot(room, player) {
  const r = room.round
  return {
    type: 'state',
    room: { code: room.code, status: room.status, targetScore: TARGET_SCORE },
    you: { playerId: player.playerId, hand: player.hand },
    players: room.players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      connected: p.connected,
      score: p.score,
      isStoryteller: r ? p.playerId === r.storytellerId : false,
      hasSubmitted: !!p.submission,
      hasVoted: !!p.vote,
    })),
    round: r
      ? {
          number: r.number,
          phase: r.phase,
          storytellerId: r.storytellerId,
          clue: r.clue,
          yourSubmission: player.submission?.clipId ?? null,
          yourVote: player.vote,
          table: r.phase === 'vote' || r.phase === 'reveal' ? r.table : [],
          reveal: r.reveal,
        }
      : null,
    winnerIds: room.winnerIds,
  }
}

function sendTo(player, msg) {
  if (player.socket && player.socket.readyState === 1) player.socket.send(JSON.stringify(msg))
}

function broadcast(room) {
  if (!rooms.has(room.code)) return
  for (const p of room.players) if (!p.bot) sendTo(p, snapshot(room, p))
}

// ---- HTTP ----
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const fail = (res, status, code, message) => json(res, status, { code, message })

async function readBody(req) {
  let data = ''
  for await (const chunk of req) data += chunk
  try {
    return data ? JSON.parse(data) : {}
  } catch {
    return {}
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const url = new URL(req.url, baseUrl(req))
  const path = url.pathname
  console.log(req.method, path)

  if (path === '/healthz') return json(res, 200, { ok: true })

  if (path.startsWith('/clips/')) {
    const data = clipData.get(path.slice('/clips/'.length))
    if (!data) return fail(res, 404, 'not_found', 'Unknown clip')
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=3600' })
    return res.end(data)
  }

  if (req.method === 'GET' && path === '/audio/list') return json(res, 200, sounds(req))
  if (req.method === 'GET' && path.startsWith('/audio/')) {
    const s = sounds(req).find((s) => s.id === path.slice('/audio/'.length))
    return s ? json(res, 200, s) : fail(res, 404, 'not_found', 'Unknown sound')
  }

  if (req.method === 'POST' && path === '/rooms') {
    const { nickname } = await readBody(req)
    if (typeof nickname !== 'string' || !nickname.trim()) return fail(res, 400, 'invalid_nickname', 'Nickname required')
    const room = createRoom(req)
    const player = addPlayer(room, nickname.trim())
    const token = randomUUID()
    tokens.set(token, { code: room.code, playerId: player.playerId })
    console.log(`room ${room.code} created by ${player.nickname}`)
    return json(res, 201, { roomCode: room.code, playerId: player.playerId, token })
  }

  const join = path.match(/^\/rooms\/([^/]+)\/join$/)
  if (req.method === 'POST' && join) {
    const { nickname } = await readBody(req)
    if (typeof nickname !== 'string' || !nickname.trim()) return fail(res, 400, 'invalid_nickname', 'Nickname required')
    const room = rooms.get(join[1].toUpperCase())
    if (!room) return fail(res, 404, 'room_not_found', 'Unknown room code')
    if (room.status !== 'lobby') return fail(res, 409, 'game_started', 'Game already started')
    if (room.players.length >= 8) return fail(res, 409, 'room_full', 'No more room')
    const player = addPlayer(room, nickname.trim())
    const token = randomUUID()
    tokens.set(token, { code: room.code, playerId: player.playerId })
    broadcast(room)
    return json(res, 200, { roomCode: room.code, playerId: player.playerId, token })
  }

  fail(res, 404, 'not_found', 'Unknown endpoint')
})

// ---- WebSocket ----
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, baseUrl(req))
  if (url.pathname !== '/ws') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    const auth = tokens.get(url.searchParams.get('token') ?? '')
    const room = auth && rooms.get(auth.code)
    const player = room?.players.find((p) => p.playerId === auth.playerId)
    if (!player) return ws.close(4001, 'unknown token')
    if (player.socket && player.socket !== ws) player.socket.close(1000, 'replaced')
    player.socket = ws
    player.connected = true
    broadcast(room)
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      const error = handle(room, player, msg)
      if (error) sendTo(player, error)
      else broadcast(room)
    })
    ws.on('close', () => {
      if (player.socket !== ws) return
      player.socket = null
      player.connected = false
      broadcast(room)
    })
  })
})

server.listen(PORT, () => console.log(`Dixvoice mock backend on http://localhost:${PORT} (bots: ${BOTS})`))

# Structure of project

## Concept

The game will be released on http://itch.io/.

The idea of Dixvoice is a clever twist on the famous Dixit game, where players use and generate audio clips instead
of cards.

Each audio clip will be no more than 2 seconds long.

As with Dixit where players have 6 cards, players will have 5 sounds clips of up to 2 seconds. In addition, they have the ability to create an option to generate their own audio clip as well.

## Web App

We are going to be build a web app, with golang backend and vite.js react frontend.

### Front-End

Root dir: ./webapp/frontend

A player can start a game.

The frontend is a Vite + React single-page app, built as a static bundle so it can be uploaded to itch.io as an HTML5
game. It holds no game logic: it renders the state sent by the backend and sends player actions back.

Screens and features:

- **Lobby**: opening the game link joins the single room directly (no room code or room selection). The player enters
  a nickname, sees who is connected, and can start the game.
- **Hand**: show the player's 5 sound clips as cards that can be played back by tapping them.
- **Create a sound**: a form (text + tonality) to generate a new clip through the audio generator microservice and add
  it to the hand, with a loading state while it is generated.
- **Round flow**, mirroring Dixit:
  1. The storyteller picks a clip from their hand and gives a clue.
  2. The other players each pick the clip from their own hand that best matches the clue.
  3. All submitted clips are shuffled and played back anonymously; everyone except the storyteller votes for the one
     they think is the storyteller's.
  4. Reveal: who submitted which clip, who voted for what, and the updated scores.
- **Scoreboard** and end-of-game screen.

### Back-End

Root dir: ./webapp/backend

Manages basic multiplayer, there is a single room for the hackathon.

For now there is exactly one room: anyone who opens the game link joins it. There is no room creation, room code or
matchmaking.

The backend is a Go server and is the single source of truth for the game in progress.

Responsibilities:

- **Players**: track who is in the unique room, handle joins, leaves and reconnects, and pick the player who starts the game.
- **Real-time sync**: one WebSocket connection per player. The server pushes state updates (phase changes,
  submissions, votes, scores) and receives player actions. Each player only receives what they are allowed to see:
  their own hand, and who submitted which clip only at the reveal.
- **Game rules**: deal 5 clips per player from the audio generator's list, rotate the storyteller, enforce phase order,
  and score each round with the Dixit rules:
  - if every player or no player finds the storyteller's clip, the storyteller scores 0 and everyone else scores 2;
  - otherwise the storyteller and each player who found the clip score 3;
  - every other player also scores 1 point per vote their own clip received.
- **Audio**: call the audio generator microservice to list sounds, fetch them, and create new ones on a player's
  request. Game state stays in memory, which is enough for a single room.

## Audio Generator Microservice

The audio generator microservice has 3 endpoints:

- GET: /audio/list: list all possible sound objects in JSON
- GET: /audio/{id}: returns the mp3 file for a given audio sound
- POST: /audio: create a new sound from text and tonality

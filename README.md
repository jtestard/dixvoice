# DixVoice

DixVoice is a game that looks like the famous [Dixit](<https://en.wikipedia.org/wiki/Dixit_(board_game)>) but using short Voice cards instead of Images.

## How it works

One player creates a room and shares its code, or taps Quick start to play right away against three AI companions.

Each round, every player is dealt six voice clips of up to two seconds, short spoken lines played with a given emotion. One player, the storyteller, picks a clip from their hand and writes a text clue for it without giving it away.

Every other player then picks the clip from their own hand that best fits the clue. All the chosen clips are shuffled and played back anonymously, and everyone but the storyteller votes for the one they think is the
storyteller's.

The storyteller scores only if some players find their clip, but not all of them: a clue that is too obvious or too obscure earns nothing. The other players score when they find it, and for every vote their own clip
draws. Clips are never reused within a room, and the first player to reach 10 points wins.

## Multiplayer and AI support

Dixit is by nature a multiplayer social game. DixVoice allows for up to 8 real or AI players to player together. It has support for AI agents which behave like real players, allowing one to play alone if you wish.

## Ambiguity

AI players are interesting because they have to deal with the inherent ambiguity of the game, having to pick a card for others to vote on which is not obvious enough for everybody to get right, but not too difficult so that no one gets it right either. Results have been surpisingly good! How the companion storyteller searches for such a clue is described in [webapp/companions/README.md](webapp/companions/README.md).

## Qualifying criteria

- Gradium: We are using Gradium extensively, to generate all the audio clips.
- Gemini: We are using Gemini models for the AI companions.
- Cognition: Devin sessions have been used extensively for development, our account displays the workflows! We have our local claude model use the devin MCP, while devin wrote most of the code. The proof can be seen in all the PRs made in the repo.

## Future Work

- Mobile responsiveness
- Prompt your own card. Since these are short audio clips, it would be easy to add this to the game with very low latency.

package companion

import (
	"math/rand/v2"
	"time"
)

var nicknames = []string{
	"Robo Ada", "Bot Turing", "Chip Lovelace", "Tin Hopper", "Byte Babbage",
	"Sir Circuit", "Miss Modem", "Dr. Diode", "Captain Cache", "Lady Latency",
	"Pixel Pete", "Echo Eve", "Volt Vera", "Gizmo Gus", "Sparky Sue",
	"Binary Bea", "Static Stan", "Reverb Rex", "Fuzz Fiona", "Tempo Tom",
}

// RandomNickname picks a companion nickname.
func RandomNickname() string {
	return nicknames[rand.IntN(len(nicknames))]
}

var fallbackClues = []string{
	"a door in the rain", "something left unsaid", "the last train home", "a secret in the attic",
	"morning after the storm", "a promise, half kept", "footsteps behind you", "sunlight on cold water",
	"the end of the party", "a letter never sent", "lost in the crowd", "before the curtain rises",
}

func randomClue() string {
	return fallbackClues[rand.IntN(len(fallbackClues))]
}

// RandomDelay returns the natural-feeling pause before a move: 2 to 6 seconds.
func RandomDelay() time.Duration {
	return 2*time.Second + time.Duration(rand.Int64N(int64(4*time.Second)))
}

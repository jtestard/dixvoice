package game

import (
	mrand "math/rand/v2"
	"sync"
)

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ" // no I or O: easy to read aloud
const codeLen = 4

// Manager owns every room and maps session tokens to seats.
type Manager struct {
	mu     sync.Mutex
	rooms  map[string]*Room
	tokens map[string]Seat
}

// Seat is a player's place in a room, identified by their token.
type Seat struct {
	Room     *Room
	PlayerID string
}

func NewManager() *Manager {
	return &Manager{rooms: map[string]*Room{}, tokens: map[string]Seat{}}
}

func (m *Manager) newCode() string {
	for {
		b := make([]byte, codeLen)
		for i := range b {
			b[i] = codeAlphabet[mrand.IntN(len(codeAlphabet))]
		}
		code := string(b)
		if _, taken := m.rooms[code]; !taken {
			return code
		}
	}
}

// CreateRoom creates a room and seats its first player.
func (m *Manager) CreateRoom(nickname string) (*Room, *Player, error) {
	if _, err := ValidateNickname(nickname); err != nil {
		return nil, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	room := NewRoom(m.newCode())
	p, err := room.Join(nickname)
	if err != nil {
		return nil, nil, err
	}
	m.rooms[room.Code] = room
	m.tokens[p.Token] = Seat{Room: room, PlayerID: p.ID}
	return room, p, nil
}

// JoinRoom seats a new player in an existing room.
func (m *Manager) JoinRoom(code, nickname string) (*Room, *Player, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.rooms[code]
	if !ok {
		return nil, nil, newError(CodeRoomNotFound, "unknown room code")
	}
	p, err := room.Join(nickname)
	if err != nil {
		return nil, nil, err
	}
	m.tokens[p.Token] = Seat{Room: room, PlayerID: p.ID}
	return room, p, nil
}

// Room returns the room with the given code, or nil.
func (m *Manager) Room(code string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[code]
}

// Lookup resolves a session token.
func (m *Manager) Lookup(token string) (Seat, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.tokens[token]
	return s, ok
}

// Delete removes a room and every token pointing at it. It reports whether
// the room existed.
func (m *Manager) Delete(code string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.rooms[code]
	if !ok {
		return false
	}
	delete(m.rooms, code)
	for t, s := range m.tokens {
		if s.Room == room {
			delete(m.tokens, t)
		}
	}
	return true
}

// Leave removes a player from their room and deletes the room if it is now
// empty. It reports whether the room was deleted.
func (m *Manager) Leave(seat Seat) (deleted bool, err error) {
	empty, err := seat.Room.Leave(seat.PlayerID)
	if err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for t, s := range m.tokens {
		if s.Room == seat.Room && s.PlayerID == seat.PlayerID {
			delete(m.tokens, t)
		}
	}
	if empty {
		delete(m.rooms, seat.Room.Code)
	}
	return empty, nil
}

// Count returns the number of live rooms.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

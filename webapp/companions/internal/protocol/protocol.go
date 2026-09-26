// Package protocol holds the JSON messages of the backend protocol (root
// README > Web App > Back-End > Protocol) as seen by a client.
package protocol

const (
	PhaseStoryteller = "storyteller"
	PhaseSubmit      = "submit"
	PhaseVote        = "vote"
	PhaseReveal      = "reveal"
)

// Clip is a full AudioResponse with `id` renamed `clipId`.
type Clip struct {
	ClipID  string `json:"clipId"`
	ClipURL string `json:"clipUrl"`
	Text    string `json:"text"`
	Emotion string `json:"emotion"`
	VoiceID string `json:"voiceId"`
}

// JoinRequest is the body of POST /rooms/{code}/join.
type JoinRequest struct {
	Nickname  string `json:"nickname"`
	Companion bool   `json:"companion"`
}

// JoinResponse is the body returned by POST /rooms/{code}/join.
type JoinResponse struct {
	RoomCode string `json:"roomCode"`
	PlayerID string `json:"playerId"`
	Token    string `json:"token"`
}

// ErrorBody is the JSON error returned by HTTP endpoints.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Envelope is the common part of every server-to-client message.
type Envelope struct {
	Type    string `json:"type"`
	Reason  string `json:"reason,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// State is the per-player snapshot sent after every change.
type State struct {
	Type      string   `json:"type"`
	Room      Room     `json:"room"`
	You       You      `json:"you"`
	Players   []Player `json:"players"`
	Round     *Round   `json:"round"`
	WinnerIDs []string `json:"winnerIds"`
}

type Room struct {
	Code        string `json:"code"`
	Status      string `json:"status"`
	TargetScore int    `json:"targetScore"`
}

type You struct {
	PlayerID string `json:"playerId"`
	Hand     []Clip `json:"hand"`
}

type Player struct {
	PlayerID      string `json:"playerId"`
	Nickname      string `json:"nickname"`
	Connected     bool   `json:"connected"`
	Score         int    `json:"score"`
	IsStoryteller bool   `json:"isStoryteller"`
	HasSubmitted  bool   `json:"hasSubmitted"`
	HasVoted      bool   `json:"hasVoted"`
	IsCompanion   bool   `json:"isCompanion"`
}

type Round struct {
	Number         int     `json:"number"`
	Phase          string  `json:"phase"`
	StorytellerID  string  `json:"storytellerId"`
	Clue           *string `json:"clue"`
	YourSubmission *string `json:"yourSubmission"`
	YourVote       *string `json:"yourVote"`
	Table          []Clip  `json:"table"`
}

// Action is a client-to-server message.
type Action struct {
	Type   string `json:"type"`
	ClipID string `json:"clipId,omitempty"`
	Clue   string `json:"clue,omitempty"`
}

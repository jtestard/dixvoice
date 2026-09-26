package game

// Error is a protocol error: Code is one of the error codes listed in the
// README Protocol section, Message is a human readable explanation.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, msg string) *Error { return &Error{Code: code, Message: msg} }

const (
	CodeInvalidPhase     = "invalid_phase"
	CodeNotYourTurn      = "not_your_turn"
	CodeClipNotInHand    = "clip_not_in_hand"
	CodeAlreadySubmitted = "already_submitted"
	CodeCannotVoteOwn    = "cannot_vote_own"
	CodeNotEnoughPlayers = "not_enough_players"
	CodeNotEnoughSounds  = "not_enough_sounds"
	CodeRoomNotFound     = "room_not_found"
	CodeRoomFull         = "room_full"
	CodeGameStarted      = "game_started"
	CodeInvalidNickname  = "invalid_nickname"
	CodeInvalidClue      = "invalid_clue"
	CodeClipNotOnTable   = "clip_not_on_table"
	CodePlayerNotFound   = "player_not_found"
)

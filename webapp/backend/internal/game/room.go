package game

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	mrand "math/rand/v2"
	"strings"
	"sync"
	"unicode/utf8"
)

const (
	MinPlayers   = 4
	MaxPlayers   = 8
	HandSize     = 6
	TargetScore  = 10
	MaxClueLen   = 200
	MaxNicknames = 24
)

type Status string

const (
	StatusLobby    Status = "lobby"
	StatusPlaying  Status = "playing"
	StatusFinished Status = "finished"
)

type Phase string

const (
	PhaseStoryteller Phase = "storyteller"
	PhaseSubmit      Phase = "submit"
	PhaseVote        Phase = "vote"
	PhaseReveal      Phase = "reveal"
)

// Clip is a sound as players see it: the audio service's AudioResponse with
// id renamed clipId.
type Clip struct {
	ID      string `json:"clipId"`
	URL     string `json:"clipUrl"`
	Text    string `json:"text"`
	Emotion string `json:"emotion"`
	VoiceID string `json:"voiceId"`
}

type Player struct {
	ID          string
	Nickname    string
	Token       string
	Connected   bool
	IsCompanion bool
	Score       int
	Hand        []Clip
	// Submission is the clip the player put on the table this round ("" if none).
	Submission string
	// Vote is the clip the player voted for this round ("" if none).
	Vote string
}

type RevealResult struct {
	ClipID        string   `json:"clipId"`
	OwnerID       string   `json:"ownerId"`
	IsStoryteller bool     `json:"isStoryteller"`
	VoterIDs      []string `json:"voterIds"`
}

type Reveal struct {
	Results []RevealResult `json:"results"`
	Points  map[string]int `json:"points"`
}

type Round struct {
	Number        int
	Phase         Phase
	StorytellerID string
	Clue          string
	Table         []Clip
	Reveal        *Reveal
}

// Room holds one session: its players, the current game and the set of sounds
// already used. All exported methods lock the room and are safe for
// concurrent use.
type Room struct {
	mu sync.Mutex

	Code    string
	Status  Status
	Players []*Player // in join order
	Round   *Round
	Winners []string
	Used    map[string]bool

	nextPlayerID   int
	storytellerIdx int
	roundsInGame   int
	rng            *mrand.Rand
}

func NewRoom(code string) *Room {
	return &Room{
		Code:   code,
		Status: StatusLobby,
		Used:   map[string]bool{},
		rng:    mrand.New(mrand.NewPCG(mrand.Uint64(), mrand.Uint64())),
	}
}

// SeedRNG makes shuffles deterministic (tests only).
func (r *Room) SeedRNG(seed uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rng = mrand.New(mrand.NewPCG(seed, seed))
}

func newToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func ValidateNickname(n string) (string, error) {
	n = strings.TrimSpace(n)
	if n == "" || utf8.RuneCountInString(n) > MaxNicknames {
		return "", newError(CodeInvalidNickname, "nickname must be 1 to 24 characters")
	}
	return n, nil
}

// Join adds a player to the room. It fails once the game has started or the
// room is full. companion marks an AI companion.
func (r *Room) Join(nickname string, companion bool) (*Player, error) {
	nickname, err := ValidateNickname(nickname)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Status != StatusLobby {
		return nil, newError(CodeGameStarted, "the game has already started")
	}
	if len(r.Players) >= MaxPlayers {
		return nil, newError(CodeRoomFull, "no more room")
	}
	r.nextPlayerID++
	p := &Player{
		ID:          fmt.Sprintf("p%d", r.nextPlayerID),
		Nickname:    nickname,
		Token:       newToken(),
		IsCompanion: companion,
	}
	r.Players = append(r.Players, p)
	return p, nil
}

func (r *Room) player(id string) *Player {
	for _, p := range r.Players {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// Player returns a copy of the player with the given id, or nil.
func (r *Room) Player(id string) *Player {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.player(id)
	if p == nil {
		return nil
	}
	c := *p
	return &c
}

func (r *Room) SetConnected(id string, connected bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p := r.player(id); p != nil {
		p.Connected = connected
	}
}

// Leave removes a player (lobby or finished only). It reports whether the
// room is now empty.
func (r *Room) Leave(id string) (empty bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Status == StatusPlaying {
		return false, newError(CodeInvalidPhase, "cannot leave during a game")
	}
	for i, p := range r.Players {
		if p.ID == id {
			r.Players = append(r.Players[:i], r.Players[i+1:]...)
			return len(r.Players) == 0, nil
		}
	}
	return len(r.Players) == 0, newError(CodePlayerNotFound, "unknown player")
}

// CanAddCompanion checks that a companion may be added now: lobby only (the
// companion joins like any player, and Join is lobby only) with a free seat.
func (r *Room) CanAddCompanion() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Status != StatusLobby {
		return newError(CodeInvalidPhase, "companions can only be added in the lobby")
	}
	if len(r.Players) >= MaxPlayers {
		return newError(CodeRoomFull, "no more room")
	}
	return nil
}

// RemoveCompanion removes a companion player (lobby or finished only).
func (r *Room) RemoveCompanion(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Status == StatusPlaying {
		return newError(CodeInvalidPhase, "companions can only be removed between games")
	}
	for i, p := range r.Players {
		if p.ID != id {
			continue
		}
		if !p.IsCompanion {
			return newError(CodeNotACompanion, "that player is not an AI companion")
		}
		r.Players = append(r.Players[:i], r.Players[i+1:]...)
		return nil
	}
	return newError(CodePlayerNotFound, "unknown player")
}

// Start begins a game from the lobby. pool is the audio service's full list;
// the room deals from it minus its used sounds.
func (r *Room) Start(pool []Clip) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Status != StatusLobby {
		return newError(CodeInvalidPhase, "a game can only start in the lobby")
	}
	if len(r.Players) < MinPlayers {
		return newError(CodeNotEnoughPlayers, fmt.Sprintf("at least %d players are needed", MinPlayers))
	}
	if !r.canDeal(pool) {
		return newError(CodeNotEnoughSounds, "not enough unused sounds to deal a round")
	}
	for _, p := range r.Players {
		p.Score = 0
	}
	r.Winners = nil
	r.roundsInGame = 0
	r.storytellerIdx = r.rng.IntN(len(r.Players))
	r.Status = StatusPlaying
	r.deal(pool)
	return nil
}

func (r *Room) fresh(pool []Clip) []Clip {
	var out []Clip
	for _, c := range pool {
		if !r.Used[c.ID] {
			out = append(out, c)
		}
	}
	return out
}

func (r *Room) canDeal(pool []Clip) bool {
	return len(r.fresh(pool)) >= HandSize*len(r.Players)
}

// deal starts a new round: fresh hands for everyone, next storyteller.
func (r *Room) deal(pool []Clip) {
	fresh := r.fresh(pool)
	r.rng.Shuffle(len(fresh), func(i, j int) { fresh[i], fresh[j] = fresh[j], fresh[i] })
	for _, p := range r.Players {
		p.Hand = make([]Clip, HandSize)
		copy(p.Hand, fresh[:HandSize])
		fresh = fresh[HandSize:]
		for _, c := range p.Hand {
			r.Used[c.ID] = true
		}
		p.Submission = ""
		p.Vote = ""
	}
	r.roundsInGame++
	r.storytellerIdx %= len(r.Players)
	r.Round = &Round{
		Number:        r.roundsInGame,
		Phase:         PhaseStoryteller,
		StorytellerID: r.Players[r.storytellerIdx].ID,
		Table:         []Clip{},
	}
	r.storytellerIdx++
}

func (r *Room) requirePhase(ph Phase) error {
	if r.Status != StatusPlaying || r.Round == nil || r.Round.Phase != ph {
		return newError(CodeInvalidPhase, fmt.Sprintf("this action is only allowed in the %s phase", ph))
	}
	return nil
}

func inHand(p *Player, clipID string) bool {
	for _, c := range p.Hand {
		if c.ID == clipID {
			return true
		}
	}
	return false
}

// SubmitClue: the storyteller picks a clip and writes the clue.
func (r *Room) SubmitClue(playerID, clipID, clue string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requirePhase(PhaseStoryteller); err != nil {
		return err
	}
	if playerID != r.Round.StorytellerID {
		return newError(CodeNotYourTurn, "only the storyteller can give the clue")
	}
	clue = strings.TrimSpace(clue)
	if clue == "" || utf8.RuneCountInString(clue) > MaxClueLen {
		return newError(CodeInvalidClue, fmt.Sprintf("the clue must be 1 to %d characters", MaxClueLen))
	}
	p := r.player(playerID)
	if !inHand(p, clipID) {
		return newError(CodeClipNotInHand, "that clip is not in your hand")
	}
	p.Submission = clipID
	r.Round.Clue = clue
	r.Round.Phase = PhaseSubmit
	return nil
}

// SubmitClip: a non-storyteller puts a clip on the table. When everyone has,
// the table is shuffled and the vote starts.
func (r *Room) SubmitClip(playerID, clipID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requirePhase(PhaseSubmit); err != nil {
		return err
	}
	if playerID == r.Round.StorytellerID {
		return newError(CodeNotYourTurn, "the storyteller does not submit a clip")
	}
	p := r.player(playerID)
	if p == nil {
		return newError(CodePlayerNotFound, "unknown player")
	}
	if p.Submission != "" {
		return newError(CodeAlreadySubmitted, "you already submitted a clip")
	}
	if !inHand(p, clipID) {
		return newError(CodeClipNotInHand, "that clip is not in your hand")
	}
	p.Submission = clipID
	for _, q := range r.Players {
		if q.Submission == "" {
			return nil
		}
	}
	table := make([]Clip, 0, len(r.Players))
	for _, q := range r.Players {
		for _, c := range q.Hand {
			if c.ID == q.Submission {
				table = append(table, c)
			}
		}
	}
	r.rng.Shuffle(len(table), func(i, j int) { table[i], table[j] = table[j], table[i] })
	r.Round.Table = table
	r.Round.Phase = PhaseVote
	return nil
}

// Vote: a non-storyteller votes for a clip on the table that is not theirs.
// When everyone has voted the round is revealed and scored.
func (r *Room) Vote(playerID, clipID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requirePhase(PhaseVote); err != nil {
		return err
	}
	if playerID == r.Round.StorytellerID {
		return newError(CodeNotYourTurn, "the storyteller does not vote")
	}
	p := r.player(playerID)
	if p == nil {
		return newError(CodePlayerNotFound, "unknown player")
	}
	if p.Vote != "" {
		return newError(CodeAlreadySubmitted, "you already voted")
	}
	if clipID == p.Submission {
		return newError(CodeCannotVoteOwn, "you cannot vote for your own clip")
	}
	onTable := false
	for _, c := range r.Round.Table {
		if c.ID == clipID {
			onTable = true
		}
	}
	if !onTable {
		return newError(CodeClipNotOnTable, "that clip is not on the table")
	}
	p.Vote = clipID
	for _, q := range r.Players {
		if q.ID != r.Round.StorytellerID && q.Vote == "" {
			return nil
		}
	}
	r.reveal()
	return nil
}

// Score applies the Dixit scoring rules. storyteller is the storyteller's id,
// submissions maps player -> clip, votes maps player -> clip (non-storytellers
// only). It returns the points won by each player this round.
func Score(storyteller string, submissions map[string]string, votes map[string]string) map[string]int {
	points := map[string]int{}
	for id := range submissions {
		points[id] = 0
	}
	owner := map[string]string{}
	for id, clip := range submissions {
		owner[clip] = id
	}
	storyClip := submissions[storyteller]
	found := 0
	for _, clip := range votes {
		if clip == storyClip {
			found++
		}
	}
	if found == 0 || found == len(votes) {
		for id := range submissions {
			if id != storyteller {
				points[id] += 2
			}
		}
	} else {
		points[storyteller] += 3
		for id, clip := range votes {
			if clip == storyClip {
				points[id] += 3
			}
		}
	}
	for _, clip := range votes {
		if id := owner[clip]; id != storyteller {
			points[id]++
		}
	}
	return points
}

func (r *Room) reveal() {
	subs := map[string]string{}
	votes := map[string]string{}
	for _, p := range r.Players {
		subs[p.ID] = p.Submission
		if p.ID != r.Round.StorytellerID {
			votes[p.ID] = p.Vote
		}
	}
	points := Score(r.Round.StorytellerID, subs, votes)
	results := make([]RevealResult, 0, len(r.Round.Table))
	for _, c := range r.Round.Table {
		res := RevealResult{ClipID: c.ID, VoterIDs: []string{}}
		for _, p := range r.Players {
			if p.Submission == c.ID {
				res.OwnerID = p.ID
				res.IsStoryteller = p.ID == r.Round.StorytellerID
			}
		}
		for _, p := range r.Players {
			if p.Vote == c.ID {
				res.VoterIDs = append(res.VoterIDs, p.ID)
			}
		}
		results = append(results, res)
	}
	r.Round.Reveal = &Reveal{Results: results, Points: points}
	r.Round.Phase = PhaseReveal
	for _, p := range r.Players {
		p.Score += points[p.ID]
	}
}

func (r *Room) reachedTarget() bool {
	for _, p := range r.Players {
		if p.Score >= TargetScore {
			return true
		}
	}
	return false
}

func (r *Room) NeedsNextRoundPool() (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requirePhase(PhaseReveal); err != nil {
		return false, err
	}
	return !r.reachedTarget(), nil
}

func (r *Room) finish() {
	best := -1
	for _, p := range r.Players {
		if p.Score > best {
			best = p.Score
		}
	}
	r.Winners = []string{}
	for _, p := range r.Players {
		if p.Score == best {
			r.Winners = append(r.Winners, p.ID)
		}
		p.Hand = nil
	}
	r.Status = StatusFinished
}

// NextRound deals the next round after a reveal. If the pool cannot deal a
// full round the game ends instead.
func (r *Room) NextRound(pool []Clip) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requirePhase(PhaseReveal); err != nil {
		return err
	}
	if r.reachedTarget() {
		r.finish()
		return nil
	}
	if !r.canDeal(pool) {
		r.finish()
		return nil
	}
	r.deal(pool)
	return nil
}

// Playing reports whether a game is in progress.
func (r *Room) Playing() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.Status == StatusPlaying
}

// PlayerIDs returns the ids of every player in join order.
func (r *Room) PlayerIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, len(r.Players))
	for i, p := range r.Players {
		ids[i] = p.ID
	}
	return ids
}

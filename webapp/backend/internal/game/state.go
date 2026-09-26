package game

// State is the snapshot sent to one player (README > Protocol).
type State struct {
	Type      string        `json:"type"`
	Room      RoomState     `json:"room"`
	You       YouState      `json:"you"`
	Players   []PlayerState `json:"players"`
	Round     *RoundState   `json:"round"`
	WinnerIDs []string      `json:"winnerIds"`
}

type RoomState struct {
	Code        string `json:"code"`
	Status      Status `json:"status"`
	TargetScore int    `json:"targetScore"`
}

type YouState struct {
	PlayerID string `json:"playerId"`
	Hand     []Clip `json:"hand"`
	// CustomSlot is the state of your custom slot (only you see it).
	CustomSlot CustomState `json:"customSlot"`
}

type PlayerState struct {
	PlayerID      string `json:"playerId"`
	Nickname      string `json:"nickname"`
	Connected     bool   `json:"connected"`
	Score         int    `json:"score"`
	IsStoryteller bool   `json:"isStoryteller"`
	HasSubmitted  bool   `json:"hasSubmitted"`
	HasVoted      bool   `json:"hasVoted"`
	IsCompanion   bool   `json:"isCompanion"`
}

type RoundState struct {
	Number         int     `json:"number"`
	Phase          Phase   `json:"phase"`
	StorytellerID  string  `json:"storytellerId"`
	Clue           *string `json:"clue"`
	YourSubmission *string `json:"yourSubmission"`
	YourVote       *string `json:"yourVote"`
	Table          []Clip  `json:"table"`
	Reveal         *Reveal `json:"reveal"`
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Snapshot builds the state for playerID, containing only what that player
// is allowed to see.
func (r *Room) Snapshot(playerID string) State {
	r.mu.Lock()
	defer r.mu.Unlock()

	st := State{
		Type:      "state",
		Room:      RoomState{Code: r.Code, Status: r.Status, TargetScore: TargetScore},
		You:       YouState{PlayerID: playerID, Hand: []Clip{}, CustomSlot: CustomEmpty},
		Players:   make([]PlayerState, 0, len(r.Players)),
		WinnerIDs: []string{},
	}
	if r.Winners != nil {
		st.WinnerIDs = append(st.WinnerIDs, r.Winners...)
	}
	me := r.player(playerID)
	if me != nil && r.Status == StatusPlaying {
		st.You.Hand = append(st.You.Hand, me.Hand...)
		if me.Custom != "" {
			st.You.CustomSlot = me.Custom
		}
	}
	storyteller := ""
	if r.Round != nil {
		storyteller = r.Round.StorytellerID
	}
	for _, p := range r.Players {
		st.Players = append(st.Players, PlayerState{
			PlayerID:      p.ID,
			Nickname:      p.Nickname,
			Connected:     p.Connected,
			Score:         p.Score,
			IsStoryteller: r.Round != nil && p.ID == storyteller,
			HasSubmitted:  r.Round != nil && p.Submission != "",
			HasVoted:      r.Round != nil && p.Vote != "",
			IsCompanion:   p.IsCompanion,
		})
	}
	if r.Round != nil {
		rs := &RoundState{
			Number:        r.Round.Number,
			Phase:         r.Round.Phase,
			StorytellerID: r.Round.StorytellerID,
			Clue:          optional(r.Round.Clue),
			Table:         []Clip{},
		}
		if me != nil {
			rs.YourSubmission = optional(me.Submission)
			rs.YourVote = optional(me.Vote)
		}
		if r.Round.Phase == PhaseVote || r.Round.Phase == PhaseReveal {
			rs.Table = append(rs.Table, r.Round.Table...)
		}
		if r.Round.Phase == PhaseReveal && r.Round.Reveal != nil {
			rv := &Reveal{Results: make([]RevealResult, 0, len(r.Round.Reveal.Results)), Points: map[string]int{}}
			for _, res := range r.Round.Reveal.Results {
				c := res
				c.VoterIDs = append([]string{}, res.VoterIDs...)
				rv.Results = append(rv.Results, c)
			}
			for k, v := range r.Round.Reveal.Points {
				rv.Points[k] = v
			}
			rs.Reveal = rv
		}
		st.Round = rs
	}
	return st
}

package game

import (
	"errors"
	"fmt"
	"testing"
)

func pool(n int) []Clip {
	out := make([]Clip, n)
	for i := range out {
		out[i] = Clip{ID: fmt.Sprintf("c%d", i), URL: fmt.Sprintf("http://cdn/c%d.mp3", i)}
	}
	return out
}

func mustJoin(t *testing.T, r *Room, n int) []*Player {
	t.Helper()
	ps := make([]*Player, n)
	for i := range ps {
		p, err := r.Join(fmt.Sprintf("player%d", i))
		if err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
		ps[i] = p
	}
	return ps
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ge *Error
	if !errors.As(err, &ge) {
		t.Fatalf("expected error %s, got %v", code, err)
	}
	if ge.Code != code {
		t.Fatalf("expected error %s, got %s (%s)", code, ge.Code, ge.Message)
	}
}

func startedRoom(t *testing.T, n int) (*Room, []*Player) {
	t.Helper()
	r := NewRoom("TEST")
	r.SeedRNG(1)
	ps := mustJoin(t, r, n)
	if err := r.Start(pool(300)); err != nil {
		t.Fatal(err)
	}
	return r, ps
}

func storyteller(r *Room) *Player { return r.player(r.Round.StorytellerID) }

func others(r *Room) []*Player {
	var out []*Player
	for _, p := range r.Players {
		if p.ID != r.Round.StorytellerID {
			out = append(out, p)
		}
	}
	return out
}

func TestRoomLimits(t *testing.T) {
	r := NewRoom("TEST")
	mustJoin(t, r, 3)
	wantCode(t, r.Start(pool(300)), CodeNotEnoughPlayers)
	if r.Status != StatusLobby {
		t.Fatal("room should still be in the lobby")
	}
	mustJoin(t, r, 5) // 8 total
	_, err := r.Join("ninth")
	wantCode(t, err, CodeRoomFull)
	_, err = r.Join("   ")
	wantCode(t, err, CodeInvalidNickname)

	if err := r.Start(pool(300)); err != nil {
		t.Fatal(err)
	}
	wantCode(t, r.Start(pool(300)), CodeInvalidPhase)
}

func TestRoomLockedAfterStart(t *testing.T) {
	r, ps := startedRoom(t, 4)
	_, err := r.Join("late")
	wantCode(t, err, CodeGameStarted)
	_, err = r.Leave(ps[0].ID)
	wantCode(t, err, CodeInvalidPhase)
}

func TestStartNeedsEnoughSounds(t *testing.T) {
	r := NewRoom("TEST")
	mustJoin(t, r, 4)
	wantCode(t, r.Start(pool(23)), CodeNotEnoughSounds)
	if err := r.Start(pool(24)); err != nil {
		t.Fatal(err)
	}
}

func TestManager(t *testing.T) {
	m := NewManager()
	_, _, err := m.JoinRoom("NOPE", "x")
	wantCode(t, err, CodeRoomNotFound)

	room, p1, err := m.CreateRoom("Ana")
	if err != nil {
		t.Fatal(err)
	}
	if len(room.Code) != codeLen {
		t.Fatalf("bad code %q", room.Code)
	}
	_, p2, err := m.JoinRoom(room.Code, "Ben")
	if err != nil {
		t.Fatal(err)
	}
	seat, ok := m.Lookup(p2.Token)
	if !ok || seat.Room != room || seat.PlayerID != p2.ID {
		t.Fatal("token lookup failed")
	}
	if _, ok := m.Lookup("bogus"); ok {
		t.Fatal("bogus token resolved")
	}

	// Several rooms at once.
	room2, _, _ := m.CreateRoom("Cid")
	if room2.Code == room.Code || m.Count() != 2 {
		t.Fatal("expected two distinct rooms")
	}

	// Leaving until empty deletes the room and its tokens.
	if deleted, _ := m.Leave(game(m, p1.Token)); deleted {
		t.Fatal("room should not be deleted while a player remains")
	}
	if _, ok := m.Lookup(p1.Token); ok {
		t.Fatal("token of left player still valid")
	}
	if deleted, _ := m.Leave(game(m, p2.Token)); !deleted {
		t.Fatal("room should be deleted when empty")
	}
	if m.Room(room.Code) != nil || m.Count() != 1 {
		t.Fatal("empty room not removed")
	}

	// Stop deletes the room and invalidates every token.
	_, p3, _ := m.JoinRoom(room2.Code, "Dee")
	if !m.Delete(room2.Code) {
		t.Fatal("delete failed")
	}
	if m.Room(room2.Code) != nil || m.Count() != 0 {
		t.Fatal("room not deleted")
	}
	if _, ok := m.Lookup(p3.Token); ok {
		t.Fatal("token still valid after stop")
	}
	if m.Delete(room2.Code) {
		t.Fatal("deleting twice should report false")
	}
}

func game(m *Manager, token string) Seat {
	s, _ := m.Lookup(token)
	return s
}

func TestPhaseOrderAndValidation(t *testing.T) {
	r, _ := startedRoom(t, 4)
	if r.Status != StatusPlaying || r.Round == nil || r.Round.Phase != PhaseStoryteller || r.Round.Number != 1 {
		t.Fatalf("unexpected state after start: %+v", r.Round)
	}
	st := storyteller(r)
	oth := others(r)

	// Wrong phase.
	wantCode(t, r.SubmitClip(oth[0].ID, oth[0].Hand[0].ID), CodeInvalidPhase)
	wantCode(t, r.Vote(oth[0].ID, "x"), CodeInvalidPhase)
	wantCode(t, r.NextRound(pool(300)), CodeInvalidPhase)
	// Wrong player.
	wantCode(t, r.SubmitClue(oth[0].ID, oth[0].Hand[0].ID, "clue"), CodeNotYourTurn)
	// Clip not in hand / empty clue.
	wantCode(t, r.SubmitClue(st.ID, oth[0].Hand[0].ID, "clue"), CodeClipNotInHand)
	wantCode(t, r.SubmitClue(st.ID, st.Hand[0].ID, "  "), CodeInvalidClue)
	if err := r.SubmitClue(st.ID, st.Hand[0].ID, "a door in the rain"); err != nil {
		t.Fatal(err)
	}
	if r.Round.Phase != PhaseSubmit || r.Round.Clue != "a door in the rain" {
		t.Fatal("expected submit phase with clue")
	}

	// Submit phase.
	wantCode(t, r.SubmitClue(st.ID, st.Hand[1].ID, "again"), CodeInvalidPhase)
	wantCode(t, r.SubmitClip(st.ID, st.Hand[1].ID), CodeNotYourTurn)
	wantCode(t, r.SubmitClip(oth[0].ID, st.Hand[1].ID), CodeClipNotInHand)
	if err := r.SubmitClip(oth[0].ID, oth[0].Hand[0].ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, r.SubmitClip(oth[0].ID, oth[0].Hand[1].ID), CodeAlreadySubmitted)
	if len(r.Snapshot(oth[0].ID).Round.Table) != 0 {
		t.Fatal("table must be empty before the vote")
	}
	for _, p := range oth[1:] {
		if err := r.SubmitClip(p.ID, p.Hand[0].ID); err != nil {
			t.Fatal(err)
		}
	}
	if r.Round.Phase != PhaseVote || len(r.Round.Table) != 4 {
		t.Fatalf("expected vote phase with 4 clips, got %s / %d", r.Round.Phase, len(r.Round.Table))
	}

	// Vote phase.
	wantCode(t, r.Vote(st.ID, oth[0].Submission), CodeNotYourTurn)
	wantCode(t, r.Vote(oth[0].ID, oth[0].Submission), CodeCannotVoteOwn)
	wantCode(t, r.Vote(oth[0].ID, oth[0].Hand[1].ID), CodeClipNotOnTable)
	if err := r.Vote(oth[0].ID, st.Submission); err != nil {
		t.Fatal(err)
	}
	wantCode(t, r.Vote(oth[0].ID, oth[1].Submission), CodeAlreadySubmitted)
	if err := r.Vote(oth[1].ID, st.Submission); err != nil {
		t.Fatal(err)
	}
	if err := r.Vote(oth[2].ID, oth[0].Submission); err != nil {
		t.Fatal(err)
	}

	// Reveal: two found (3 each + storyteller 3), oth[0] got one vote (+1).
	if r.Round.Phase != PhaseReveal || r.Round.Reveal == nil {
		t.Fatal("expected reveal")
	}
	want := map[string]int{st.ID: 3, oth[0].ID: 4, oth[1].ID: 3, oth[2].ID: 0}
	for id, pts := range want {
		if r.Round.Reveal.Points[id] != pts || r.player(id).Score != pts {
			t.Fatalf("player %s: points %d score %d want %d", id, r.Round.Reveal.Points[id], r.player(id).Score, pts)
		}
	}
	for _, res := range r.Round.Reveal.Results {
		if res.ClipID == st.Submission && (!res.IsStoryteller || res.OwnerID != st.ID || len(res.VoterIDs) != 2) {
			t.Fatalf("bad storyteller result %+v", res)
		}
	}
	wantCode(t, r.Vote(oth[2].ID, st.Submission), CodeInvalidPhase)

	// Next round: storyteller rotates in join order, fresh hands.
	prevST := st.ID
	if err := r.NextRound(pool(300)); err != nil {
		t.Fatal(err)
	}
	if r.Round.Number != 2 || r.Round.Phase != PhaseStoryteller {
		t.Fatal("expected round 2 storyteller phase")
	}
	idx := -1
	for i, p := range r.Players {
		if p.ID == prevST {
			idx = i
		}
	}
	if r.Round.StorytellerID != r.Players[(idx+1)%len(r.Players)].ID {
		t.Fatalf("storyteller did not rotate in join order: %s after %s", r.Round.StorytellerID, prevST)
	}
	for _, p := range r.Players {
		if p.Submission != "" || p.Vote != "" || len(p.Hand) != HandSize {
			t.Fatal("round state not reset")
		}
	}
}

// playRound plays a full round where everybody votes for the storyteller's
// clip (storyteller 0, others +2) and returns the storyteller.
func playRound(t *testing.T, r *Room) *Player {
	t.Helper()
	st := storyteller(r)
	if err := r.SubmitClue(st.ID, st.Hand[0].ID, "clue"); err != nil {
		t.Fatal(err)
	}
	for _, p := range others(r) {
		if err := r.SubmitClip(p.ID, p.Hand[0].ID); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range others(r) {
		if err := r.Vote(p.ID, st.Submission); err != nil {
			t.Fatal(err)
		}
	}
	return st
}

func TestUsedSoundsNeverRedealt(t *testing.T) {
	r, _ := startedRoom(t, 4)
	p := pool(1000)
	seen := map[string]int{}
	record := func() {
		for _, pl := range r.Players {
			if len(pl.Hand) != HandSize {
				t.Fatalf("hand size %d", len(pl.Hand))
			}
			for _, c := range pl.Hand {
				seen[c.ID]++
				if seen[c.ID] > 1 {
					t.Fatalf("clip %s dealt twice", c.ID)
				}
				if !r.Used[c.ID] {
					t.Fatalf("clip %s dealt but not marked used", c.ID)
				}
			}
		}
	}
	record()
	games := 0
	for games < 3 {
		playRound(t, r)
		if r.Status == StatusFinished {
			games++
			if err := r.Start(p); err != nil {
				t.Fatal(err)
			}
			for _, pl := range r.Players {
				if pl.Score != 0 {
					t.Fatal("scores must reset on a new game")
				}
			}
		} else if err := r.NextRound(p); err != nil {
			t.Fatal(err)
		}
		record()
	}
	if len(seen) != len(r.Used) {
		t.Fatalf("used set %d differs from dealt clips %d", len(r.Used), len(seen))
	}
}

func TestGameEndsAtTargetScore(t *testing.T) {
	r, _ := startedRoom(t, 4)
	rounds := 0
	for r.Status == StatusPlaying {
		playRound(t, r)
		rounds++
		if r.Status == StatusPlaying {
			if err := r.NextRound(pool(300)); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Non-storytellers gain 2 per round. With 4 players everyone has been
	// storyteller once after 4 rounds (6 points each), so 10 is reached in
	// round 6 by the three players who were not storyteller in rounds 5-6.
	if rounds != 6 {
		t.Fatalf("expected 6 rounds, played %d", rounds)
	}
	if len(r.Winners) == 0 {
		t.Fatal("no winners")
	}
	best := 0
	for _, p := range r.Players {
		if p.Score > best {
			best = p.Score
		}
		if len(p.Hand) != 0 {
			t.Fatal("hands must be empty at the end of the game")
		}
	}
	for _, w := range r.Winners {
		if r.player(w).Score != best {
			t.Fatal("winner without the best score")
		}
	}
	if r.Round == nil || r.Round.Reveal == nil {
		t.Fatal("final reveal must stay visible")
	}
	wantCode(t, r.NextRound(pool(300)), CodeInvalidPhase)
	// The room stays locked once finished, but players may leave.
	_, err := r.Join("late")
	wantCode(t, err, CodeGameStarted)
	// A new game can start in the same room with the same players.
	if err := r.Start(pool(300)); err != nil {
		t.Fatal(err)
	}
	if r.Status != StatusPlaying || r.Round.Number != 1 || len(r.Winners) != 0 {
		t.Fatal("new game did not reset")
	}
	for r.Status == StatusPlaying {
		playRound(t, r)
		if r.Status == StatusPlaying {
			if err := r.NextRound(pool(300)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := r.Leave(r.Players[3].ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, r.Start(pool(300)), CodeNotEnoughPlayers)
}

func TestGameEndsWhenPoolExhausted(t *testing.T) {
	r := NewRoom("TEST")
	r.SeedRNG(1)
	mustJoin(t, r, 4)
	p := pool(30) // one round of 24, then 6 left: not enough
	if err := r.Start(p); err != nil {
		t.Fatal(err)
	}
	playRound(t, r)
	if r.Status != StatusPlaying {
		t.Fatal("game should still be playing after round 1")
	}
	if err := r.NextRound(p); err != nil {
		t.Fatal(err)
	}
	if r.Status != StatusFinished || len(r.Winners) != 3 {
		t.Fatalf("expected finished with 3 tied winners, got %s %v", r.Status, r.Winners)
	}
	// Used sounds persist: a new game cannot be dealt from the same pool.
	wantCode(t, r.Start(p), CodeNotEnoughSounds)
}

func TestSnapshotVisibility(t *testing.T) {
	r, _ := startedRoom(t, 4)
	st := storyteller(r)
	oth := others(r)

	for _, p := range r.Players {
		s := r.Snapshot(p.ID)
		if s.Type != "state" || s.Room.Code != "TEST" || s.Room.Status != StatusPlaying || s.Room.TargetScore != TargetScore {
			t.Fatalf("bad room state %+v", s.Room)
		}
		if s.You.PlayerID != p.ID || len(s.You.Hand) != HandSize {
			t.Fatalf("bad you state %+v", s.You)
		}
		for i, c := range s.You.Hand {
			if c != p.Hand[i] {
				t.Fatal("hand differs from the player's own hand")
			}
		}
		if s.Round == nil || s.Round.Clue != nil || s.Round.Reveal != nil || len(s.Round.Table) != 0 {
			t.Fatalf("bad round state %+v", s.Round)
		}
		if s.Round.YourSubmission != nil || s.Round.YourVote != nil {
			t.Fatal("no submission yet")
		}
		if len(s.WinnerIDs) != 0 {
			t.Fatal("no winners yet")
		}
		for _, ps := range s.Players {
			if ps.IsStoryteller != (ps.PlayerID == st.ID) {
				t.Fatal("wrong storyteller flag")
			}
		}
	}
	// Hands are disjoint: a player never sees another player's clips.
	for _, a := range r.Players {
		for _, b := range r.Players {
			if a == b {
				continue
			}
			for _, c := range a.Hand {
				if inHand(b, c.ID) {
					t.Fatal("clip in two hands")
				}
			}
		}
	}

	if err := r.SubmitClue(st.ID, st.Hand[2].ID, "clue"); err != nil {
		t.Fatal(err)
	}
	s := r.Snapshot(oth[0].ID)
	if s.Round.Clue == nil || *s.Round.Clue != "clue" {
		t.Fatal("clue not visible to others")
	}
	if s.Round.YourSubmission != nil {
		t.Fatal("other player has no submission")
	}
	if len(s.Round.Table) != 0 {
		t.Fatal("storyteller clip must stay hidden")
	}
	ss := r.Snapshot(st.ID)
	if ss.Round.YourSubmission == nil || *ss.Round.YourSubmission != st.Hand[2].ID {
		t.Fatal("storyteller should see their own submission")
	}
	if !ss.Players[indexOf(r, st.ID)].HasSubmitted {
		t.Fatal("storyteller should be marked as submitted")
	}

	for _, p := range oth {
		if err := r.SubmitClip(p.ID, p.Hand[0].ID); err != nil {
			t.Fatal(err)
		}
	}
	// Vote phase: table visible, shuffled, owners hidden.
	s = r.Snapshot(oth[0].ID)
	if len(s.Round.Table) != 4 || s.Round.Reveal != nil {
		t.Fatalf("expected 4 anonymous clips, got %+v", s.Round)
	}
	joinOrder := true
	for i, p := range r.Players {
		if s.Round.Table[i].ID != p.Submission {
			joinOrder = false
		}
	}
	if joinOrder {
		t.Fatal("table is in join order: not shuffled (seeded rng)")
	}
	if *s.Round.YourSubmission != oth[0].Hand[0].ID {
		t.Fatal("wrong yourSubmission")
	}

	for _, p := range oth {
		if err := r.Vote(p.ID, st.Submission); err != nil {
			t.Fatal(err)
		}
	}
	s = r.Snapshot(oth[1].ID)
	if s.Round.Phase != PhaseReveal || s.Round.Reveal == nil || len(s.Round.Reveal.Results) != 4 {
		t.Fatal("reveal missing")
	}
	if *s.Round.YourVote != st.Submission {
		t.Fatal("wrong yourVote")
	}
	owners := map[string]bool{}
	for _, res := range s.Round.Reveal.Results {
		owners[res.OwnerID] = true
	}
	if len(owners) != 4 {
		t.Fatal("reveal must show every owner")
	}
	if !s.Players[indexOf(r, oth[1].ID)].HasVoted || s.Players[indexOf(r, st.ID)].HasVoted {
		t.Fatal("hasVoted flags wrong")
	}

	// Lobby snapshot: no round, empty hand.
	lobby := NewRoom("LOBY")
	ps := mustJoin(t, lobby, 2)
	ls := lobby.Snapshot(ps[0].ID)
	if ls.Round != nil || len(ls.You.Hand) != 0 || ls.Room.Status != StatusLobby || len(ls.Players) != 2 {
		t.Fatalf("bad lobby snapshot %+v", ls)
	}
	lobby.SetConnected(ps[1].ID, true)
	ls = lobby.Snapshot(ps[0].ID)
	if ls.Players[0].Connected || !ls.Players[1].Connected {
		t.Fatal("connected flags wrong")
	}
}

func indexOf(r *Room, id string) int {
	for i, p := range r.Players {
		if p.ID == id {
			return i
		}
	}
	return -1
}

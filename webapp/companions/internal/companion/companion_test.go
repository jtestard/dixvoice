package companion

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jtestard/dixvoice/webapp/companions/internal/gemini"
	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

func noDelay() time.Duration { return 0 }

func str(s string) *string { return &s }

func withDelay(d time.Duration) func(*Config) {
	return func(c *Config) { c.Delay = func() time.Duration { return d } }
}

// startCompanion joins the fake backend and runs the companion in the
// background; done receives Run's result.
func startCompanion(t *testing.T, b *fakeBackend, brain Brain, opts ...func(*Config)) (*Companion, *fakeConn, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	cfg := Config{
		BackendURL:      b.srv.URL,
		Nickname:        "Robo Ada",
		Brain:           brain,
		Delay:           noDelay,
		DecisionTimeout: 200 * time.Millisecond,
		MaxBackoff:      50 * time.Millisecond,
		MaxReconnects:   5,
	}
	for _, o := range opts {
		o(&cfg)
	}
	c, err := Join(ctx, cfg, "KXQP")
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	return c, b.waitConn(t), done
}

func lobby(playerID string) protocol.State {
	return protocol.State{
		Type:    "state",
		Room:    protocol.Room{Code: "KXQP", Status: "lobby", TargetScore: 10},
		You:     protocol.You{PlayerID: playerID, Hand: []protocol.Clip{}},
		Players: []protocol.Player{{PlayerID: playerID, Nickname: "Robo Ada", Connected: true, IsCompanion: true}},
	}
}

func playing(playerID string, round protocol.Round, hand []protocol.Clip) protocol.State {
	st := lobby(playerID)
	st.Room.Status = "playing"
	st.You.Hand = hand
	st.Round = &round
	return st
}

func TestJoinSendsCompanionFlag(t *testing.T) {
	b := newFakeBackend(t)
	c, _, _ := startCompanion(t, b, &scriptBrain{})
	j := b.waitJoin(t)
	if !j.Companion || j.Nickname != "Robo Ada" {
		t.Fatalf("join body %+v", j)
	}
	if c.PlayerID() != "p1" || c.RoomCode() != "KXQP" || b.joinCode != "KXQP" {
		t.Fatalf("player %q room %q", c.PlayerID(), c.RoomCode())
	}
}

func TestJoinRefused(t *testing.T) {
	b := newFakeBackend(t)
	b.joinStatus = http.StatusNotFound
	_, err := Join(context.Background(), Config{BackendURL: b.srv.URL, Brain: &scriptBrain{}}, "NOPE")
	var je *JoinError
	if !errors.As(err, &je) || je.Status != 404 || je.Code != "room_not_found" {
		t.Fatalf("got %v", err)
	}
}

func TestStorytellerSubmitsClue(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{clueID: "h3", clue: "a door in the rain"}
	_, fc, _ := startCompanion(t, b, brain)
	fc.send(t, lobby("p1"))
	fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseStoryteller, StorytellerID: "p1"}, clips("h1", "h2", "h3")))
	a := fc.expect(t)
	if a.Type != "submit_clue" || a.ClipID != "h3" || a.Clue != "a door in the rain" {
		t.Fatalf("got %+v", a)
	}
}

func TestNotStorytellerWaitsInStorytellerPhase(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{clueID: "h1", clue: "x", submitID: "h1", voteID: "h1"}
	_, fc, _ := startCompanion(t, b, brain)
	fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseStoryteller, StorytellerID: "p9"}, clips("h1", "h2")))
	fc.expectNothing(t, 200*time.Millisecond)
	// The storyteller does not submit or vote either.
	fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p1", Clue: str("c")}, clips("h1", "h2")))
	fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseVote, StorytellerID: "p1", Clue: str("c"), Table: clips("h1", "t2")}, clips("h1", "h2")))
	fc.expectNothing(t, 200*time.Millisecond)
	if brain.Calls() != 0 {
		t.Fatalf("brain called %d times", brain.Calls())
	}
}

func TestSubmitPhaseSubmitsClip(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{submitID: "h2"}
	_, fc, _ := startCompanion(t, b, brain)
	fc.send(t, playing("p1", protocol.Round{Number: 2, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("a door in the rain")}, clips("h1", "h2", "h3")))
	a := fc.expect(t)
	if a.Type != "submit_clip" || a.ClipID != "h2" || a.Clue != "" {
		t.Fatalf("got %+v", a)
	}
	// Already submitted: the next snapshot triggers nothing.
	fc.send(t, playing("p1", protocol.Round{Number: 2, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("a door in the rain"), YourSubmission: str("h2")}, clips("h1", "h2", "h3")))
	fc.expectNothing(t, 200*time.Millisecond)
}

func TestVotePhaseVotes(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{voteID: "t3"}
	_, fc, _ := startCompanion(t, b, brain)
	round := protocol.Round{Number: 2, Phase: protocol.PhaseVote, StorytellerID: "p9", Clue: str("clue"), YourSubmission: str("t1"), Table: clips("t1", "t2", "t3", "t4")}
	fc.send(t, playing("p1", round, clips("h1")))
	a := fc.expect(t)
	if a.Type != "vote" || a.ClipID != "t3" {
		t.Fatalf("got %+v", a)
	}
}

func TestNeverVotesForOwnClip(t *testing.T) {
	// The brain insists on the companion's own clip, or fails: the fallback
	// must still avoid it.
	for _, brain := range []Brain{&scriptBrain{voteID: "t1"}, &scriptBrain{err: errors.New("boom")}} {
		for range 10 {
			b := newFakeBackend(t)
			_, fc, _ := startCompanion(t, b, brain)
			round := protocol.Round{Number: 1, Phase: protocol.PhaseVote, StorytellerID: "p9", Clue: str("clue"), YourSubmission: str("t1"), Table: clips("t1", "t2", "t3")}
			fc.send(t, playing("p1", round, clips("h1")))
			a := fc.expect(t)
			if a.Type != "vote" || a.ClipID == "t1" || (a.ClipID != "t2" && a.ClipID != "t3") {
				t.Fatalf("got %+v", a)
			}
		}
	}
}

func TestFallbackOnBrainFailures(t *testing.T) {
	hand := clips("h1", "h2", "h3")
	valid := map[string]bool{"h1": true, "h2": true, "h3": true}
	cases := map[string]Brain{
		"error":        &scriptBrain{err: errors.New("gemini down")},
		"invalid clip": &scriptBrain{clueID: "zzz", clue: "x", submitID: "zzz", voteID: "zzz"},
		"empty clue":   &scriptBrain{clueID: "h1", clue: "   ", submitID: "h1", voteID: "h1"},
	}
	for name, brain := range cases {
		t.Run(name, func(t *testing.T) {
			b := newFakeBackend(t)
			_, fc, _ := startCompanion(t, b, brain)
			fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseStoryteller, StorytellerID: "p1"}, hand))
			a := fc.expect(t)
			if a.Type != "submit_clue" || !valid[a.ClipID] || a.Clue == "" {
				t.Fatalf("clue: got %+v", a)
			}
			if name != "empty clue" {
				fc.send(t, playing("p1", protocol.Round{Number: 2, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, hand))
				a = fc.expect(t)
				if a.Type != "submit_clip" || !valid[a.ClipID] {
					t.Fatalf("submit: got %+v", a)
				}
				fc.send(t, playing("p1", protocol.Round{Number: 2, Phase: protocol.PhaseVote, StorytellerID: "p9", Clue: str("c"), YourSubmission: str("h1"), Table: hand}, hand))
				a = fc.expect(t)
				if a.Type != "vote" || a.ClipID == "h1" || !valid[a.ClipID] {
					t.Fatalf("vote: got %+v", a)
				}
			}
		})
	}
}

// TestFallbackWithRealGeminiClient drives the real Gemini client against a
// fake Gemini server that errors, answers garbage or hangs.
func TestFallbackWithRealGeminiClient(t *testing.T) {
	hand := clips("h1", "h2", "h3")
	valid := map[string]bool{"h1": true, "h2": true, "h3": true}
	block := make(chan struct{})
	handlers := map[string]http.HandlerFunc{
		"http 500": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(500)
			fmt.Fprint(w, `{"error":{"code":500,"message":"boom"}}`)
		},
		"invalid json": func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `{"candidates":[{"content":{"parts":[{"text":"I pick h2!"}]}}]}`)
		},
		"unknown clip": func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `{"candidates":[{"content":{"parts":[{"text":"{\"clipId\":\"nope\"}"}]}}]}`)
		},
		"timeout": func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-block:
			case <-r.Context().Done():
			}
		},
	}
	for name, h := range handlers {
		t.Run(name, func(t *testing.T) {
			gem := httptest.NewServer(h)
			defer gem.Close()
			if name == "timeout" {
				defer close(block)
			}
			brain := gemini.New(gem.URL, "key", "", gem.Client())
			b := newFakeBackend(t)
			_, fc, _ := startCompanion(t, b, brain)
			start := time.Now()
			fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, hand))
			a := fc.expect(t)
			if a.Type != "submit_clip" || !valid[a.ClipID] {
				t.Fatalf("got %+v", a)
			}
			if name == "timeout" && time.Since(start) > 2*time.Second {
				t.Fatalf("decision timeout not honoured: %s", time.Since(start))
			}
		})
	}
}

func TestActsOncePerPhase(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{submitID: "h1", voteID: "t2"}
	_, fc, _ := startCompanion(t, b, brain)
	st := playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, clips("h1", "h2"))
	// Duplicate snapshots (e.g. another player reconnecting) before the
	// companion has answered.
	for range 3 {
		fc.send(t, st)
	}
	a := fc.expect(t)
	if a.Type != "submit_clip" {
		t.Fatalf("got %+v", a)
	}
	fc.expectNothing(t, 300*time.Millisecond)
	if brain.Calls() != 1 {
		t.Fatalf("brain called %d times", brain.Calls())
	}
	// A new round with the same phase is a new decision.
	st.Round.Number = 2
	fc.send(t, st)
	if a := fc.expect(t); a.Type != "submit_clip" {
		t.Fatalf("got %+v", a)
	}
}

func TestRetriesAfterBackendError(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{submitID: "h1"}
	_, fc, _ := startCompanion(t, b, brain)
	fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, clips("h1", "h2")))
	fc.expect(t)
	fc.send(t, protocol.Envelope{Type: "error", Code: "clip_not_in_hand", Message: "no"})
	if a := fc.expect(t); a.Type != "submit_clip" {
		t.Fatalf("got %+v", a)
	}
	// Bounded: after a few rejections it stops trying.
	for range 2 {
		fc.send(t, protocol.Envelope{Type: "error", Code: "clip_not_in_hand", Message: "no"})
		fc.expect(t)
	}
	fc.send(t, protocol.Envelope{Type: "error", Code: "clip_not_in_hand", Message: "no"})
	fc.expectNothing(t, 300*time.Millisecond)
}

func TestPendingMoveDroppedWhenPhaseMovesOn(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{submitID: "h1", voteID: "t2"}
	_, fc, _ := startCompanion(t, b, brain, withDelay(300*time.Millisecond))
	fc.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, clips("h1", "h2")))
	// The storyteller stops the game before the companion moves.
	fc.send(t, lobby("p1"))
	fc.expectNothing(t, 600*time.Millisecond)
}

func TestStopsOnRoomClosed(t *testing.T) {
	for _, reason := range []string{"stopped", "removed"} {
		b := newFakeBackend(t)
		_, fc, done := startCompanion(t, b, &scriptBrain{})
		fc.send(t, lobby("p1"))
		fc.roomClosed(t, reason)
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("%s: Run returned %v", reason, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: companion did not stop", reason)
		}
		select {
		case <-b.conns:
			t.Fatalf("%s: companion reconnected after room_closed", reason)
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func TestReconnectsOnDrop(t *testing.T) {
	b := newFakeBackend(t)
	brain := &scriptBrain{submitID: "h2"}
	_, fc, done := startCompanion(t, b, brain)
	fc.send(t, lobby("p1"))
	fc.drop()
	fc2 := b.waitConn(t)
	if fc2.token != fc.token {
		t.Fatalf("reconnected with token %q, want %q", fc2.token, fc.token)
	}
	// Plays normally after reconnecting.
	fc2.send(t, playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, clips("h1", "h2")))
	if a := fc2.expect(t); a.Type != "submit_clip" || a.ClipID != "h2" {
		t.Fatalf("got %+v", a)
	}
	select {
	case err := <-done:
		t.Fatalf("Run ended early: %v", err)
	default:
	}
}

func TestReconnectRedoesInterruptedMove(t *testing.T) {
	// The socket drops while a move is pending: after reconnecting, the
	// fresh snapshot must trigger the move again.
	b := newFakeBackend(t)
	brain := &scriptBrain{submitID: "h2"}
	_, fc, _ := startCompanion(t, b, brain, withDelay(200*time.Millisecond))
	st := playing("p1", protocol.Round{Number: 1, Phase: protocol.PhaseSubmit, StorytellerID: "p9", Clue: str("c")}, clips("h1", "h2"))
	fc.send(t, st)
	fc.drop()
	fc2 := b.waitConn(t)
	fc2.send(t, st)
	if a := fc2.expect(t); a.Type != "submit_clip" {
		t.Fatalf("got %+v", a)
	}
}

func TestStopsWhenTokenRejected(t *testing.T) {
	b := newFakeBackend(t)
	_, fc, done := startCompanion(t, b, &scriptBrain{})
	b.forget(fc.token)
	fc.drop()
	select {
	case err := <-done:
		if !errors.Is(err, ErrTokenRejected) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("companion kept retrying")
	}
}

func TestGivesUpAfterMaxReconnects(t *testing.T) {
	b := newFakeBackend(t)
	_, fc, done := startCompanion(t, b, &scriptBrain{})
	b.srv.CloseClientConnections()
	b.srv.Close()
	fc.drop()
	select {
	case err := <-done:
		if err == nil || errors.Is(err, ErrTokenRejected) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("companion never gave up")
	}
}

func TestWebsocketURL(t *testing.T) {
	cases := map[string]string{
		"http://backend:8080":       "ws://backend:8080/ws?token=t%2F1",
		"https://dixvoice.example/": "wss://dixvoice.example/ws?token=t%2F1",
		"http://host/base":          "ws://host/base/ws?token=t%2F1",
	}
	for in, want := range cases {
		got, err := websocketURL(in, "t/1")
		if err != nil || got != want {
			t.Errorf("%s: got %q %v, want %q", in, got, err, want)
		}
	}
	if _, err := websocketURL("ftp://x", "t"); err == nil {
		t.Error("ftp accepted")
	}
}

func TestRandomDelayRange(t *testing.T) {
	for range 100 {
		d := RandomDelay()
		if d < 2*time.Second || d >= 6*time.Second {
			t.Fatalf("delay %s out of range", d)
		}
	}
}

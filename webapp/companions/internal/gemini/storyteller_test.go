package gemini

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

// promptKind tells which of the storyteller's calls a prompt belongs to.
func promptKind(prompt string) string {
	switch {
	case strings.Contains(prompt, "Propose 4 candidates"):
		return "candidates"
	case strings.Contains(prompt, "Which clip is the storyteller's?"):
		return "guess"
	case strings.Contains(prompt, "You are the storyteller."):
		return "single"
	}
	return "other"
}

// scriptedGemini routes every generateContent call to answer, which gets
// the prompt and returns the JSON text to answer with (or "" to answer
// with HTTP 500). It records the prompts by kind.
type scriptedGemini struct {
	mu      sync.Mutex
	prompts map[string][]string
	guesses map[string]int // clue -> guesser calls seen so far
}

func newScriptedGemini(t *testing.T, answer func(s *scriptedGemini, kind, prompt string) string) (*Client, *scriptedGemini) {
	t.Helper()
	s := &scriptedGemini{prompts: map[string][]string{}, guesses: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("bad request body: %v", err)
		}
		prompt := req.Contents[0].Parts[0].Text
		kind := promptKind(prompt)
		s.mu.Lock()
		s.prompts[kind] = append(s.prompts[kind], prompt)
		text := answer(s, kind, prompt)
		s.mu.Unlock()
		if text == "" {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"error":{"code":500,"message":"boom"}}`)
			return
		}
		resp := map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": text}}}}}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, "secret", "test-model", srv.Client()), s
}

func (s *scriptedGemini) count(kind string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.prompts[kind])
}

// guessClue extracts the clue a guesser prompt quotes.
func guessClue(prompt string) string {
	_, rest, _ := strings.Cut(prompt, "clue:\n\"")
	clue, _, _ := strings.Cut(rest, "\"")
	return clue
}

func candidatesJSON(pairs ...string) string {
	var cands []map[string]string
	for i := 0; i+1 < len(pairs); i += 2 {
		cands = append(cands, map[string]string{"clipId": pairs[i], "clue": pairs[i+1]})
	}
	b, _ := json.Marshal(map[string]any{"candidates": cands})
	return string(b)
}

func clipJSON(id string) string { return fmt.Sprintf(`{"clipId":%q}`, id) }

// guessWith answers guesser calls so that the guessers find the target of
// clue finds times out of every GuessSamples calls, cycling through decoys
// otherwise.
func guessWith(s *scriptedGemini, prompt string, finders map[string]struct {
	target string
	finds  int
}) string {
	clue := guessClue(prompt)
	f, ok := finders[clue]
	if !ok {
		return ""
	}
	n := s.guesses[clue]
	s.guesses[clue]++
	if n%GuessSamples < f.finds {
		return clipJSON(f.target)
	}
	for _, c := range hand {
		if c.ClipID != f.target {
			return clipJSON(c.ClipID)
		}
	}
	return ""
}

type finder = struct {
	target string
	finds  int
}

func TestChooseCluePrefersHalfFound(t *testing.T) {
	// "silence behind the door" is found 3/3, "wax and wishes" 2/3: with 3
	// guessers the second is worth 2 points and the first 0.
	finders := map[string]finder{"silence behind the door": {"a1", 3}, "wax and wishes": {"a2", 2}}
	c, s := newScriptedGemini(t, func(s *scriptedGemini, kind, prompt string) string {
		switch kind {
		case "candidates":
			return candidatesJSON("a1", "silence behind the door", "a2", "wax and wishes")
		case "guess":
			return guessWith(s, prompt, finders)
		}
		return ""
	})
	id, clue, err := c.ChooseClue(context.Background(), protocol.ClueRequest{Hand: hand, Players: 4})
	if err != nil || id != "a2" || clue != "wax and wishes" {
		t.Fatalf("got %q %q %v", id, clue, err)
	}
	if n := s.count("guess"); n != 2*GuessSamples {
		t.Errorf("guesser calls: %d, want %d", n, 2*GuessSamples)
	}
	if s.count("single") != 0 {
		t.Errorf("fell back to the single shot")
	}
	// Guessers must not be told the answer, and see the whole hand.
	for _, p := range s.prompts["guess"] {
		if strings.Contains(p, "storyteller's clip is") {
			t.Errorf("guesser prompt leaks the answer")
		}
		for _, clip := range hand {
			if !strings.Contains(p, clip.Text) {
				t.Errorf("guesser prompt misses %q", clip.Text)
			}
		}
	}
	// The candidate prompt explains the scoring.
	if p := s.prompts["candidates"][0]; !strings.Contains(p, "score 0") || !strings.Contains(p, "3 other players") {
		t.Errorf("candidate prompt misses the scoring:\n%s", p)
	}
}

func TestRejectClue(t *testing.T) {
	clip := protocol.Clip{ClipID: "x", Text: "Is anyone there?", Emotion: "eerie"}
	cases := map[string]bool{
		"knock knock":       false,
		"Anyone home":       true, // shares "anyone"
		"is ANYONE home":    true, // case-insensitive
		"an eerie feeling":  true, // emotion label
		"eeries and echoes": true, // stemmed emotion
		"a b c d e f g h i": true, // 9 words
		"one two three four five six seven eight": false,
		"   ":       true,
		"is the of": false, // stopwords never overlap
	}
	for clue, reject := range cases {
		if got := RejectClue(clue, clip) != ""; got != reject {
			t.Errorf("%q: rejected=%v, want %v (%s)", clue, got, reject, RejectClue(clue, clip))
		}
	}
	birthday := protocol.Clip{ClipID: "y", Text: "Happy birthday!", Emotion: "joyful"}
	for _, clue := range []string{"so many birthdays", "the birthday's wish", "joyful noise"} {
		if RejectClue(clue, birthday) == "" {
			t.Errorf("%q vs %q accepted", clue, birthday.Text)
		}
	}
	if r := RejectClue("candles in the dark", birthday); r != "" {
		t.Errorf("candles rejected: %s", r)
	}
}

func TestLexicalFilterDropsObviousCandidates(t *testing.T) {
	finders := map[string]finder{"a knock at midnight": {"a1", 2}}
	c, s := newScriptedGemini(t, func(s *scriptedGemini, kind, prompt string) string {
		switch kind {
		case "candidates":
			return candidatesJSON(
				"a1", "is there anyone", // quotes the text
				"a2", "a joyful birthday", // text and emotion
				"a3", "going away angrily is what you do when you are mad at someone", // too long
				"a1", "a knock at midnight")
		case "guess":
			return guessWith(s, prompt, finders)
		}
		return ""
	})
	id, clue, err := c.ChooseClue(context.Background(), protocol.ClueRequest{Hand: hand, Players: 4})
	if err != nil || id != "a1" || clue != "a knock at midnight" {
		t.Fatalf("got %q %q %v", id, clue, err)
	}
	if n := s.count("guess"); n != GuessSamples {
		t.Errorf("guesser calls: %d, want %d (rejected candidates must not be simulated)", n, GuessSamples)
	}
}

func TestExpectedScoreBinomial(t *testing.T) {
	cases := []struct {
		p    float64
		g    int
		want float64
	}{
		{0, 3, 0},
		{1, 3, 0},
		{1.0 / 3, 2, 3 * (1 - 4.0/9 - 1.0/9)},   // 3 players
		{2.0 / 3, 3, 3 * (1 - 1.0/27 - 8.0/27)}, // 4 players
		{1.0 / 3, 7, 3 * (1 - math.Pow(2.0/3, 7) - math.Pow(1.0/3, 7))}, // 8 players
		{0.5, 1, 0}, // 2 players: nobody can be "some but not all"
	}
	for _, tc := range cases {
		if got := ExpectedScore(tc.p, tc.g); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("ExpectedScore(%v, %d) = %v, want %v", tc.p, tc.g, got, tc.want)
		}
	}
	if Guessers(0) != 3 || Guessers(3) != 2 || Guessers(8) != 7 {
		t.Errorf("Guessers: %d %d %d", Guessers(0), Guessers(3), Guessers(8))
	}
}

func TestChoiceFollowsBinomialMaths(t *testing.T) {
	// Three candidates found 1/3, 2/3 and 3/3 of the time.
	finders := map[string]finder{"salt and stone": {"a1", 1}, "wax and wishes": {"a2", 2}, "slam": {"a3", 3}}
	run := func(t *testing.T, players int) []Candidate {
		c, _ := newScriptedGemini(t, func(s *scriptedGemini, kind, prompt string) string {
			switch kind {
			case "candidates":
				return candidatesJSON("a1", "salt and stone", "a2", "wax and wishes", "a3", "slam")
			case "guess":
				return guessWith(s, prompt, finders)
			}
			return ""
		})
		cands, err := c.Candidates(context.Background(), protocol.ClueRequest{Hand: hand, Players: players})
		if err != nil {
			t.Fatal(err)
		}
		g := Guessers(players)
		for i := range cands {
			p, err := c.SimulateFinders(context.Background(), cands[i].Clue, hand, cands[i].ClipID)
			if err != nil {
				t.Fatal(err)
			}
			cands[i].P, cands[i].Expected = p, ExpectedScore(p, g)
		}
		return cands
	}
	check := func(t *testing.T, cands []Candidate, g int, wantBest string) {
		for _, cand := range cands {
			want := 3 * (1 - math.Pow(1-cand.P, float64(g)) - math.Pow(cand.P, float64(g)))
			if math.Abs(cand.Expected-want) > 1e-9 {
				t.Errorf("g=%d %q: expected %v, want %v", g, cand.Clue, cand.Expected, want)
			}
		}
		if best := Best(cands); best.Clue != wantBest {
			t.Errorf("g=%d: best %q (p=%v e=%v), want %q", g, best.Clue, best.P, best.Expected, wantBest)
		}
	}
	// 3 players, g=2: 1/3 and 2/3 tie at 4/3 points, the lower p wins; 3/3 scores 0.
	cands := run(t, 3)
	check(t, cands, 2, "salt and stone")
	if math.Abs(cands[0].Expected-4.0/3) > 1e-9 || math.Abs(cands[1].Expected-4.0/3) > 1e-9 || cands[2].Expected != 0 {
		t.Errorf("g=2 expected scores: %+v", cands)
	}
	// 8 players, g=7: still symmetric, so the tie-break decides again, and
	// the values are far higher than with 2 guessers.
	cands = run(t, 8)
	check(t, cands, 7, "salt and stone")
	if cands[0].Expected < 2.8 {
		t.Errorf("g=7 expected score for p=1/3: %v", cands[0].Expected)
	}
	// Ties broken by lower p, all-zero scores included (2 players).
	best := Best([]Candidate{{Clue: "x", P: 1}, {Clue: "y", P: 0.5}, {Clue: "z", P: 0}})
	if best.Clue != "z" {
		t.Errorf("all-zero tie: %q", best.Clue)
	}
	best = Best([]Candidate{{Clue: "x", P: 0.2, Expected: 1}, {Clue: "y", P: 0.6, Expected: 2}})
	if best.Clue != "y" {
		t.Errorf("higher expected must win: %q", best.Clue)
	}
}

func TestFallbackToSingleShot(t *testing.T) {
	single := `{"clipId":"a3","clue":"a slammed door"}`
	cases := map[string]func(s *scriptedGemini, kind, prompt string) string{
		"candidates call fails": func(s *scriptedGemini, kind, prompt string) string {
			if kind == "single" {
				return single
			}
			return ""
		},
		"candidates not json": func(s *scriptedGemini, kind, prompt string) string {
			if kind == "single" {
				return single
			}
			return "nope"
		},
		"every candidate filtered": func(s *scriptedGemini, kind, prompt string) string {
			switch kind {
			case "candidates":
				return candidatesJSON("a1", "anyone there", "a2", "happy birthday to you")
			case "single":
				return single
			}
			return ""
		},
		"guessers fail": func(s *scriptedGemini, kind, prompt string) string {
			switch kind {
			case "candidates":
				return candidatesJSON("a1", "knock knock")
			case "single":
				return single
			}
			return ""
		},
	}
	for name, answer := range cases {
		t.Run(name, func(t *testing.T) {
			c, s := newScriptedGemini(t, answer)
			id, clue, err := c.ChooseClue(context.Background(), protocol.ClueRequest{Hand: hand, Players: 4})
			if err != nil || id != "a3" || clue != "a slammed door" {
				t.Fatalf("got %q %q %v", id, clue, err)
			}
			if s.count("single") != 1 {
				t.Errorf("single-shot calls: %d", s.count("single"))
			}
		})
	}
	t.Run("everything fails", func(t *testing.T) {
		c, _ := newScriptedGemini(t, func(*scriptedGemini, string, string) string { return "" })
		if _, _, err := c.ChooseClue(context.Background(), protocol.ClueRequest{Hand: hand}); err == nil {
			t.Fatal("want an error")
		}
	})
}

func TestSearchTimeoutFallsBack(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	c, s := newScriptedGemini(t, func(s *scriptedGemini, kind, prompt string) string {
		if kind == "single" {
			return `{"clipId":"a1","clue":"knock knock"}`
		}
		s.mu.Unlock()
		<-block
		s.mu.Lock()
		return ""
	})
	c.WithClueTimeout(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	id, clue, err := c.ChooseClue(ctx, protocol.ClueRequest{Hand: hand, Players: 4})
	if err != nil || id != "a1" || clue != "knock knock" {
		t.Fatalf("got %q %q %v", id, clue, err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("search timeout not honoured: %s", time.Since(start))
	}
	if s.count("single") != 1 {
		t.Errorf("single-shot calls: %d", s.count("single"))
	}
	// When the caller's own deadline is gone there is no fallback.
	ectx, ecancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer ecancel()
	c.WithClueTimeout(time.Second)
	if _, _, err := c.ChooseClue(ectx, protocol.ClueRequest{Hand: hand}); err == nil {
		t.Fatal("want a deadline error")
	}
}

func TestHistoryReachesPrompt(t *testing.T) {
	finders := map[string]finder{"knock knock": {"a1", 2}}
	c, s := newScriptedGemini(t, func(s *scriptedGemini, kind, prompt string) string {
		switch kind {
		case "candidates":
			return candidatesJSON("a1", "knock knock")
		case "guess":
			return guessWith(s, prompt, finders)
		}
		return ""
	})
	history := []protocol.StorytellerResult{
		{Clue: "candles in the dark", Finders: 3, Guessers: 3},
		{Clue: "salt and stone", Finders: 0, Guessers: 3},
		{Clue: "wax and wishes", Finders: 1, Guessers: 3},
	}
	if _, _, err := c.ChooseClue(context.Background(), protocol.ClueRequest{Hand: hand, Players: 4, History: history}); err != nil {
		t.Fatal(err)
	}
	prompt := s.prompts["candidates"][0]
	for _, want := range []string{
		`"candles in the dark": 3 of 3 players found your clip (everyone found it`,
		`"salt and stone": 0 of 3 players found your clip (nobody found it`,
		`"wax and wishes": 1 of 3 players found your clip (good balance`,
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt misses %q:\n%s", want, prompt)
		}
	}
	for _, p := range s.prompts["guess"] {
		if strings.Contains(p, "candles in the dark") {
			t.Errorf("history leaked into a guesser prompt")
		}
	}
	// No history, no section.
	c2, s2 := newScriptedGemini(t, func(s *scriptedGemini, kind, prompt string) string {
		if kind == "candidates" {
			return candidatesJSON("a1", "knock knock")
		}
		return guessWith(s, prompt, finders)
	})
	if _, _, err := c2.ChooseClue(context.Background(), protocol.ClueRequest{Hand: hand, Players: 4}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s2.prompts["candidates"][0], "previous rounds") {
		t.Errorf("empty history section in prompt")
	}
}

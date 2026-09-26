package gemini

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

const (
	// DefaultClueTimeout bounds the candidate search (candidates call plus
	// guesser simulation) before ChooseClue falls back to a single shot.
	DefaultClueTimeout = 12 * time.Second
	// MaxClueWords is the longest clue the lexical filter accepts.
	MaxClueWords = 8
	// GuessSamples is how many simulated guessers are asked per candidate.
	GuessSamples = 3
	// defaultPlayers is assumed when the request does not say how many
	// players sit at the table.
	defaultPlayers = 4
	// storytellerPoints is what the storyteller (and each finder) scores
	// when some but not all guessers find the clip.
	storytellerPoints = 3
	// scoreEpsilon is the gap under which two expected scores are a tie.
	scoreEpsilon = 1e-9
)

// Candidate is one (clip, clue) pair proposed for a storyteller round, with
// the estimated chance p that a guesser finds the clip and the storyteller's
// expected score under Dixit rules.
type Candidate struct {
	ClipID   string
	Clue     string
	P        float64
	Expected float64
}

// ChooseClue picks a clip from the hand and writes a clue for it, reasoning
// like a Dixit storyteller: it asks for several candidate clues, drops the
// ones that lexically give the clip away, simulates the other players on
// each survivor and keeps the one with the best expected score. When the
// search fails or times out it falls back to ChooseClueSingle.
func (c *Client) ChooseClue(ctx context.Context, req protocol.ClueRequest) (clipID, clue string, err error) {
	if len(req.Hand) == 0 {
		return "", "", fmt.Errorf("%w: empty hand", ErrInvalidAnswer)
	}
	sctx, cancel := context.WithTimeout(ctx, c.clueTimeout)
	best, serr := c.searchClue(sctx, req)
	cancel()
	if serr == nil {
		return best.ClipID, best.Clue, nil
	}
	if ctx.Err() != nil {
		return "", "", ctx.Err()
	}
	c.log.Debug("clue search failed, falling back to single shot", "err", serr)
	return c.ChooseClueSingle(ctx, req)
}

// searchClue runs the candidate search and returns the winner.
func (c *Client) searchClue(ctx context.Context, req protocol.ClueRequest) (Candidate, error) {
	candidates, err := c.Candidates(ctx, req)
	if err != nil {
		return Candidate{}, err
	}
	var kept []Candidate
	for _, cand := range candidates {
		clip, ok := findClip(req.Hand, cand.ClipID)
		if !ok {
			continue
		}
		if reason := RejectClue(cand.Clue, clip); reason != "" {
			c.log.Debug("candidate rejected", "clipId", cand.ClipID, "clue", cand.Clue, "reason", reason)
			continue
		}
		kept = append(kept, cand)
	}
	if len(kept) == 0 {
		return Candidate{}, errors.New("gemini: every candidate failed the lexical filter")
	}
	guessers := Guessers(req.Players)
	var wg sync.WaitGroup
	errs := make([]error, len(kept))
	for i := range kept {
		wg.Add(1)
		go func(cand *Candidate, err *error) {
			defer wg.Done()
			cand.P, *err = c.SimulateFinders(ctx, cand.Clue, req.Hand, cand.ClipID)
			cand.Expected = ExpectedScore(cand.P, guessers)
		}(&kept[i], &errs[i])
	}
	wg.Wait()
	var scored []Candidate
	for i, cand := range kept {
		if errs[i] != nil {
			c.log.Debug("guesser simulation failed", "clipId", cand.ClipID, "clue", cand.Clue, "err", errs[i])
			continue
		}
		scored = append(scored, cand)
	}
	if len(scored) == 0 {
		return Candidate{}, fmt.Errorf("gemini: guesser simulation failed: %w", errors.Join(errs...))
	}
	best := Best(scored)
	c.log.Debug("clue chosen", "clipId", best.ClipID, "clue", best.Clue, "p", best.P, "expected", best.Expected, "guessers", guessers, "candidates", len(candidates), "kept", len(scored))
	return best, nil
}

// Best returns the candidate with the highest expected score, the lowest p
// breaking ties (a clue nobody finds costs the storyteller as much as one
// everybody finds, but it keeps the table guessing).
func Best(cands []Candidate) Candidate {
	best := cands[0]
	for _, cand := range cands[1:] {
		diff := cand.Expected - best.Expected
		if diff > scoreEpsilon || (math.Abs(diff) <= scoreEpsilon && cand.P < best.P) {
			best = cand
		}
	}
	return best
}

// Guessers is the number of players who vote on the storyteller's clue.
func Guessers(players int) int {
	if players < 2 {
		players = defaultPlayers
	}
	return players - 1
}

// ExpectedScore is the storyteller's expected score when each of the g
// guessers independently finds the clip with probability p: 3 points unless
// all or none of them find it (binomial model).
func ExpectedScore(p float64, g int) float64 {
	if g < 2 {
		return 0
	}
	return storytellerPoints * (1 - math.Pow(1-p, float64(g)) - math.Pow(p, float64(g)))
}

// Candidates asks Gemini for several (clip, clue) candidates at different
// levels of indirection.
func (c *Client) Candidates(ctx context.Context, req protocol.ClueRequest) ([]Candidate, error) {
	g := Guessers(req.Players)
	var b strings.Builder
	fmt.Fprintf(&b, `You are playing Dixit with 2-second sound clips instead of cards. You are the storyteller, and %d other players will try to find your clip.
Each clip is described by the text that is spoken and its emotion. Other players only HEAR the clip: they do not see the text.

Scoring, per round: you pick one clip from your hand and give a clue. Every other player submits a decoy clip that fits your clue, then everybody votes for the clip they think is yours.
- If ALL other players find your clip, or NONE of them do, you score 0 and each of them scores 2.
- Otherwise you score 3 and each player who found your clip scores 3.
So the best clue is found by SOME players, not all and not none. A clue that quotes or paraphrases the clip is a losing clue.

Propose 4 candidates, each on a different clip of your hand where possible, at different levels of indirection:
- a metaphor or image;
- a scene or situation where you would hear those words;
- a feeling or mood, without naming the emotion;
- a cultural reference (song, film, saying, place).
Rules for every clue: 2 to %d words; never reuse a word from the clip's text or its emotion label, not even a variation of it (plural, -ing, -ed); the clue must still fit the clip better than the other clips of your hand.
`, g, MaxClueWords)
	if hint := historyHint(req.History); hint != "" {
		b.WriteString("\nYour previous rounds as storyteller in this game:\n")
		b.WriteString(hint)
	}
	b.WriteString("\nYour hand:\n")
	b.WriteString(describeClips(req.Hand))
	b.WriteString(`Answer with JSON: {"candidates": [{"clipId": "<id from the hand>", "clue": "<your clue>"}, ...]}.`)

	schema := map[string]any{
		"type":     "OBJECT",
		"required": []string{"candidates"},
		"properties": map[string]any{
			"candidates": map[string]any{
				"type": "ARRAY",
				"items": map[string]any{
					"type":     "OBJECT",
					"required": []string{"clipId", "clue"},
					"properties": map[string]any{
						"clipId": map[string]any{"type": "STRING", "enum": clipIDs(req.Hand)},
						"clue":   map[string]any{"type": "STRING"},
					},
				},
			},
		},
	}
	var out struct {
		Candidates []struct {
			ClipID string `json:"clipId"`
			Clue   string `json:"clue"`
		} `json:"candidates"`
	}
	if err := c.generate(ctx, b.String(), schema, &out); err != nil {
		return nil, err
	}
	cands := make([]Candidate, 0, len(out.Candidates))
	for _, o := range out.Candidates {
		clue := strings.TrimSpace(o.Clue)
		if !hasClip(req.Hand, o.ClipID) || clue == "" {
			continue
		}
		cands = append(cands, Candidate{ClipID: o.ClipID, Clue: clue})
	}
	if len(cands) == 0 {
		return nil, fmt.Errorf("%w: no usable candidate", ErrInvalidAnswer)
	}
	return cands, nil
}

// historyHint turns the companion's past storyteller rounds into advice for
// the candidate prompt.
func historyHint(history []protocol.StorytellerResult) string {
	var b strings.Builder
	for _, h := range history {
		advice := "good balance, keep this level of subtlety"
		switch {
		case h.Guessers < 2:
		case h.Finders >= h.Guessers:
			advice = "everyone found it, you scored 0: be more oblique"
		case h.Finders == 0:
			advice = "nobody found it, you scored 0: be a bit more direct"
		}
		fmt.Fprintf(&b, "- clue %q: %d of %d players found your clip (%s).\n", h.Clue, h.Finders, h.Guessers, advice)
	}
	return b.String()
}

// SimulateFinders estimates the chance that a player who hears the clue
// picks target among the clips of hand (shuffled, standing in for the
// table), by asking Gemini several times without telling it the answer.
func (c *Client) SimulateFinders(ctx context.Context, clue string, hand []protocol.Clip, target string) (float64, error) {
	var wg sync.WaitGroup
	picks := make([]string, GuessSamples)
	errs := make([]error, GuessSamples)
	for i := range GuessSamples {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			picks[i], errs[i] = c.guess(ctx, clue, shuffled(hand))
		}(i)
	}
	wg.Wait()
	found, ok := 0, 0
	for i := range GuessSamples {
		if errs[i] != nil {
			continue
		}
		ok++
		if picks[i] == target {
			found++
		}
	}
	if ok == 0 {
		return 0, errors.Join(errs...)
	}
	return float64(found) / float64(ok), nil
}

// guess plays one voter: given the clue and the table, which clip is the
// storyteller's?
func (c *Client) guess(ctx context.Context, clue string, table []protocol.Clip) (string, error) {
	prompt := `You are playing Dixit with 2-second sound clips instead of cards. The storyteller gave the clue:
"` + clue + `"
The clips on the table are described by the text that is spoken and its emotion. Exactly one of them is the
storyteller's clip; the others are decoys. Which clip is the storyteller's? Follow your first instinct, like a
player who only heard each clip once.

Clips on the table:
` + describeClips(table) + `
Answer with JSON: {"clipId": "<id from the table>"}.`
	return c.chooseClip(ctx, prompt, table)
}

func shuffled(clips []protocol.Clip) []protocol.Clip {
	out := append([]protocol.Clip(nil), clips...)
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// RejectClue returns why the clue gives clip away, or "" when it passes the
// lexical filter: at most MaxClueWords words and no content word shared with
// the clip's text or emotion (case-insensitive, with simple stemming).
func RejectClue(clue string, clip protocol.Clip) string {
	words := tokens(clue)
	if len(words) == 0 {
		return "empty clue"
	}
	if len(words) > MaxClueWords {
		return fmt.Sprintf("%d words, more than %d", len(words), MaxClueWords)
	}
	forbidden := map[string]bool{}
	for _, w := range tokens(clip.Text + " " + clip.Emotion) {
		if !stopwords[w] {
			for _, v := range stems(w) {
				forbidden[v] = true
			}
		}
	}
	for _, w := range words {
		if stopwords[w] {
			continue
		}
		for _, v := range stems(w) {
			if forbidden[v] {
				return fmt.Sprintf("shares %q with the clip", w)
			}
		}
	}
	return ""
}

// tokens lower-cases s and splits it into words made of letters and digits
// (apostrophes are dropped, so "don't" becomes "dont").
func tokens(s string) []string {
	s = strings.NewReplacer("'", "", "’", "").Replace(strings.ToLower(s))
	return strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// stems returns w and w without a trailing -ing, -ed, -d, -es or -s, so
// that "birthdays" and "birthday" or "eeries" and "eerie" collide.
func stems(w string) []string {
	out := []string{w}
	for _, suffix := range []string{"ing", "ed", "d", "es", "s"} {
		if strings.HasSuffix(w, suffix) && len(w)-len(suffix) >= 2 {
			out = append(out, strings.TrimSuffix(w, suffix))
		}
	}
	return out
}

var stopwords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`a an the and or but if so of to in on at by for from with without into onto over under
	is are was were be been being am do does did done have has had having will would shall should can could may might must
	i me my mine you your yours he him his she her hers it its we us our ours they them their theirs this that these those
	what which who whom whose where when why how there here then than too very just not no yes dont doesnt didnt isnt arent
	wasnt werent cant couldnt wont wouldnt im youre hes shes its were theyre ive youve weve theyve ill youll well theyll
	again once now all any both each few more most other some such only own same as up down out off about above below
	after before during while because until through between against`) {
		stopwords[w] = true
	}
}

func findClip(clips []protocol.Clip, id string) (protocol.Clip, bool) {
	for _, c := range clips {
		if c.ClipID == id {
			return c, true
		}
	}
	return protocol.Clip{}, false
}

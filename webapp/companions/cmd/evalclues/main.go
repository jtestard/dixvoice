// Command evalclues compares the storyteller's old single-shot clue with the
// new candidate search against the real Gemini API: it deals hands from the
// audio library, asks both strategies for a clue and simulates guessers on
// each answer. It needs GEMINI_API_KEY.
//
//	GEMINI_API_KEY=... go run ./cmd/evalclues -hands 20 -players 4
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jtestard/dixvoice/webapp/companions/internal/gemini"
	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

func main() {
	library := flag.String("library", "../audio/library/manifest.json", "audio library manifest (id, text, emotion per clip)")
	hands := flag.Int("hands", 20, "number of hands to evaluate")
	handSize := flag.Int("hand", 6, "clips per hand")
	players := flag.Int("players", 4, "players in the room, storyteller included")
	samples := flag.Int("samples", 6, "simulated guessers per clue when measuring the find rate")
	seed := flag.Uint64("seed", 1, "random seed for dealing hands")
	verbose := flag.Bool("v", false, "debug logs from the Gemini client")
	flag.Parse()

	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "GEMINI_API_KEY is not set")
		os.Exit(2)
	}
	clips, err := loadLibrary(*library)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	logLevel := slog.LevelInfo
	if *verbose {
		logLevel = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel}))
	client := gemini.New(os.Getenv("GEMINI_BASE_URL"), apiKey, os.Getenv("GEMINI_MODEL"), &http.Client{Timeout: 30 * time.Second}).WithLogger(log)

	rng := rand.New(rand.NewPCG(*seed, *seed))
	g := gemini.Guessers(*players)
	var old, new stats
	fmt.Printf("model %s, %d hands of %d clips, %d players (g=%d), %d guesser samples per clue\n\n", client.Model(), *hands, *handSize, *players, g, *samples)
	for i := range *hands {
		hand := deal(rng, clips, *handSize)
		req := protocol.ClueRequest{Hand: hand, Players: *players}
		fmt.Printf("hand %d\n", i+1)
		old.add(evaluate(client, "single-shot", req, client.ChooseClueSingle, *samples, g))
		new.add(evaluate(client, "search", req, client.ChooseClue, *samples, g))
	}
	fmt.Println()
	fmt.Println("find rate p = share of simulated guessers who picked the storyteller's clip")
	old.report("single-shot (old)", g)
	new.report("candidate search (new)", g)
}

type chooser func(context.Context, protocol.ClueRequest) (string, string, error)

type result struct {
	p        float64
	expected float64
	ok       bool
}

func evaluate(client *gemini.Client, name string, req protocol.ClueRequest, choose chooser, samples, g int) result {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	id, clue, err := choose(ctx, req)
	if err != nil {
		fmt.Printf("  %-12s error: %v\n", name, err)
		return result{}
	}
	var clip protocol.Clip
	for _, c := range req.Hand {
		if c.ClipID == id {
			clip = c
		}
	}
	found, total := 0, 0
	for total < samples {
		p, err := client.SimulateFinders(ctx, clue, req.Hand, id)
		if err != nil {
			fmt.Printf("  %-12s guessers failed: %v\n", name, err)
			return result{}
		}
		found += int(math.Round(p * gemini.GuessSamples))
		total += gemini.GuessSamples
	}
	p := float64(found) / float64(total)
	e := gemini.ExpectedScore(p, g)
	reject := gemini.RejectClue(clue, clip)
	flag := ""
	if reject != "" {
		flag = "  [lexical: " + reject + "]"
	}
	fmt.Printf("  %-12s %q for %q (%s): p=%.2f expected=%.2f%s\n", name, clue, clip.Text, clip.Emotion, p, e, flag)
	return result{p: p, expected: e, ok: true}
}

type stats struct {
	ps, es   []float64
	failures int
}

func (s *stats) add(r result) {
	if !r.ok {
		s.failures++
		return
	}
	s.ps = append(s.ps, r.p)
	s.es = append(s.es, r.expected)
}

func (s *stats) report(name string, g int) {
	fmt.Printf("%s: %d clues, %d failures\n", name, len(s.ps), s.failures)
	if len(s.ps) == 0 {
		return
	}
	buckets := []string{"p=0", "0<p<=1/3", "1/3<p<2/3", "2/3<=p<1", "p=1"}
	counts := make([]int, len(buckets))
	for _, p := range s.ps {
		switch {
		case p == 0:
			counts[0]++
		case p <= 1.0/3:
			counts[1]++
		case p < 2.0/3:
			counts[2]++
		case p < 1:
			counts[3]++
		default:
			counts[4]++
		}
	}
	var b strings.Builder
	for i, name := range buckets {
		fmt.Fprintf(&b, "  %s: %d", name, counts[i])
	}
	fmt.Printf("  find rate distribution:%s\n", b.String())
	fmt.Printf("  mean p %.2f, median p %.2f, mean expected storyteller score %.2f (g=%d)\n", mean(s.ps), median(s.ps), mean(s.es), g)
}

func mean(xs []float64) float64 {
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

func median(xs []float64) float64 {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

// loadLibrary reads the audio library manifest (or any JSON array of
// objects with text and emotion, such as lines.json).
func loadLibrary(path string) ([]protocol.Clip, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var entries []struct {
		ID      string `json:"id"`
		Text    string `json:"text"`
		Emotion string `json:"emotion"`
		Enabled *bool  `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	var clips []protocol.Clip
	for i, e := range entries {
		if e.Text == "" || (e.Enabled != nil && !*e.Enabled) {
			continue
		}
		id := e.ID
		if id == "" {
			id = fmt.Sprintf("c%d", i+1)
		}
		clips = append(clips, protocol.Clip{ClipID: id, Text: e.Text, Emotion: e.Emotion})
	}
	if len(clips) == 0 {
		return nil, fmt.Errorf("%s: no clips", path)
	}
	return clips, nil
}

func deal(rng *rand.Rand, clips []protocol.Clip, n int) []protocol.Clip {
	perm := rng.Perm(len(clips))
	hand := make([]protocol.Clip, 0, n)
	for _, i := range perm[:min(n, len(clips))] {
		hand = append(hand, clips[i])
	}
	return hand
}

// Package mockaudio is a stand-in for the audio generator microservice for
// local development and tests. It serves GET /audio/list and GET /audio/{id}
// following spec/audio-response.schema.json, with fixture sounds whose
// clipUrl points at a few tone mp3 files it serves itself under /clips/.
package mockaudio

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"net/http"
	"strings"

	"github.com/jtestard/dixvoice/webapp/backend/internal/audio"
)

//go:embed clips/*.mp3
var clips embed.FS

const clipCount = 5

// lines are spoken texts paired with the emotion they are said with, like
// the AudioRequests that produced the library.
var lines = [][2]string{
	{"Is anyone there?", "eerie"},
	{"We did it, we actually did it!", "joyful"},
	{"Please, just leave me alone.", "sad"},
	{"Don't you dare touch that.", "angry"},
	{"The kettle is whistling again.", "calm"},
	{"I heard footsteps upstairs.", "eerie"},
	{"Five more minutes, I promise.", "sleepy"},
	{"What's behind the red door?", "curious"},
	{"Hurry, the train is leaving!", "excited"},
	{"The last candle just went out.", "eerie"},
	{"Where did I put my keys?", "curious"},
	{"Happy birthday to you!", "joyful"},
	{"The phone rang twice and stopped.", "eerie"},
	{"I never wanted it to end like this.", "sad"},
	{"Take a deep breath. Everything is fine.", "calm"},
	{"This is the third time this week!", "angry"},
	{"Look, a shooting star!", "excited"},
	{"Someone is at the window.", "eerie"},
	{"Good night, sleep tight.", "sleepy"},
	{"Do you think it remembers us?", "curious"},
	{"Wind under the bridge, all night long.", "calm"},
	{"I found a coin on the table.", "curious"},
	{"The elevator hums but never comes.", "eerie"},
	{"Hello? Can you hear me?", "curious"},
	{"Ring the bell twice if you are lost.", "calm"},
	{"The cat knocked it over again.", "angry"},
	{"Turn the page, slowly.", "calm"},
	{"Thunder, far away.", "eerie"},
	{"The radio only plays static now.", "sad"},
	{"A spoon in a cup, the morning begins.", "joyful"},
	{"The door won't close anymore.", "angry"},
	{"Tell me a story before I fall asleep.", "sleepy"},
	{"I can't believe you came!", "joyful"},
	{"There is a light under the sea.", "curious"},
	{"Run! It's right behind us!", "excited"},
	{"Nobody remembers my name here.", "sad"},
	{"Have you ever seen the sky so blue?", "joyful"},
	{"Stop the car. Now.", "angry"},
	{"The tide is coming in, gently.", "calm"},
	{"One more level, then bed.", "sleepy"},
}

// voices look like Gradium voice ids (16 letters and digits).
var voices = []string{
	"6MFfc37kq0sBjBjy", "YTkS9pxQ4mWvZ2eL", "qA7hL0dRcX3nUvKp", "Mw2zB8tJfE5sHy0G",
	"rV4cN1kXqP9mT6aD", "Zk3fH7yLbS0wQ8nE", "uE9dW2rTgK5xM1jC", "Ls6bP0vQnJ4yR7tA",
}

// Fixtures returns n deterministic AudioResponses. clipBase is the URL prefix
// used for clipUrl (e.g. "http://localhost:8081").
func Fixtures(n int, clipBase string) []audio.Response {
	rng := rand.New(rand.NewPCG(42, 7))
	out := make([]audio.Response, n)
	for i := range out {
		line := lines[i%len(lines)]
		out[i] = audio.Response{
			ID:      uuidV4(rng),
			Text:    line[0],
			Emotion: line[1],
			VoiceID: voices[(i/len(lines)+i)%len(voices)],
			ClipURL: fmt.Sprintf("%s/clips/tone%d.mp3", strings.TrimRight(clipBase, "/"), i%clipCount),
		}
	}
	return out
}

func uuidV4(rng *rand.Rand) string {
	var b [16]byte
	for i := range b {
		b[i] = byte(rng.UintN(256))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Service is the mock audio service.
type Service struct {
	// PublicURL, if set, is the prefix of every clipUrl. Otherwise the URL is
	// derived from each request's Host header.
	PublicURL string
	Count     int
}

func (s *Service) base(r *http.Request) string {
	if s.PublicURL != "" {
		return s.PublicURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Handler returns the mock's HTTP handler.
func (s *Service) Handler() http.Handler {
	if s.Count == 0 {
		s.Count = 300
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /audio/list", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, Fixtures(s.Count, s.base(r)))
	})
	mux.HandleFunc("GET /audio/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		for _, f := range Fixtures(s.Count, s.base(r)) {
			if f.ID == id {
				writeJSON(w, http.StatusOK, f)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "unknown audio id"})
	})
	mux.HandleFunc("POST /audio", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "not_implemented", "message": "the mock does not generate sounds"})
	})
	sub, err := fs.Sub(clips, "clips")
	if err != nil {
		panic(err)
	}
	mux.Handle("GET /clips/", http.StripPrefix("/clips/", http.FileServerFS(sub)))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	return mux
}

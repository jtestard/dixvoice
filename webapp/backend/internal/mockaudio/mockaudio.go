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

var words = []string{
	"a door in the rain", "is anyone there", "the kettle whistles", "footsteps upstairs", "a distant train",
	"the last candle", "keys in the dark", "laughter next door", "the phone rings twice", "wind under the bridge",
	"a coin on the table", "the elevator hums", "someone says hello", "a bicycle bell", "the cat knocks it over",
	"a page turns", "thunder far away", "the radio crackles", "a spoon in a cup", "the door won't close",
}

var emotions = []string{"joyful", "eerie", "calm", "angry", "sleepy", "curious", "sad", "excited"}

// Fixtures returns n deterministic AudioResponses. clipBase is the URL prefix
// used for clipUrl (e.g. "http://localhost:8081").
func Fixtures(n int, clipBase string) []audio.Response {
	rng := rand.New(rand.NewPCG(42, 7))
	out := make([]audio.Response, n)
	for i := range out {
		out[i] = audio.Response{
			ID:      uuidV4(rng),
			Text:    fmt.Sprintf("%s (%d)", words[i%len(words)], i+1),
			Emotion: emotions[i%len(emotions)],
			VoiceID: fmt.Sprintf("mock-voice-%d", i%3),
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

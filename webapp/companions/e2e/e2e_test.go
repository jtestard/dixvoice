// Package e2e plays a whole game against the real backend from
// ../../backend (with its mock audio service) using 4 companions driven by a
// fake Gemini server and one scripted human who starts the game, plays
// random moves and presses Next round.
//
// It builds and runs the backend binaries, so it needs the Go toolchain and
// the backend's dependencies in the module cache; it is skipped unless
// DIXVOICE_E2E=1.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jtestard/dixvoice/webapp/companions/internal/companion"
	"github.com/jtestard/dixvoice/webapp/companions/internal/gemini"
	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
	"github.com/jtestard/dixvoice/webapp/companions/internal/server"
)

func TestFullGameWithFourCompanions(t *testing.T) {
	if os.Getenv("DIXVOICE_E2E") == "" {
		t.Skip("set DIXVOICE_E2E=1 to run the end-to-end test against the real backend")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	backendURL := startBackend(t, ctx)
	geminiCalls := new(atomic.Int64)
	gem := fakeGemini(t, geminiCalls)
	brain := gemini.New(gem.URL, "test-key", "", gem.Client())

	svc := server.New(companion.Config{
		BackendURL: backendURL,
		Brain:      brain,
		Delay:      func() time.Duration { return time.Duration(rand.IntN(50)) * time.Millisecond },
	}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	api := httptest.NewServer(svc.Handler())
	defer api.Close()
	defer func() {
		sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer scancel()
		_ = svc.Shutdown(sctx)
	}()

	// A human creates the room and asks for 4 companions.
	var created protocol.JoinResponse
	postJSON(t, backendURL+"/rooms", map[string]any{"nickname": "Ana"}, &created)
	for range 4 {
		resp, err := http.Post(api.URL+"/companions", "application/json", strings.NewReader(fmt.Sprintf(`{"roomCode": %q}`, created.RoomCode)))
		if err != nil || resp.StatusCode != http.StatusAccepted {
			t.Fatalf("POST /companions: %v %v", resp, err)
		}
		resp.Body.Close()
	}

	human := dialHuman(t, ctx, backendURL, created.Token)
	st := human.waitFor(t, func(st *protocol.State) bool {
		connected := 0
		for _, p := range st.Players {
			if p.Connected {
				connected++
			}
		}
		return connected == 5
	})
	if svc.Running() != 4 {
		t.Fatalf("running companions: %d", svc.Running())
	}
	t.Logf("room %s: %d players", st.Room.Code, len(st.Players))

	human.send(t, protocol.Action{Type: "start_game"})
	rounds := 0
	for {
		st = human.waitFor(t, func(st *protocol.State) bool {
			if st.Room.Status == "finished" {
				return true
			}
			r := st.Round
			if r == nil {
				return false
			}
			me := st.You.PlayerID
			switch r.Phase {
			case protocol.PhaseStoryteller:
				return r.StorytellerID == me && r.Clue == nil
			case protocol.PhaseSubmit:
				return r.StorytellerID != me && r.YourSubmission == nil
			case protocol.PhaseVote:
				return r.StorytellerID != me && r.YourVote == nil
			case protocol.PhaseReveal:
				return true
			}
			return false
		})
		if st.Room.Status == "finished" {
			if st.Round != nil {
				rounds = st.Round.Number
			}
			break
		}
		r := st.Round
		switch r.Phase {
		case protocol.PhaseStoryteller:
			human.send(t, protocol.Action{Type: "submit_clue", ClipID: st.You.Hand[0].ClipID, Clue: "the human's clue"})
		case protocol.PhaseSubmit:
			human.send(t, protocol.Action{Type: "submit_clip", ClipID: st.You.Hand[rand.IntN(len(st.You.Hand))].ClipID})
		case protocol.PhaseVote:
			for _, clip := range r.Table {
				if r.YourSubmission == nil || clip.ClipID != *r.YourSubmission {
					human.send(t, protocol.Action{Type: "vote", ClipID: clip.ClipID})
					break
				}
			}
		case protocol.PhaseReveal:
			rounds++
			t.Logf("round %d reveal: clue %q, points %v", r.Number, deref(r.Clue), scores(st))
			human.send(t, protocol.Action{Type: "next_round"})
			// Wait for the round to actually advance before polling again.
			human.waitFor(t, func(n *protocol.State) bool {
				return n.Room.Status == "finished" || (n.Round != nil && n.Round.Number > r.Number)
			})
		}
	}
	t.Logf("game finished after %d rounds, winners %v, scores %v, gemini calls %d", rounds, st.WinnerIDs, scores(st), geminiCalls.Load())
	if rounds == 0 || len(st.WinnerIDs) == 0 {
		t.Fatalf("no full game played: rounds=%d winners=%v", rounds, st.WinnerIDs)
	}
	if geminiCalls.Load() == 0 {
		t.Fatal("Gemini was never called")
	}
	if len(human.errors) > 0 {
		t.Fatalf("human got errors: %v", human.errors)
	}

	human.send(t, protocol.Action{Type: "stop_game"})
	deadline := time.Now().Add(10 * time.Second)
	for svc.Running() > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if svc.Running() != 0 {
		t.Fatalf("%d companions still running after stop", svc.Running())
	}
}

// fakeGemini answers every request with the first clipId allowed by the
// request's response schema, and a clue when one is asked for.
func fakeGemini(t *testing.T, calls *atomic.Int64) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req struct {
			GenerationConfig struct {
				ResponseSchema struct {
					Properties map[string]struct {
						Enum  []string `json:"enum"`
						Items *struct {
							Properties map[string]struct {
								Enum []string `json:"enum"`
							} `json:"properties"`
						} `json:"items"`
					} `json:"properties"`
					Required []string `json:"required"`
				} `json:"responseSchema"`
			} `json:"generationConfig"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("fake gemini: bad request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var text []byte
		if items := req.GenerationConfig.ResponseSchema.Properties["candidates"].Items; items != nil {
			// The storyteller's candidate search: a few clues on random clips.
			enum := items.Properties["clipId"].Enum
			var cands []map[string]string
			for _, clue := range []string{"whispers behind the wall", "a knock at midnight", "salt and stone", "wax and wishes"} {
				cands = append(cands, map[string]string{"clipId": enum[rand.IntN(len(enum))], "clue": clue})
			}
			text, _ = json.Marshal(map[string]any{"candidates": cands})
		} else {
			enum := req.GenerationConfig.ResponseSchema.Properties["clipId"].Enum
			if len(enum) == 0 {
				t.Errorf("fake gemini: no clipId enum in schema")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			answer := map[string]string{"clipId": enum[rand.IntN(len(enum))]}
			for _, f := range req.GenerationConfig.ResponseSchema.Required {
				if f == "clue" {
					answer["clue"] = "whispers behind the wall"
				}
			}
			text, _ = json.Marshal(answer)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": string(text)}}}}},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// startBackend builds and runs the mock audio service and the backend from
// ../../backend and returns the backend URL.
func startBackend(t *testing.T, ctx context.Context) string {
	t.Helper()
	backendDir, err := filepath.Abs(filepath.Join("..", "..", "backend"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(backendDir, "go.mod")); err != nil {
		t.Skipf("backend sources not found at %s", backendDir)
	}
	bin := t.TempDir()
	for _, cmd := range []string{"server", "mockaudio"} {
		build := exec.CommandContext(ctx, "go", "build", "-o", filepath.Join(bin, cmd), "./cmd/"+cmd)
		build.Dir = backendDir
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build backend %s: %v\n%s", cmd, err, out)
		}
	}
	audioPort, backendPort := freePort(t), freePort(t)
	run(t, ctx, filepath.Join(bin, "mockaudio"), "MOCKAUDIO_ADDR=127.0.0.1:"+audioPort, "MOCKAUDIO_PUBLIC_URL=http://127.0.0.1:"+audioPort)
	run(t, ctx, filepath.Join(bin, "server"), "PORT="+backendPort, "AUDIO_SERVICE_URL=http://127.0.0.1:"+audioPort)
	backendURL := "http://127.0.0.1:" + backendPort
	waitHealthy(t, backendURL+"/healthz")
	return backendURL
}

func run(t *testing.T, ctx context.Context, bin string, env ...string) {
	t.Helper()
	cmd := exec.CommandContext(ctx, bin)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if os.Getenv("DIXVOICE_E2E_VERBOSE") != "" {
		cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", bin, err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

func waitHealthy(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never became healthy", url)
}

func postJSON(t *testing.T, url string, body any, out any) {
	t.Helper()
	data, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		t.Fatalf("POST %s: %d %s", url, resp.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("POST %s: bad response %s", url, raw)
	}
}

// human is the scripted player driving the game.
type human struct {
	conn   *websocket.Conn
	ctx    context.Context
	states chan *protocol.State
	errors []string
}

func dialHuman(t *testing.T, ctx context.Context, backendURL, token string) *human {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(backendURL, "http") + "/ws?token=" + token
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("human dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	h := &human{conn: conn, ctx: ctx, states: make(chan *protocol.State, 256)}
	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				close(h.states)
				return
			}
			var env protocol.Envelope
			_ = json.Unmarshal(data, &env)
			switch env.Type {
			case "state":
				var st protocol.State
				if err := json.Unmarshal(data, &st); err == nil {
					h.states <- &st
				}
			case "error":
				h.errors = append(h.errors, env.Code+": "+env.Message)
			}
		}
	}()
	return h
}

func (h *human) send(t *testing.T, a protocol.Action) {
	t.Helper()
	data, _ := json.Marshal(a)
	if err := h.conn.Write(h.ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("human send %s: %v", a.Type, err)
	}
}

func (h *human) waitFor(t *testing.T, cond func(*protocol.State) bool) *protocol.State {
	t.Helper()
	timeout := time.After(60 * time.Second)
	for {
		select {
		case st, ok := <-h.states:
			if !ok {
				t.Fatal("human socket closed")
			}
			if cond(st) {
				return st
			}
		case <-timeout:
			t.Fatal("timed out waiting for game state")
		}
	}
}

func scores(st *protocol.State) map[string]int {
	out := map[string]int{}
	for _, p := range st.Players {
		out[p.Nickname] = p.Score
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

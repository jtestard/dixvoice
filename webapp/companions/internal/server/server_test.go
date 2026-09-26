package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jtestard/dixvoice/webapp/companions/internal/companion"
	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

type nopBrain struct{}

func (nopBrain) ChooseClue(context.Context, protocol.ClueRequest) (string, string, error) {
	return "", "", nil
}
func (nopBrain) ChooseSubmission(context.Context, string, []protocol.Clip) (string, error) {
	return "", nil
}
func (nopBrain) ChooseVote(context.Context, string, []protocol.Clip) (string, error) { return "", nil }

// fakeBackend counts joins per room and holds every WebSocket open until the
// test closes it with room_closed.
type fakeBackend struct {
	mu    sync.Mutex
	joins map[string][]protocol.JoinRequest
	conns []*websocket.Conn
	srv   *httptest.Server
}

func newFakeBackend(t *testing.T) *fakeBackend {
	b := &fakeBackend{joins: map[string][]protocol.JoinRequest{}}
	mux := http.NewServeMux()
	n := 0
	mux.HandleFunc("POST /rooms/{code}/join", func(w http.ResponseWriter, r *http.Request) {
		code := r.PathValue("code")
		if code == "NOPE" {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(protocol.ErrorBody{Code: "room_not_found"})
			return
		}
		var req protocol.JoinRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		b.mu.Lock()
		b.joins[code] = append(b.joins[code], req)
		n++
		id := "p" + string(rune('0'+n))
		b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(protocol.JoinResponse{RoomCode: code, PlayerID: id, Token: "tok-" + id})
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		b.mu.Lock()
		b.conns = append(b.conns, conn)
		b.mu.Unlock()
		for {
			if _, _, err := conn.Read(r.Context()); err != nil {
				return
			}
		}
	})
	b.srv = httptest.NewServer(mux)
	t.Cleanup(b.srv.Close)
	return b
}

func (b *fakeBackend) closeRooms(t *testing.T) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range b.conns {
		msg, _ := json.Marshal(protocol.Envelope{Type: "room_closed", Reason: "stopped"})
		if err := c.Write(context.Background(), websocket.MessageText, msg); err != nil {
			t.Errorf("write: %v", err)
		}
		_ = c.Close(websocket.StatusNormalClosure, "")
	}
	b.conns = nil
}

func (b *fakeBackend) connCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.conns)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func newServer(t *testing.T, backendURL string) (*Server, *httptest.Server) {
	s := New(companion.Config{BackendURL: backendURL, Brain: nopBrain{}, MaxReconnects: 2, MaxBackoff: 10 * time.Millisecond}, nil)
	api := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		api.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(ctx)
	})
	return s, api
}

func post(t *testing.T, url, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(url+"/companions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestHealthz(t *testing.T) {
	_, api := newServer(t, "http://127.0.0.1:1")
	resp, err := http.Get(api.URL + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("got %v %v", resp, err)
	}
	resp.Body.Close()
}

func TestAddCompanionValidation(t *testing.T) {
	_, api := newServer(t, "http://127.0.0.1:1")
	for _, body := range []string{``, `not json`, `{}`, `{"roomCode": ""}`, `{"roomCode": 12}`, `{"roomCode": "with space"}`, `{"roomCode": "TOOLONGTOOLONGTOOLONG"}`, `{"roomCode": "a/b"}`} {
		if resp := post(t, api.URL, body); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("body %q: status %d, want 400", body, resp.StatusCode)
		}
	}
	req, _ := http.NewRequest(http.MethodGet, api.URL+"/companions", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET /companions: status %d", resp.StatusCode)
	}
}

func TestAddCompanionStartsOnePerCall(t *testing.T) {
	b := newFakeBackend(t)
	s, api := newServer(t, b.srv.URL)
	for range 3 {
		if resp := post(t, api.URL, `{"roomCode": "KXQP"}`); resp.StatusCode != http.StatusAccepted {
			t.Fatalf("status %d, want 202", resp.StatusCode)
		}
	}
	if resp := post(t, api.URL, `{"roomCode": "ZZZZ"}`); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status %d, want 202", resp.StatusCode)
	}
	waitFor(t, "4 companions", func() bool { return s.Running() == 4 && b.connCount() == 4 })
	b.mu.Lock()
	kxqp, zzzz := b.joins["KXQP"], b.joins["ZZZZ"]
	b.mu.Unlock()
	if len(kxqp) != 3 || len(zzzz) != 1 {
		t.Fatalf("joins: KXQP=%d ZZZZ=%d", len(kxqp), len(zzzz))
	}
	for _, j := range append(kxqp, zzzz...) {
		if !j.Companion || j.Nickname == "" {
			t.Errorf("bad join %+v", j)
		}
	}
	b.closeRooms(t)
	waitFor(t, "companions forgotten", func() bool { return s.Running() == 0 })
}

func TestAddCompanionUnknownRoomIsForgotten(t *testing.T) {
	b := newFakeBackend(t)
	s, api := newServer(t, b.srv.URL)
	if resp := post(t, api.URL, `{"roomCode": "NOPE"}`); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status %d, want 202", resp.StatusCode)
	}
	time.Sleep(100 * time.Millisecond)
	if s.Running() != 0 || b.connCount() != 0 {
		t.Fatalf("running=%d conns=%d", s.Running(), b.connCount())
	}
}

func TestShutdownDisconnectsCompanions(t *testing.T) {
	b := newFakeBackend(t)
	s, api := newServer(t, b.srv.URL)
	post(t, api.URL, `{"roomCode": "KXQP"}`)
	waitFor(t, "companion", func() bool { return s.Running() == 1 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Running() != 0 {
		t.Fatalf("running=%d", s.Running())
	}
	if resp := post(t, api.URL, `{"roomCode": "KXQP"}`); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status after shutdown %d", resp.StatusCode)
	}
}

package companion

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

// fakeBackend implements POST /rooms/{code}/join and GET /ws so tests can
// drive a companion with hand-made snapshots.
type fakeBackend struct {
	t   *testing.T
	srv *httptest.Server

	joins chan protocol.JoinRequest
	conns chan *fakeConn

	mu         sync.Mutex
	joinStatus int    // 0 -> 200
	joinCode   string // room code of the last join
	tokens     map[string]string
	nextPlayer int
}

type fakeConn struct {
	token   string
	conn    *websocket.Conn
	actions chan protocol.Action
	closed  chan struct{}
}

func newFakeBackend(t *testing.T) *fakeBackend {
	t.Helper()
	b := &fakeBackend{
		t:      t,
		joins:  make(chan protocol.JoinRequest, 16),
		conns:  make(chan *fakeConn, 16),
		tokens: map[string]string{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rooms/{code}/join", b.handleJoin)
	mux.HandleFunc("GET /ws", b.handleWS)
	b.srv = httptest.NewServer(mux)
	t.Cleanup(b.srv.Close)
	return b
}

func (b *fakeBackend) handleJoin(w http.ResponseWriter, r *http.Request) {
	var req protocol.JoinRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	b.joins <- req
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.joinStatus != 0 {
		w.WriteHeader(b.joinStatus)
		_ = json.NewEncoder(w).Encode(protocol.ErrorBody{Code: "room_not_found", Message: "nope"})
		return
	}
	b.nextPlayer++
	id := "p" + string(rune('0'+b.nextPlayer))
	token := "tok-" + id
	b.tokens[token] = id
	b.joinCode = r.PathValue("code")
	_ = json.NewEncoder(w).Encode(protocol.JoinResponse{RoomCode: r.PathValue("code"), PlayerID: id, Token: token})
}

func (b *fakeBackend) handleWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	b.mu.Lock()
	_, ok := b.tokens[token]
	b.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Header.Get("Origin") != "" {
		b.t.Errorf("companion sent an Origin header: %q", r.Header.Get("Origin"))
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	fc := &fakeConn{token: token, conn: conn, actions: make(chan protocol.Action, 16), closed: make(chan struct{})}
	b.conns <- fc
	defer close(fc.closed)
	for {
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var a protocol.Action
		if err := json.Unmarshal(data, &a); err != nil {
			b.t.Errorf("bad action %q: %v", data, err)
			continue
		}
		fc.actions <- a
	}
}

// forget makes the token unknown, like a deleted room (WS -> 401).
func (b *fakeBackend) forget(token string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.tokens, token)
}

func (b *fakeBackend) waitConn(t *testing.T) *fakeConn {
	t.Helper()
	select {
	case fc := <-b.conns:
		return fc
	case <-time.After(5 * time.Second):
		t.Fatal("companion did not connect")
		return nil
	}
}

func (b *fakeBackend) waitJoin(t *testing.T) protocol.JoinRequest {
	t.Helper()
	select {
	case j := <-b.joins:
		return j
	case <-time.After(5 * time.Second):
		t.Fatal("companion did not join")
		return protocol.JoinRequest{}
	}
}

func (fc *fakeConn) send(t *testing.T, msg any) {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := fc.conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("send: %v", err)
	}
}

func (fc *fakeConn) expect(t *testing.T) protocol.Action {
	t.Helper()
	select {
	case a := <-fc.actions:
		return a
	case <-time.After(5 * time.Second):
		t.Fatal("companion sent nothing")
		return protocol.Action{}
	}
}

func (fc *fakeConn) expectNothing(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case a := <-fc.actions:
		t.Fatalf("unexpected action %+v", a)
	case <-time.After(d):
	}
}

// drop closes the socket without a close frame, like a network failure.
func (fc *fakeConn) drop() {
	_ = fc.conn.CloseNow()
}

// roomClosed sends room_closed then closes the socket like the backend.
func (fc *fakeConn) roomClosed(t *testing.T, reason string) {
	fc.send(t, protocol.Envelope{Type: "room_closed", Reason: reason})
	_ = fc.conn.Close(websocket.StatusNormalClosure, "")
}

// scriptBrain answers with fixed choices, or fails with err.
type scriptBrain struct {
	clueID, clue string
	submitID     string
	voteID       string
	err          error

	mu    sync.Mutex
	calls int
}

func (s *scriptBrain) ChooseClue(context.Context, []protocol.Clip) (string, string, error) {
	s.count()
	return s.clueID, s.clue, s.err
}

func (s *scriptBrain) ChooseSubmission(context.Context, string, []protocol.Clip) (string, error) {
	s.count()
	return s.submitID, s.err
}

func (s *scriptBrain) ChooseVote(context.Context, string, []protocol.Clip) (string, error) {
	s.count()
	return s.voteID, s.err
}

func (s *scriptBrain) count() {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
}

func (s *scriptBrain) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func clips(ids ...string) []protocol.Clip {
	out := make([]protocol.Clip, 0, len(ids))
	for _, id := range ids {
		out = append(out, protocol.Clip{ClipID: id, ClipURL: "https://cdn/" + id + ".mp3", Text: "text " + id, Emotion: "calm", VoiceID: "v1"})
	}
	return out
}

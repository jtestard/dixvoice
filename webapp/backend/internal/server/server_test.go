package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jtestard/dixvoice/webapp/backend/internal/audio"
	"github.com/jtestard/dixvoice/webapp/backend/internal/companion"
	"github.com/jtestard/dixvoice/webapp/backend/internal/game"
	"github.com/jtestard/dixvoice/webapp/backend/internal/mockaudio"
)

const origin = "http://localhost:5173"

type env struct {
	t       *testing.T
	backend *httptest.Server
	mock    *httptest.Server
}

func newEnv(t *testing.T) *env {
	return newEnvWithCompanions(t, "")
}

// newEnvWithCompanions starts the backend with COMPANION_SERVICE_URL set to
// companionURL ("" for unset).
func newEnvWithCompanions(t *testing.T, companionURL string) *env {
	t.Helper()
	mock := httptest.NewServer((&mockaudio.Service{Count: 300}).Handler())
	t.Cleanup(mock.Close)
	srv := New(Config{AllowedOrigins: []string{origin}}, game.NewManager(), audio.NewClient(mock.URL),
		companion.NewClient(companionURL), slog.New(slog.NewTextHandler(io.Discard, nil)))
	backend := httptest.NewServer(srv.Handler())
	t.Cleanup(backend.Close)
	return &env{t: t, backend: backend, mock: mock}
}

func (e *env) post(path string, body any) (int, map[string]any) {
	e.t.Helper()
	return e.postFrom(origin, path, body)
}

// postFrom posts with the given Origin header ("" sends none).
func (e *env) postFrom(from, path string, body any) (int, map[string]any) {
	e.t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, e.backend.URL+path, bytes.NewReader(data))
	if from != "" {
		req.Header.Set("Origin", from)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

type player struct {
	t     *testing.T
	id    string
	token string
	conn  *websocket.Conn
	state game.State
}

func (e *env) connect(id, token string) *player {
	e.t.Helper()
	return e.connectFrom(origin, id, token)
}

// connectFrom opens the WebSocket with the given Origin header ("" sends
// none, like a non-browser client).
func (e *env) connectFrom(from, id, token string) *player {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(e.backend.URL, "http://", "ws://", 1) + "/ws?token=" + token
	hdr := http.Header{}
	if from != "" {
		hdr.Set("Origin", from)
	}
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		e.t.Fatalf("dial: %v", err)
	}
	e.t.Cleanup(func() { _ = conn.CloseNow() })
	p := &player{t: e.t, id: id, token: token, conn: conn}
	p.expectState()
	return p
}

func (p *player) send(msg map[string]any) {
	p.t.Helper()
	data, _ := json.Marshal(msg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.conn.Write(ctx, websocket.MessageText, data); err != nil {
		p.t.Fatalf("%s write: %v", p.id, err)
	}
}

// read returns the next message and its type.
func (p *player) read() (string, []byte) {
	p.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := p.conn.Read(ctx)
	if err != nil {
		p.t.Fatalf("%s read: %v", p.id, err)
	}
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(data, &head)
	return head.Type, data
}

func (p *player) expectState() game.State {
	p.t.Helper()
	typ, data := p.read()
	if typ != "state" {
		p.t.Fatalf("%s: expected state, got %s", p.id, data)
	}
	var st game.State
	if err := json.Unmarshal(data, &st); err != nil {
		p.t.Fatal(err)
	}
	if st.You.PlayerID != p.id {
		p.t.Fatalf("%s got a snapshot for %s", p.id, st.You.PlayerID)
	}
	for _, c := range append(append([]game.Clip{}, st.You.Hand...), tableOf(st)...) {
		if c.ID == "" || c.URL == "" || c.Text == "" || c.Emotion == "" || c.VoiceID == "" {
			p.t.Fatalf("clip is not a full AudioResponse: %+v", c)
		}
	}
	if bytes.Contains(data, []byte(`"id"`)) {
		p.t.Fatalf("snapshot clips must use clipId, not id: %s", data)
	}
	p.state = st
	return st
}

func tableOf(st game.State) []game.Clip {
	if st.Round == nil {
		return nil
	}
	return st.Round.Table
}

func (p *player) expectError(code string) {
	p.t.Helper()
	typ, data := p.read()
	var e wsError
	_ = json.Unmarshal(data, &e)
	if typ != "error" || e.Code != code {
		p.t.Fatalf("%s: expected error %s, got %s", p.id, code, data)
	}
}

func (p *player) expectClosed(reason string) {
	p.t.Helper()
	typ, data := p.read()
	var rc roomClosed
	_ = json.Unmarshal(data, &rc)
	if typ != "room_closed" || rc.Reason != reason {
		p.t.Fatalf("%s: expected room_closed %s, got %s", p.id, reason, data)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := p.conn.Read(ctx); err == nil {
		p.t.Fatalf("%s: socket still open after room_closed", p.id)
	}
}

func all(ps []*player, f func(*player)) {
	for _, p := range ps {
		f(p)
	}
}

func setupRoom(t *testing.T, e *env, n int) (string, []*player) {
	t.Helper()
	status, body := e.post("/rooms", map[string]string{"nickname": "Ana"})
	if status != http.StatusCreated {
		t.Fatalf("create room: %d %v", status, body)
	}
	code := body["roomCode"].(string)
	seats := [][2]string{{body["playerId"].(string), body["token"].(string)}}
	for i := 1; i < n; i++ {
		status, body := e.post("/rooms/"+code+"/join", map[string]string{"nickname": fmt.Sprintf("P%d", i)})
		if status != http.StatusOK {
			t.Fatalf("join: %d %v", status, body)
		}
		seats = append(seats, [2]string{body["playerId"].(string), body["token"].(string)})
	}
	var ps []*player
	for i, s := range seats {
		p := e.connect(s[0], s[1])
		// Each earlier player receives a state update for this connection.
		for _, q := range ps[:i] {
			q.expectState()
		}
		ps = append(ps, p)
	}
	return code, ps
}

func TestHTTPEndpoints(t *testing.T) {
	e := newEnv(t)

	// healthz
	resp, err := http.Get(e.backend.URL + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %v %v", err, resp)
	}

	// CORS preflight.
	req, _ := http.NewRequest(http.MethodOptions, e.backend.URL+"/rooms", nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != origin {
		t.Fatalf("cors preflight: %d %v", resp.StatusCode, resp.Header)
	}
	req.Header.Set("Origin", "http://evil.example")
	resp, _ = http.DefaultClient.Do(req)
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("cors allowed an unknown origin")
	}

	// Audio proxy: the audio service's AudioResponse, unchanged.
	resp, _ = http.Get(e.backend.URL + "/audio/list")
	data, _ := io.ReadAll(resp.Body)
	var list []map[string]any
	if err := json.Unmarshal(data, &list); err != nil || len(list) != 300 {
		t.Fatalf("audio list: %v %d", err, len(list))
	}
	upstream, _ := http.Get(e.mock.URL + "/audio/list")
	upstreamData, _ := io.ReadAll(upstream.Body)
	if !bytes.Equal(bytes.TrimSpace(data), bytes.TrimSpace(upstreamData)) {
		t.Fatalf("audio list differs from the audio service's:\n%s\n%s", data[:200], upstreamData[:200])
	}
	for _, k := range []string{"id", "clipUrl", "text", "emotion", "voiceId"} {
		if v, ok := list[0][k].(string); !ok || v == "" {
			t.Fatalf("audio list entry lacks %q: %v", k, list[0])
		}
	}
	if len(list[0]) != 5 {
		t.Fatalf("audio list entry has unexpected fields: %v", list[0])
	}
	resp, _ = http.Get(e.backend.URL + "/audio/" + list[0]["id"].(string))
	var one map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&one)
	if resp.StatusCode != http.StatusOK || fmt.Sprint(one) != fmt.Sprint(list[0]) {
		t.Fatalf("audio get: %d %v want %v", resp.StatusCode, one, list[0])
	}
	resp, _ = http.Get(e.backend.URL + "/audio/00000000-0000-4000-8000-000000000000")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("audio get unknown: %d", resp.StatusCode)
	}
	// The clipUrl is playable (served by the mock).
	resp, _ = http.Get(one["clipUrl"].(string))
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("clip not served: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	// Rooms: join errors.
	status, body := e.post("/rooms", map[string]string{"nickname": ""})
	if status != http.StatusBadRequest || body["code"] != game.CodeInvalidNickname {
		t.Fatalf("empty nickname: %d %v", status, body)
	}
	status, body = e.post("/rooms/ZZZZ/join", map[string]string{"nickname": "x"})
	if status != http.StatusNotFound || body["code"] != game.CodeRoomNotFound {
		t.Fatalf("unknown room: %d %v", status, body)
	}
	status, body = e.post("/rooms", map[string]string{"nickname": "Ana"})
	code := body["roomCode"].(string)
	for i := 0; i < 7; i++ {
		if status, body = e.post("/rooms/"+code+"/join", map[string]string{"nickname": "x"}); status != http.StatusOK {
			t.Fatalf("join %d: %d %v", i, status, body)
		}
	}
	status, body = e.post("/rooms/"+strings.ToLower(code)+"/join", map[string]string{"nickname": "ninth"})
	if status != http.StatusConflict || body["code"] != game.CodeRoomFull {
		t.Fatalf("room full: %d %v", status, body)
	}

	// Unknown token on /ws.
	resp, _ = http.Get(e.backend.URL + "/ws?token=bogus")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("ws bogus token: %d", resp.StatusCode)
	}
}

func TestEndToEndGame(t *testing.T) {
	e := newEnv(t)
	code, ps := setupRoom(t, e, 4)
	byID := map[string]*player{}
	for _, p := range ps {
		byID[p.id] = p
	}
	if ps[0].state.Room.Status != game.StatusLobby || len(ps[0].state.Players) != 4 || ps[0].state.Round != nil {
		t.Fatalf("bad lobby state %+v", ps[0].state)
	}
	for _, s := range ps[3].state.Players {
		if !s.Connected {
			t.Fatalf("player %s should be connected", s.PlayerID)
		}
	}

	// Locked after start: join fails.
	ps[1].send(map[string]any{"type": "start_game"})
	all(ps, func(p *player) { p.expectState() })
	if status, body := e.post("/rooms/"+code+"/join", map[string]string{"nickname": "late"}); status != http.StatusConflict || body["code"] != game.CodeGameStarted {
		t.Fatalf("join after start: %d %v", status, body)
	}
	ps[2].send(map[string]any{"type": "start_game"})
	ps[2].expectError(game.CodeInvalidPhase)
	ps[2].send(map[string]any{"type": "leave_room"})
	ps[2].expectError(game.CodeInvalidPhase)
	ps[2].send(map[string]any{"type": "bogus"})
	ps[2].expectError("invalid_message")

	dealt := map[string]bool{}
	recordHands := func() {
		t.Helper()
		for _, p := range ps {
			if len(p.state.You.Hand) != game.HandSize {
				t.Fatalf("%s hand size %d", p.id, len(p.state.You.Hand))
			}
			for _, c := range p.state.You.Hand {
				if dealt[c.ID] {
					t.Fatalf("clip %s dealt twice", c.ID)
				}
				if !strings.HasPrefix(c.URL, e.mock.URL+"/clips/") {
					t.Fatalf("bad clipUrl %s", c.URL)
				}
				dealt[c.ID] = true
			}
		}
	}

	rounds := 0
	for ps[0].state.Room.Status == game.StatusPlaying {
		rounds++
		recordHands()
		st := byID[ps[0].state.Round.StorytellerID]
		var others []*player
		for _, p := range ps {
			if p != st {
				others = append(others, p)
			}
		}
		if ps[0].state.Round.Phase != game.PhaseStoryteller || ps[0].state.Round.Number != rounds {
			t.Fatalf("round %d: bad phase %+v", rounds, ps[0].state.Round)
		}

		// Validation over the wire.
		others[0].send(map[string]any{"type": "submit_clue", "clipId": others[0].state.You.Hand[0].ID, "clue": "nope"})
		others[0].expectError(game.CodeNotYourTurn)
		st.send(map[string]any{"type": "submit_clue", "clipId": others[0].state.You.Hand[0].ID, "clue": "nope"})
		st.expectError(game.CodeClipNotInHand)

		storyClip := st.state.You.Hand[1].ID
		st.send(map[string]any{"type": "submit_clue", "clipId": storyClip, "clue": "a door in the rain"})
		all(ps, func(p *player) { p.expectState() })
		if others[0].state.Round.Phase != game.PhaseSubmit || *others[0].state.Round.Clue != "a door in the rain" || len(others[0].state.Round.Table) != 0 {
			t.Fatalf("bad submit state %+v", others[0].state.Round)
		}

		for i, p := range others {
			p.send(map[string]any{"type": "submit_clip", "clipId": p.state.You.Hand[i].ID})
			all(ps, func(q *player) { q.expectState() })
			if i == 0 {
				p.send(map[string]any{"type": "submit_clip", "clipId": p.state.You.Hand[3].ID})
				p.expectError(game.CodeAlreadySubmitted)
			}
		}
		if others[0].state.Round.Phase != game.PhaseVote || len(others[0].state.Round.Table) != 4 {
			t.Fatalf("bad vote state %+v", others[0].state.Round)
		}
		// Owners hidden during the vote; each player knows only their own clip.
		if others[0].state.Round.Reveal != nil || *others[0].state.Round.YourSubmission != others[0].state.You.Hand[0].ID {
			t.Fatalf("vote leaks: %+v", others[0].state.Round)
		}

		others[0].send(map[string]any{"type": "vote", "clipId": *others[0].state.Round.YourSubmission})
		others[0].expectError(game.CodeCannotVoteOwn)
		st.send(map[string]any{"type": "vote", "clipId": others[0].state.Round.Table[0].ID})
		st.expectError(game.CodeNotYourTurn)
		for i, p := range others {
			// First two find the storyteller's clip, the third votes for the
			// first non-own, non-storyteller clip on the table.
			target := storyClip
			if i == 2 {
				for _, c := range p.state.Round.Table {
					if c.ID != storyClip && c.ID != *p.state.Round.YourSubmission {
						target = c.ID
						break
					}
				}
			}
			p.send(map[string]any{"type": "vote", "clipId": target})
			all(ps, func(q *player) { q.expectState() })
		}
		rv := ps[0].state.Round
		if rv.Phase != game.PhaseReveal || rv.Reveal == nil || len(rv.Reveal.Results) != 4 {
			t.Fatalf("bad reveal %+v", rv)
		}
		if rv.Reveal.Points[st.id] != 3 || rv.Reveal.Points[others[0].id] < 3 || rv.Reveal.Points[others[1].id] < 3 || rv.Reveal.Points[others[2].id] != 0 {
			t.Fatalf("bad points %v", rv.Reveal.Points)
		}
		for _, res := range rv.Reveal.Results {
			if res.ClipID == storyClip && (!res.IsStoryteller || res.OwnerID != st.id || len(res.VoterIDs) != 2) {
				t.Fatalf("bad storyteller reveal %+v", res)
			}
		}
		if ps[0].state.Room.Status != game.StatusPlaying || len(ps[0].state.WinnerIDs) != 0 {
			t.Fatalf("reveal should remain playable before Next round: %+v", ps[0].state.Room)
		}
		ps[3].send(map[string]any{"type": "next_round"})
		all(ps, func(p *player) { p.expectState() })
	}
	// Scores: storyteller 3, two finders 3(+1 possibly) per round: 10 reached
	// after 3 or 4 rounds.
	if rounds > 4 {
		t.Fatalf("game took %d rounds", rounds)
	}
	fin := ps[0].state
	if fin.Room.Status != game.StatusFinished || len(fin.WinnerIDs) == 0 || len(fin.You.Hand) != 0 || fin.Round == nil || fin.Round.Reveal == nil {
		t.Fatalf("bad finished state %+v", fin)
	}

	// Reconnect with the same token: state again, seat kept.
	old := ps[1]
	_ = old.conn.CloseNow()
	all([]*player{ps[0], ps[2], ps[3]}, func(p *player) { p.expectState() }) // disconnected
	np := e.connect(old.id, old.token)
	all([]*player{ps[0], ps[2], ps[3]}, func(p *player) { p.expectState() }) // reconnected
	if np.state.Room.Status != game.StatusFinished || np.state.Room.Code != code {
		t.Fatalf("reconnect lost the seat: %+v", np.state.Room)
	}
	ps[1] = np

	// A completed session cannot start another game.
	ps[0].send(map[string]any{"type": "start_game"})
	ps[0].expectError(game.CodeInvalidPhase)

	// Stop: everyone gets room_closed, the socket closes, the room is gone.
	ps[3].send(map[string]any{"type": "stop_game"})
	all(ps, func(p *player) { p.expectClosed("stopped") })
	if status, body := e.post("/rooms/"+code+"/join", map[string]string{"nickname": "x"}); status != http.StatusNotFound {
		t.Fatalf("room still exists after stop: %d %v", status, body)
	}
	resp, _ := http.Get(e.backend.URL + "/ws?token=" + ps[0].token)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token still valid after stop: %d", resp.StatusCode)
	}
}

func TestLeaveDeletesEmptyRoom(t *testing.T) {
	e := newEnv(t)
	code, ps := setupRoom(t, e, 2)
	ps[0].send(map[string]any{"type": "start_game"})
	ps[0].expectError(game.CodeNotEnoughPlayers)

	ps[0].send(map[string]any{"type": "leave_room"})
	ps[0].expectClosed("left")
	if st := ps[1].expectState(); len(st.Players) != 1 || st.Players[0].PlayerID != ps[1].id {
		t.Fatalf("leaver still in room: %+v", st.Players)
	}
	ps[1].send(map[string]any{"type": "leave_room"})
	ps[1].expectClosed("left")
	if status, _ := e.post("/rooms/"+code+"/join", map[string]string{"nickname": "x"}); status != http.StatusNotFound {
		t.Fatalf("empty room not deleted: %d", status)
	}
}

func TestKeepAlivePings(t *testing.T) {
	old := pingInterval
	pingInterval = 30 * time.Millisecond
	t.Cleanup(func() { pingInterval = old })

	e := newEnv(t)
	_, ps := setupRoom(t, e, 1)
	// Several ping intervals go by while the client only reads (pongs are
	// answered by the library's read loop); the connection must survive.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		data []byte
		err  error
	}
	got := make(chan result, 1)
	go func() {
		_, data, err := ps[0].conn.Read(ctx)
		got <- result{data, err}
	}()
	time.Sleep(200 * time.Millisecond)
	ps[0].send(map[string]any{"type": "start_game"})
	r := <-got
	if r.err != nil {
		t.Fatalf("connection did not stay open: %v", r.err)
	}
	var msg struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(r.data, &msg); err != nil || msg.Type != "error" || msg.Code != game.CodeNotEnoughPlayers {
		t.Fatalf("unexpected message after idle period: %s (%v)", r.data, err)
	}
}

func TestProductionOriginAllowed(t *testing.T) {
	const prod = "https://dixvoice-web.api.gcast.app"
	mock := httptest.NewServer((&mockaudio.Service{Count: 30}).Handler())
	t.Cleanup(mock.Close)
	srv := New(Config{AllowedOrigins: []string{prod, origin}}, game.NewManager(), audio.NewClient(mock.URL),
		nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	backend := httptest.NewServer(srv.Handler())
	t.Cleanup(backend.Close)

	req, _ := http.NewRequest(http.MethodPost, backend.URL+"/rooms", strings.NewReader(`{"nickname":"Ana"}`))
	req.Header.Set("Origin", prod)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated || resp.Header.Get("Access-Control-Allow-Origin") != prod {
		t.Fatalf("cors for prod origin: %d %v", resp.StatusCode, resp.Header)
	}
	var body map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&body)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(backend.URL, "http://", "ws://", 1) + "/ws?token=" + body["token"]
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {prod}}})
	if err != nil {
		t.Fatalf("ws from prod origin rejected: %v", err)
	}
	_ = conn.CloseNow()
}

func TestWebSocketOriginCheck(t *testing.T) {
	e := newEnv(t)
	_, body := e.post("/rooms", map[string]string{"nickname": "Ana"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(e.backend.URL, "http://", "ws://", 1) + "/ws?token=" + body["token"].(string)
	_, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://evil.example"}}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a foreign origin, got %v %v", err, resp)
	}

	// No Origin header (non-browser client such as the companion service):
	// accepted, on HTTP and on the WebSocket.
	code := body["roomCode"].(string)
	status, seat := e.postFrom("", "/rooms/"+code+"/join", map[string]any{"nickname": "Robo Ada", "companion": true})
	if status != http.StatusOK {
		t.Fatalf("join without Origin: %d %v", status, seat)
	}
	bot := e.connectFrom("", seat["playerId"].(string), seat["token"].(string))
	if len(bot.state.Players) != 2 {
		t.Fatalf("bad state without Origin: %+v", bot.state.Players)
	}
}

// fakeCompanionService stands in for the companion service: on
// POST /companions it joins the room over the backend's HTTP API with
// "companion": true and opens the WebSocket without an Origin header, like
// the real service.
type fakeCompanionService struct {
	t      *testing.T
	e      *env
	fail   bool
	calls  int
	bodies []string
	joined chan *player
}

func (f *fakeCompanionService) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/companions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.calls++
		var body struct {
			RoomCode string `json:"roomCode"`
		}
		data, _ := io.ReadAll(r.Body)
		f.bodies = append(f.bodies, string(bytes.TrimSpace(data)))
		_ = json.Unmarshal(data, &body)
		if f.fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		go func() {
			status, seat := f.e.postFrom("", "/rooms/"+body.RoomCode+"/join", map[string]any{"nickname": "Robo Ada", "companion": true})
			if status != http.StatusOK {
				f.t.Errorf("companion join: %d %v", status, seat)
				f.joined <- nil
				return
			}
			f.joined <- f.e.connectFrom("", seat["playerId"].(string), seat["token"].(string))
		}()
	})
}

func TestCompanions(t *testing.T) {
	fake := &fakeCompanionService{t: t, joined: make(chan *player, 1)}
	fakeSrv := httptest.NewServer(fake.handler())
	t.Cleanup(fakeSrv.Close)
	e := newEnvWithCompanions(t, fakeSrv.URL)
	fake.e = e
	code, ps := setupRoom(t, e, 3)

	// add_companion: the service is called with the room code, the
	// companion joins (state to everyone: join, then connect) with
	// isCompanion: true.
	ps[0].send(map[string]any{"type": "add_companion"})
	bot := <-fake.joined
	if bot == nil {
		t.FailNow()
	}
	if fake.calls != 1 || fake.bodies[0] != `{"roomCode":"`+code+`"}` {
		t.Fatalf("companion service calls %d bodies %v", fake.calls, fake.bodies)
	}
	all(ps, func(p *player) { p.expectState(); p.expectState() })
	for _, s := range ps[0].state.Players {
		if s.IsCompanion != (s.PlayerID == bot.id) || (s.PlayerID == bot.id && (s.Nickname != "Robo Ada" || !s.Connected)) {
			t.Fatalf("bad players after add_companion: %+v", ps[0].state.Players)
		}
	}
	if len(ps[0].state.Players) != 4 {
		t.Fatalf("expected 4 players, got %d", len(ps[0].state.Players))
	}

	// remove_companion: wrong target, then success. The companion's socket
	// gets room_closed (removed) and everyone else a state.
	ps[1].send(map[string]any{"type": "remove_companion", "playerId": ps[0].id})
	ps[1].expectError(game.CodeNotACompanion)
	ps[1].send(map[string]any{"type": "remove_companion", "playerId": "p99"})
	ps[1].expectError(game.CodePlayerNotFound)
	ps[1].send(map[string]any{"type": "remove_companion", "playerId": bot.id})
	bot.expectClosed("removed")
	all(ps, func(p *player) { p.expectState() })
	if len(ps[2].state.Players) != 3 {
		t.Fatalf("companion still in room: %+v", ps[2].state.Players)
	}
	if resp, _ := http.Get(e.backend.URL + "/ws?token=" + bot.token); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("removed companion token still valid: %d", resp.StatusCode)
	}

	// Companions count toward the 4 player minimum: with one back, the
	// game starts, and neither message is allowed while playing.
	ps[0].send(map[string]any{"type": "add_companion"})
	bot = <-fake.joined
	all(ps, func(p *player) { p.expectState(); p.expectState() })
	ps[0].send(map[string]any{"type": "start_game"})
	all(append(ps, bot), func(p *player) { p.expectState() })
	if ps[0].state.Room.Status != game.StatusPlaying || len(bot.state.You.Hand) != game.HandSize {
		t.Fatalf("game did not start with a companion: %+v", ps[0].state.Room)
	}
	ps[0].send(map[string]any{"type": "add_companion"})
	ps[0].expectError(game.CodeInvalidPhase)
	ps[0].send(map[string]any{"type": "remove_companion", "playerId": bot.id})
	ps[0].expectError(game.CodeInvalidPhase)
	if fake.calls != 2 {
		t.Fatalf("service called while playing: %d", fake.calls)
	}

	// Service failure -> companion_unavailable, nothing else happens.
	ps[0].send(map[string]any{"type": "stop_game"})
	all(append(ps, bot), func(p *player) { p.expectClosed("stopped") })
	_, ps = setupRoom(t, e, 1)
	fake.fail = true
	ps[0].send(map[string]any{"type": "add_companion"})
	ps[0].expectError(game.CodeCompanionUnavailable)
	if fake.calls != 3 {
		t.Fatalf("service not called: %d", fake.calls)
	}
	fake.fail = false

	// Room full -> room_full, the service is not called.
	code, ps = setupRoom(t, e, 8)
	ps[0].send(map[string]any{"type": "add_companion"})
	ps[0].expectError(game.CodeRoomFull)
	if fake.calls != 3 {
		t.Fatalf("service called for a full room: %d", fake.calls)
	}
	_ = code
}

func TestAddCompanionWithoutService(t *testing.T) {
	e := newEnv(t) // COMPANION_SERVICE_URL unset
	_, ps := setupRoom(t, e, 1)
	ps[0].send(map[string]any{"type": "add_companion"})
	ps[0].expectError(game.CodeCompanionUnavailable)
}

func TestAnyOriginAllowed(t *testing.T) {
	const site = "https://html-classic.itch.zone"
	mock := httptest.NewServer((&mockaudio.Service{Count: 30}).Handler())
	t.Cleanup(mock.Close)
	srv := New(Config{AllowedOrigins: []string{"*"}}, game.NewManager(), audio.NewClient(mock.URL),
		nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	backend := httptest.NewServer(srv.Handler())
	t.Cleanup(backend.Close)

	req, _ := http.NewRequest(http.MethodPost, backend.URL+"/rooms", strings.NewReader(`{"nickname":"Ana"}`))
	req.Header.Set("Origin", site)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated || resp.Header.Get("Access-Control-Allow-Origin") != site {
		t.Fatalf("cors for any origin: %d %v", resp.StatusCode, resp.Header)
	}
	var body map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&body)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(backend.URL, "http://", "ws://", 1) + "/ws?token=" + body["token"]
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {site}}})
	if err != nil {
		t.Fatalf("ws from any origin rejected: %v", err)
	}
	_ = conn.CloseNow()
}

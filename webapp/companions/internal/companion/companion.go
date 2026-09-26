// Package companion implements one AI player: it joins a room through the
// backend's HTTP API, follows the game over its WebSocket and plays each
// phase with a Brain, falling back to random valid moves.
package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

// Brain decides moves from clip text and emotion only. Every method must
// return a clipId among the clips it was given; the companion validates the
// answer and falls back to a random valid move otherwise.
type Brain interface {
	ChooseClue(ctx context.Context, hand []protocol.Clip) (clipID, clue string, err error)
	ChooseSubmission(ctx context.Context, clue string, hand []protocol.Clip) (clipID string, err error)
	ChooseVote(ctx context.Context, clue string, table []protocol.Clip) (clipID string, err error)
}

// Config configures a companion. Zero values take the defaults below.
type Config struct {
	// BackendURL is the backend's base URL (http or https).
	BackendURL string
	// Nickname to join with; random when empty.
	Nickname string
	Brain    Brain
	// Delay returns the pause before each move (RandomDelay when nil).
	Delay func() time.Duration
	// DecisionTimeout bounds each Brain call (10 s when zero).
	DecisionTimeout time.Duration
	// MaxReconnects is the number of consecutive failed reconnects before the
	// companion gives up (20 when zero).
	MaxReconnects int
	// MaxBackoff caps the reconnect backoff (10 s when zero).
	MaxBackoff time.Duration
	HTTP       *http.Client
	Log        *slog.Logger
}

func (c Config) withDefaults() Config {
	if c.Nickname == "" {
		c.Nickname = RandomNickname()
	}
	if c.Delay == nil {
		c.Delay = RandomDelay
	}
	if c.DecisionTimeout == 0 {
		c.DecisionTimeout = 10 * time.Second
	}
	if c.MaxReconnects == 0 {
		c.MaxReconnects = 20
	}
	if c.MaxBackoff == 0 {
		c.MaxBackoff = 10 * time.Second
	}
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	if c.Log == nil {
		c.Log = slog.New(slog.DiscardHandler)
	}
	c.BackendURL = strings.TrimRight(c.BackendURL, "/")
	return c
}

// JoinError is returned by Join when the backend refuses the join.
type JoinError struct {
	Status  int
	Code    string
	Message string
}

func (e *JoinError) Error() string {
	return fmt.Sprintf("join refused: %d %s: %s", e.Status, e.Code, e.Message)
}

// ErrTokenRejected is returned by Run when the backend no longer knows the
// companion's token (the room is gone), so reconnecting is pointless.
var ErrTokenRejected = errors.New("session token rejected by backend")

// Companion is one seat in one room.
type Companion struct {
	cfg      Config
	log      *slog.Logger
	roomCode string
	playerID string
	token    string
	wsURL    string

	mu        sync.Mutex
	conn      *websocket.Conn
	acted     string // "round:phase" key of the move already made or scheduled
	retryKey  string // "round:phase" key the retries count for
	retries   int    // moves rejected by the backend for retryKey
	pending   context.CancelFunc
	lastState *protocol.State
}

// Join takes a seat in the room as an AI companion. The companion is not
// connected yet: call Run.
func Join(ctx context.Context, cfg Config, roomCode string) (*Companion, error) {
	cfg = cfg.withDefaults()
	if cfg.Brain == nil {
		return nil, errors.New("companion: Brain is required")
	}
	body, _ := json.Marshal(protocol.JoinRequest{Nickname: cfg.Nickname, Companion: true})
	joinURL := fmt.Sprintf("%s/rooms/%s/join", cfg.BackendURL, url.PathEscape(roomCode))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := cfg.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("join: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("join: %w", err)
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var e protocol.ErrorBody
		_ = json.Unmarshal(raw, &e)
		return nil, &JoinError{Status: resp.StatusCode, Code: e.Code, Message: e.Message}
	}
	var joined protocol.JoinResponse
	if err := json.Unmarshal(raw, &joined); err != nil || joined.Token == "" || joined.PlayerID == "" {
		return nil, fmt.Errorf("join: unexpected response %q", truncate(string(raw), 200))
	}
	wsURL, err := websocketURL(cfg.BackendURL, joined.Token)
	if err != nil {
		return nil, err
	}
	c := &Companion{
		cfg:      cfg,
		roomCode: roomCode,
		playerID: joined.PlayerID,
		token:    joined.Token,
		wsURL:    wsURL,
	}
	c.log = cfg.Log.With("roomCode", roomCode, "playerId", joined.PlayerID, "nickname", cfg.Nickname)
	c.log.Info("companion joined")
	return c, nil
}

// PlayerID is the id the backend gave this companion.
func (c *Companion) PlayerID() string { return c.playerID }

// Nickname is the companion's nickname.
func (c *Companion) Nickname() string { return c.cfg.Nickname }

// RoomCode is the room the companion sits in.
func (c *Companion) RoomCode() string { return c.roomCode }

func websocketURL(backendURL, token string) (string, error) {
	u, err := url.Parse(backendURL)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid BACKEND_URL %q", backendURL)
	}
	switch u.Scheme {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("invalid BACKEND_URL scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws"
	u.RawQuery = url.Values{"token": {token}}.Encode()
	return u.String(), nil
}

// Run connects to the room and plays until the room is closed (returns nil),
// ctx is cancelled (returns ctx.Err()) or the connection cannot be
// re-established.
func (c *Companion) Run(ctx context.Context) error {
	defer c.cancelPending()
	backoff := 500 * time.Millisecond
	failures := 0
	for {
		conn, err := c.dial(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, ErrTokenRejected) {
				c.log.Info("companion stopped: token rejected")
				return err
			}
			failures++
			if failures > c.cfg.MaxReconnects {
				c.log.Error("companion giving up", "err", err, "failures", failures)
				return fmt.Errorf("reconnect: %w", err)
			}
			c.log.Warn("connect failed, retrying", "err", err, "backoff", backoff.String())
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return ctx.Err()
			}
			backoff = min(backoff*2, c.cfg.MaxBackoff)
			continue
		}
		failures = 0
		backoff = 500 * time.Millisecond
		c.log.Info("companion connected")
		c.setConn(conn)
		closed, err := c.readLoop(ctx, conn)
		c.cancelPending()
		c.setConn(nil)
		_ = conn.CloseNow()
		switch {
		case closed:
			c.log.Info("companion stopped: room closed")
			return nil
		case ctx.Err() != nil:
			return ctx.Err()
		default:
			c.log.Warn("socket dropped, reconnecting", "err", err)
		}
	}
}

func (c *Companion) dial(ctx context.Context) (*websocket.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(dctx, c.wsURL, &websocket.DialOptions{HTTPClient: c.cfg.HTTP})
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusNotFound) {
			return nil, fmt.Errorf("%w (status %d)", ErrTokenRejected, resp.StatusCode)
		}
		return nil, err
	}
	conn.SetReadLimit(4 << 20)
	return conn, nil
}

func (c *Companion) setConn(conn *websocket.Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn = conn
	c.acted = ""
}

// readLoop handles messages until the socket fails (closed=false) or the
// server sends room_closed (closed=true).
func (c *Companion) readLoop(ctx context.Context, conn *websocket.Conn) (closed bool, err error) {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return false, err
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			c.log.Warn("bad message from backend", "err", err)
			continue
		}
		switch env.Type {
		case "state":
			var st protocol.State
			if err := json.Unmarshal(data, &st); err != nil {
				c.log.Warn("bad state from backend", "err", err)
				continue
			}
			c.handleState(ctx, &st)
		case "room_closed":
			c.log.Info("room closed", "reason", env.Reason)
			return true, nil
		case "error":
			c.log.Warn("move rejected", "code", env.Code, "message", env.Message)
			c.retryLastState(ctx)
		default:
			c.log.Debug("ignoring message", "type", env.Type)
		}
	}
}

type moveKind int

const (
	noMove moveKind = iota
	moveClue
	moveSubmit
	moveVote
)

// plan tells which move, if any, the snapshot asks of this companion.
func plan(st *protocol.State) moveKind {
	r := st.Round
	if r == nil || st.Room.Status != "playing" {
		return noMove
	}
	storyteller := r.StorytellerID == st.You.PlayerID
	switch r.Phase {
	case protocol.PhaseStoryteller:
		if storyteller && r.Clue == nil && len(st.You.Hand) > 0 {
			return moveClue
		}
	case protocol.PhaseSubmit:
		if !storyteller && r.YourSubmission == nil && len(st.You.Hand) > 0 {
			return moveSubmit
		}
	case protocol.PhaseVote:
		if !storyteller && r.YourVote == nil && len(voteChoices(st)) > 0 {
			return moveVote
		}
	}
	return noMove
}

func voteChoices(st *protocol.State) []protocol.Clip {
	own := ""
	if st.Round.YourSubmission != nil {
		own = *st.Round.YourSubmission
	}
	choices := make([]protocol.Clip, 0, len(st.Round.Table))
	for _, clip := range st.Round.Table {
		if clip.ClipID != own {
			choices = append(choices, clip)
		}
	}
	return choices
}

func (c *Companion) handleState(ctx context.Context, st *protocol.State) {
	kind := plan(st)
	c.mu.Lock()
	c.lastState = st
	if kind == noMove {
		// The round moved on (or the game ended): drop any move scheduled for
		// a phase that is over.
		if st.Round == nil || c.acted != roundKey(st) {
			c.cancelPendingLocked()
		}
		c.mu.Unlock()
		return
	}
	key := roundKey(st)
	if c.acted == key {
		c.mu.Unlock()
		return
	}
	c.acted = key
	c.cancelPendingLocked()
	actx, cancel := context.WithCancel(ctx)
	c.pending = cancel
	c.mu.Unlock()
	go c.act(actx, st, kind)
}

// retryLastState re-plans the current phase after the backend rejected a
// move, a few times at most.
func (c *Companion) retryLastState(ctx context.Context) {
	c.mu.Lock()
	st := c.lastState
	if st == nil || st.Round == nil {
		c.mu.Unlock()
		return
	}
	if key := roundKey(st); key != c.retryKey {
		c.retryKey, c.retries = key, 0
	}
	if c.retries >= 3 {
		c.mu.Unlock()
		return
	}
	c.retries++
	c.acted = ""
	c.mu.Unlock()
	c.handleState(ctx, st)
}

func roundKey(st *protocol.State) string {
	return fmt.Sprintf("%d:%s", st.Round.Number, st.Round.Phase)
}

func (c *Companion) cancelPending() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancelPendingLocked()
}

func (c *Companion) cancelPendingLocked() {
	if c.pending != nil {
		c.pending()
		c.pending = nil
	}
}

// act waits the natural delay, asks the Brain and sends the move.
func (c *Companion) act(ctx context.Context, st *protocol.State, kind moveKind) {
	select {
	case <-time.After(c.cfg.Delay()):
	case <-ctx.Done():
		return
	}
	dctx, cancel := context.WithTimeout(ctx, c.cfg.DecisionTimeout)
	action := c.decide(dctx, st, kind)
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err := c.send(ctx, action); err != nil {
		c.log.Warn("send failed", "type", action.Type, "err", err)
		return
	}
	c.log.Info("move sent", "round", st.Round.Number, "phase", st.Round.Phase, "type", action.Type, "clipId", action.ClipID, "clue", action.Clue)
}

func (c *Companion) decide(ctx context.Context, st *protocol.State, kind moveKind) protocol.Action {
	clue := ""
	if st.Round.Clue != nil {
		clue = *st.Round.Clue
	}
	switch kind {
	case moveClue:
		id, text, err := c.cfg.Brain.ChooseClue(ctx, st.You.Hand)
		if err != nil || !hasClip(st.You.Hand, id) || strings.TrimSpace(text) == "" {
			c.fallback("submit_clue", err)
			id, text = randomClip(st.You.Hand), randomClue()
		}
		return protocol.Action{Type: "submit_clue", ClipID: id, Clue: text}
	case moveSubmit:
		id, err := c.cfg.Brain.ChooseSubmission(ctx, clue, st.You.Hand)
		if err != nil || !hasClip(st.You.Hand, id) {
			c.fallback("submit_clip", err)
			id = randomClip(st.You.Hand)
		}
		return protocol.Action{Type: "submit_clip", ClipID: id}
	default:
		choices := voteChoices(st)
		id, err := c.cfg.Brain.ChooseVote(ctx, clue, choices)
		if err != nil || !hasClip(choices, id) {
			c.fallback("vote", err)
			id = randomClip(choices)
		}
		return protocol.Action{Type: "vote", ClipID: id}
	}
}

func (c *Companion) fallback(move string, err error) {
	if err == nil {
		err = errors.New("answer is not a valid choice")
	}
	c.log.Warn("brain failed, playing a random valid move", "type", move, "err", err)
}

func (c *Companion) send(ctx context.Context, action protocol.Action) error {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	data, err := json.Marshal(action)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, data)
}

func hasClip(clips []protocol.Clip, id string) bool {
	for _, c := range clips {
		if c.ClipID == id {
			return true
		}
	}
	return false
}

func randomClip(clips []protocol.Clip) string {
	return clips[rand.IntN(len(clips))].ClipID
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

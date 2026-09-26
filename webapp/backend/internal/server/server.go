// Package server exposes the HTTP and WebSocket protocol of README > Protocol.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/jtestard/dixvoice/webapp/backend/internal/audio"
	"github.com/jtestard/dixvoice/webapp/backend/internal/companion"
	"github.com/jtestard/dixvoice/webapp/backend/internal/game"
)

type Config struct {
	// AllowedOrigins are the browser origins accepted for CORS and WebSocket
	// upgrades, e.g. "http://localhost:5173". Requests without an Origin
	// header (non-browser clients) are always accepted.
	AllowedOrigins []string
}

type Server struct {
	cfg        Config
	log        *slog.Logger
	rooms      *game.Manager
	audio      *audio.Client
	companions *companion.Client
	origins    map[string]bool
	hosts      []string

	mu    sync.Mutex
	conns map[*game.Room]map[string]*client // room -> playerID -> connection
}

func New(cfg Config, rooms *game.Manager, audioClient *audio.Client, companions *companion.Client, log *slog.Logger) *Server {
	if companions == nil {
		companions = companion.NewClient("")
	}
	s := &Server{
		cfg:        cfg,
		log:        log,
		rooms:      rooms,
		audio:      audioClient,
		companions: companions,
		origins:    map[string]bool{},
		conns:      map[*game.Room]map[string]*client{},
	}
	for _, o := range cfg.AllowedOrigins {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		if o == "" {
			continue
		}
		s.origins[o] = true
		if u, err := url.Parse(o); err == nil && u.Host != "" {
			s.hosts = append(s.hosts, u.Host)
		}
	}
	return s
}

// Handler returns the full HTTP handler, CORS included.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /rooms", s.handleCreateRoom)
	mux.HandleFunc("POST /rooms/{code}/join", s.handleJoinRoom)
	mux.HandleFunc("GET /audio/list", s.handleAudioList)
	mux.HandleFunc("GET /audio/{id}", s.handleAudioGet)
	mux.HandleFunc("GET /ws", s.handleWS)
	return s.cors(mux)
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && s.origins[origin] {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			h.Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpStatus(code string) int {
	switch code {
	case game.CodeRoomNotFound:
		return http.StatusNotFound
	case game.CodeRoomFull, game.CodeGameStarted:
		return http.StatusConflict
	case game.CodeInvalidNickname:
		return http.StatusBadRequest
	}
	return http.StatusBadRequest
}

func writeGameError(w http.ResponseWriter, err error) {
	var ge *game.Error
	if errors.As(err, &ge) {
		writeJSON(w, httpStatus(ge.Code), errorBody{Code: ge.Code, Message: ge.Message})
		return
	}
	writeJSON(w, http.StatusInternalServerError, errorBody{Code: "internal", Message: err.Error()})
}

type joinBody struct {
	Nickname  string `json:"nickname"`
	Companion bool   `json:"companion"`
}

type seatResponse struct {
	RoomCode string `json:"roomCode"`
	PlayerID string `json:"playerId"`
	Token    string `json:"token"`
}

func readJoinBody(w http.ResponseWriter, r *http.Request) (joinBody, bool) {
	var body joinBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Code: game.CodeInvalidNickname, Message: "body must be {\"nickname\": ...}"})
		return body, false
	}
	return body, true
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	body, ok := readJoinBody(w, r)
	if !ok {
		return
	}
	room, p, err := s.rooms.CreateRoom(body.Nickname)
	if err != nil {
		writeGameError(w, err)
		return
	}
	s.log.Info("room created", "code", room.Code)
	writeJSON(w, http.StatusCreated, seatResponse{RoomCode: room.Code, PlayerID: p.ID, Token: p.Token})
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	body, ok := readJoinBody(w, r)
	if !ok {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	room, p, err := s.rooms.JoinRoom(code, body.Nickname, body.Companion)
	if err != nil {
		writeGameError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, seatResponse{RoomCode: room.Code, PlayerID: p.ID, Token: p.Token})
	s.broadcast(room)
}

func (s *Server) handleAudioList(w http.ResponseWriter, r *http.Request) {
	list, err := s.audio.List(r.Context())
	if err != nil {
		s.log.Error("audio list", "err", err)
		writeJSON(w, http.StatusBadGateway, errorBody{Code: "audio_unavailable", Message: "the audio service is unavailable"})
		return
	}
	if list == nil {
		list = []audio.Response{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAudioGet(w http.ResponseWriter, r *http.Request) {
	a, err := s.audio.Get(r.Context(), r.PathValue("id"))
	switch {
	case errors.Is(err, audio.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorBody{Code: "not_found", Message: "unknown audio id"})
	case err != nil:
		s.log.Error("audio get", "err", err)
		writeJSON(w, http.StatusBadGateway, errorBody{Code: "audio_unavailable", Message: "the audio service is unavailable"})
	default:
		writeJSON(w, http.StatusOK, a)
	}
}

// pool fetches the audio list as clips for dealing.
func (s *Server) pool(ctx context.Context) ([]game.Clip, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	list, err := s.audio.List(ctx)
	if err != nil {
		return nil, err
	}
	clips := make([]game.Clip, len(list))
	for i, a := range list {
		clips[i] = game.Clip{ID: a.ID, URL: a.ClipURL, Text: a.Text, Emotion: a.Emotion, VoiceID: a.VoiceID}
	}
	return clips, nil
}

// ---- WebSocket ----

type client struct {
	conn *websocket.Conn
	wmu  sync.Mutex
}

func (c *client) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

type clientMessage struct {
	Type     string `json:"type"`
	ClipID   string `json:"clipId"`
	Clue     string `json:"clue"`
	PlayerID string `json:"playerId"`
}

type wsError struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type roomClosed struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	seat, ok := s.rooms.Lookup(r.URL.Query().Get("token"))
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errorBody{Code: "invalid_token", Message: "unknown session token"})
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.hosts})
	if err != nil {
		s.log.Info("websocket accept failed", "err", err)
		return
	}
	c := &client{conn: conn}
	s.attach(seat, c)
	defer s.detach(seat, c)

	seat.Room.SetConnected(seat.PlayerID, true)
	s.broadcast(seat.Room)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.keepAlive(ctx, conn)

	ejected := false
	for {
		// Read runs until the socket closes; after an eject it only serves
		// the close handshake started by eject.
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if ejected {
			continue
		}
		var msg clientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			_ = c.send(wsError{Type: "error", Code: "invalid_message", Message: "messages must be JSON objects with a type"})
			continue
		}
		ejected = s.handleMessage(ctx, seat, c, msg)
	}
}

// pingInterval is how often idle WebSocket connections are pinged so that
// proxies in front of the server keep them open.
var pingInterval = 20 * time.Second

// keepAlive pings the connection until ctx is done; a failed ping (no pong
// within the interval) closes the connection so the read loop notices.
func (s *Server) keepAlive(ctx context.Context, conn *websocket.Conn) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pingCtx, cancel := context.WithTimeout(ctx, pingInterval)
		err := conn.Ping(pingCtx)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				s.log.Debug("ping failed, closing connection", "err", err)
				_ = conn.CloseNow()
			}
			return
		}
	}
}

// attach registers the connection as the player's, replacing (and closing)
// a previous one on reconnect.
func (s *Server) attach(seat game.Seat, c *client) {
	s.mu.Lock()
	room := s.conns[seat.Room]
	if room == nil {
		room = map[string]*client{}
		s.conns[seat.Room] = room
	}
	old := room[seat.PlayerID]
	room[seat.PlayerID] = c
	s.mu.Unlock()
	if old != nil {
		go func() { _ = old.conn.Close(websocket.StatusPolicyViolation, "reconnected elsewhere") }()
	}
}

func (s *Server) detach(seat game.Seat, c *client) {
	s.mu.Lock()
	room := s.conns[seat.Room]
	current := room[seat.PlayerID] == c
	if current {
		delete(room, seat.PlayerID)
		if len(room) == 0 {
			delete(s.conns, seat.Room)
		}
	}
	s.mu.Unlock()
	_ = c.conn.CloseNow()
	if current {
		seat.Room.SetConnected(seat.PlayerID, false)
		s.broadcast(seat.Room)
	}
}

func (s *Server) clients(room *game.Room) map[string]*client {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]*client, len(s.conns[room]))
	for id, c := range s.conns[room] {
		out[id] = c
	}
	return out
}

// broadcast sends every connected player of the room their own snapshot.
func (s *Server) broadcast(room *game.Room) {
	for id, c := range s.clients(room) {
		if err := c.send(room.Snapshot(id)); err != nil {
			s.log.Debug("send state failed", "player", id, "err", err)
		}
	}
}

// closeRoom deletes the room and ejects everyone with a room_closed message.
func (s *Server) closeRoom(room *game.Room, reason string) {
	s.rooms.Delete(room.Code)
	s.mu.Lock()
	clients := s.conns[room]
	delete(s.conns, room)
	s.mu.Unlock()
	for _, c := range clients {
		c.eject(reason)
	}
	s.log.Info("room closed", "code", room.Code, "reason", reason)
}

// eject tells the client the room is gone and starts the close handshake.
// The handshake runs in its own goroutine because, when the client is the
// one whose message triggered it, its read loop must keep running to
// receive the peer's close frame.
func (c *client) eject(reason string) {
	_ = c.send(roomClosed{Type: "room_closed", Reason: reason})
	go func() { _ = c.conn.Close(websocket.StatusNormalClosure, reason) }()
}

// handleMessage applies one client message. It returns true when the
// connection has been closed as a result.
func (s *Server) handleMessage(ctx context.Context, seat game.Seat, c *client, msg clientMessage) bool {
	room, pid := seat.Room, seat.PlayerID
	var err error
	switch msg.Type {
	case "start_game":
		var pool []game.Clip
		pool, err = s.pool(ctx)
		if err == nil {
			err = room.Start(pool)
		}
	case "stop_game":
		s.closeRoom(room, "stopped")
		return true
	case "leave_room":
		var deleted bool
		deleted, err = s.rooms.Leave(seat)
		if err == nil {
			s.mu.Lock()
			if s.conns[room] != nil {
				delete(s.conns[room], pid)
			}
			s.mu.Unlock()
			c.eject("left")
			if deleted {
				s.log.Info("room deleted (empty)", "code", room.Code)
			} else {
				s.broadcast(room)
			}
			return true
		}
	case "add_companion":
		err = s.addCompanion(ctx, room)
		if err == nil {
			// The companion joins over HTTP on its own; that join broadcasts.
			return false
		}
	case "remove_companion":
		err = s.rooms.RemoveCompanion(room, msg.PlayerID)
		if err == nil {
			s.mu.Lock()
			removed := s.conns[room][msg.PlayerID]
			delete(s.conns[room], msg.PlayerID)
			s.mu.Unlock()
			if removed != nil {
				removed.eject("removed")
			}
			s.log.Info("companion removed", "code", room.Code, "player", msg.PlayerID)
		}
	case "submit_clue":
		err = room.SubmitClue(pid, msg.ClipID, msg.Clue)
	case "submit_clip":
		err = room.SubmitClip(pid, msg.ClipID)
	case "vote":
		err = room.Vote(pid, msg.ClipID)
	case "next_round":
		var pool []game.Clip
		var needsPool bool
		needsPool, err = room.NeedsNextRoundPool()
		if err == nil && needsPool {
			pool, err = s.pool(ctx)
		}
		if err == nil {
			err = room.NextRound(pool)
		}
	default:
		err = &game.Error{Code: "invalid_message", Message: "unknown message type " + msg.Type}
	}
	if err != nil {
		var ge *game.Error
		if errors.As(err, &ge) {
			_ = c.send(wsError{Type: "error", Code: ge.Code, Message: ge.Message})
		} else {
			s.log.Error("action failed", "type", msg.Type, "err", err)
			_ = c.send(wsError{Type: "error", Code: "audio_unavailable", Message: "the audio service is unavailable"})
		}
		return false
	}
	s.broadcast(room)
	return false
}

// addCompanion asks the companion service to seat one companion in the room.
// The seat is not reserved: the service's own join is subject to the usual
// room checks.
func (s *Server) addCompanion(ctx context.Context, room *game.Room) error {
	if err := room.CanAddCompanion(); err != nil {
		return err
	}
	if err := s.companions.Add(ctx, room.Code); err != nil {
		s.log.Warn("add companion failed", "code", room.Code, "err", err)
		return &game.Error{Code: game.CodeCompanionUnavailable, Message: "AI companions are unavailable right now"}
	}
	return nil
}

// Package server exposes the companion service's HTTP API (POST /companions,
// GET /healthz) and keeps track of the running companions.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sync"

	"github.com/jtestard/dixvoice/webapp/companions/internal/companion"
)

var roomCodeRe = regexp.MustCompile(`^[A-Za-z0-9]{1,16}$`)

// Server starts companions on request and runs them until their room closes.
type Server struct {
	cfg companion.Config
	log *slog.Logger

	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	running map[*companion.Companion]struct{}
}

// New returns a server that starts companions with cfg (Nickname is ignored:
// each companion picks its own).
func New(cfg companion.Config, log *slog.Logger) *Server {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	cfg.Log = log
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{cfg: cfg, log: log, ctx: ctx, cancel: cancel, running: map[*companion.Companion]struct{}{}}
}

// Handler returns the HTTP API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /companions", s.handleAddCompanion)
	return mux
}

type addCompanionBody struct {
	RoomCode string `json:"roomCode"`
}

func (s *Server) handleAddCompanion(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "cannot read body")
		return
	}
	var body addCompanionBody
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", `body must be {"roomCode": "KXQP"}`)
		return
	}
	if !roomCodeRe.MatchString(body.RoomCode) {
		writeError(w, http.StatusBadRequest, "invalid_room_code", "roomCode must be 1 to 16 letters or digits")
		return
	}
	if s.ctx.Err() != nil {
		writeError(w, http.StatusServiceUnavailable, "shutting_down", "service is shutting down")
		return
	}
	s.Start(body.RoomCode)
	w.WriteHeader(http.StatusAccepted)
}

// Start launches one companion for the room in the background: it joins,
// plays until the room closes and is then forgotten.
func (s *Server) Start(roomCode string) {
	cfg := s.cfg
	cfg.Nickname = companion.RandomNickname()
	s.wg.Go(func() {
		c, err := companion.Join(s.ctx, cfg, roomCode)
		if err != nil {
			s.log.Warn("companion could not join", "roomCode", roomCode, "nickname", cfg.Nickname, "err", err)
			return
		}
		s.track(c, true)
		defer s.track(c, false)
		if err := c.Run(s.ctx); err != nil && !errors.Is(err, context.Canceled) {
			s.log.Warn("companion ended", "roomCode", roomCode, "playerId", c.PlayerID(), "err", err)
		}
	})
}

func (s *Server) track(c *companion.Companion, add bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if add {
		s.running[c] = struct{}{}
	} else {
		delete(s.running, c)
	}
}

// Running returns the number of connected companions.
func (s *Server) Running() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.running)
}

// Shutdown disconnects every companion and waits for them, or for ctx.
func (s *Server) Shutdown(ctx context.Context) error {
	s.cancel()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}

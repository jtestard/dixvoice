// Command companions runs the Dixvoice AI companions service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jtestard/dixvoice/webapp/companions/internal/companion"
	"github.com/jtestard/dixvoice/webapp/companions/internal/gemini"
	"github.com/jtestard/dixvoice/webapp/companions/internal/server"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	port := env("PORT", "8080")
	backendURL := env("BACKEND_URL", "http://localhost:8080")
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		log.Warn("GEMINI_API_KEY is not set: every Gemini call will fail and companions will play random moves")
	}
	brain := gemini.New(env("GEMINI_BASE_URL", gemini.DefaultBaseURL), apiKey, os.Getenv("GEMINI_MODEL"), &http.Client{Timeout: 15 * time.Second})

	srv := server.New(companion.Config{BackendURL: backendURL, Brain: brain}, log)
	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Info("listening", "port", port, "backendUrl", backendURL, "geminiModel", brain.Model())
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

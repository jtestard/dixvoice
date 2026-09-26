// Command server runs the Dixvoice backend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jtestard/dixvoice/webapp/backend/internal/audio"
	"github.com/jtestard/dixvoice/webapp/backend/internal/game"
	"github.com/jtestard/dixvoice/webapp/backend/internal/server"
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
	audioURL := env("AUDIO_SERVICE_URL", "http://localhost:8081")
	origins := strings.Split(env("ALLOWED_ORIGINS", "http://localhost:5173"), ",")

	srv := server.New(server.Config{AllowedOrigins: origins}, game.NewManager(), audio.NewClient(audioURL), log)
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
	}()

	log.Info("listening", "port", port, "audioServiceUrl", audioURL, "allowedOrigins", origins)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

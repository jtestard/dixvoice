// Command mockaudio runs the mock audio generator microservice used for local
// development and tests.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jtestard/dixvoice/webapp/backend/internal/mockaudio"
)

func main() {
	addr := flag.String("addr", envOr("MOCKAUDIO_ADDR", ":8081"), "listen address")
	publicURL := flag.String("public-url", os.Getenv("MOCKAUDIO_PUBLIC_URL"), "URL prefix for clipUrl (default: derived from each request's Host)")
	count := flag.Int("count", 300, "number of fixture sounds")
	flag.Parse()

	svc := &mockaudio.Service{PublicURL: *publicURL, Count: *count}
	log.Printf("mock audio service listening on %s with %d sounds", *addr, *count)
	srv := &http.Server{Addr: *addr, Handler: svc.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

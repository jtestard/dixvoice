package gemini

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

var hand = []protocol.Clip{
	{ClipID: "a1", Text: "Is anyone there?", Emotion: "eerie"},
	{ClipID: "a2", Text: "Happy birthday!", Emotion: "joyful"},
	{ClipID: "a3", Text: "Go away.", Emotion: "angry"},
}

// fakeGemini answers every generateContent call with the JSON text it is
// given, or with an HTTP status when status != 0.
func fakeGemini(t *testing.T, answer string, status int) (*Client, *[]request) {
	t.Helper()
	var seen []request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models/test-model:generateContent" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("x-goog-api-key") != "secret" {
			t.Errorf("missing api key header")
		}
		var req request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("bad request body: %v", err)
		}
		seen = append(seen, req)
		if status != 0 {
			w.WriteHeader(status)
			fmt.Fprint(w, `{"error":{"code":500,"message":"boom"}}`)
			return
		}
		resp := map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": answer}}}}}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, "secret", "test-model", srv.Client()), &seen
}

func TestChooseClue(t *testing.T) {
	c, seen := fakeGemini(t, `{"clipId":"a2","clue":"candles in the dark"}`, 0)
	id, clue, err := c.ChooseClue(context.Background(), hand)
	if err != nil || id != "a2" || clue != "candles in the dark" {
		t.Fatalf("got %q %q %v", id, clue, err)
	}
	req := (*seen)[0]
	if req.GenerationConfig.ResponseMimeType != "application/json" || req.GenerationConfig.ResponseSchema["type"] != "OBJECT" {
		t.Errorf("JSON output not requested: %+v", req.GenerationConfig)
	}
	prompt := req.Contents[0].Parts[0].Text
	for _, want := range []string{"Is anyone there?", "eerie", `"a3"`} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt misses %q", want)
		}
	}
}

func TestChooseSubmissionAndVote(t *testing.T) {
	c, seen := fakeGemini(t, `{"clipId":"a3"}`, 0)
	id, err := c.ChooseSubmission(context.Background(), "a slammed door", hand)
	if err != nil || id != "a3" {
		t.Fatalf("submission: got %q %v", id, err)
	}
	id, err = c.ChooseVote(context.Background(), "a slammed door", hand)
	if err != nil || id != "a3" {
		t.Fatalf("vote: got %q %v", id, err)
	}
	for _, req := range *seen {
		if !strings.Contains(req.Contents[0].Parts[0].Text, "a slammed door") {
			t.Errorf("prompt misses the clue")
		}
	}
}

func TestInvalidAnswers(t *testing.T) {
	cases := map[string]string{
		"unknown clip": `{"clipId":"zzz"}`,
		"not json":     `sure! a3`,
		"empty":        ``,
	}
	for name, answer := range cases {
		c, _ := fakeGemini(t, answer, 0)
		if _, err := c.ChooseSubmission(context.Background(), "clue", hand); !errors.Is(err, ErrInvalidAnswer) {
			t.Errorf("%s: want ErrInvalidAnswer, got %v", name, err)
		}
	}
	c, _ := fakeGemini(t, `{"clipId":"a1","clue":"  "}`, 0)
	if _, _, err := c.ChooseClue(context.Background(), hand); !errors.Is(err, ErrInvalidAnswer) {
		t.Errorf("empty clue: want ErrInvalidAnswer, got %v", err)
	}
}

func TestHTTPError(t *testing.T) {
	c, _ := fakeGemini(t, "", http.StatusInternalServerError)
	if _, err := c.ChooseVote(context.Background(), "clue", hand); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("want status error, got %v", err)
	}
}

func TestTimeout(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(block)
	c := New(srv.URL, "k", "", srv.Client())
	if c.Model() != DefaultModel {
		t.Errorf("default model: %q", c.Model())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := c.ChooseSubmission(ctx, "clue", hand)
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline error, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("timeout not honoured")
	}
}

// Package gemini decides a companion's moves with the Google Gemini API
// (REST generateContent with a JSON response schema).
package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jtestard/dixvoice/webapp/companions/internal/protocol"
)

const (
	DefaultBaseURL = "https://generativelanguage.googleapis.com"
	// DefaultModel is the current stable fast Flash model
	// (https://ai.google.dev/gemini-api/docs/models).
	DefaultModel = "gemini-3.8-flash"
)

// Client calls the Gemini generateContent endpoint. The zero value is not
// usable: use New.
type Client struct {
	baseURL     string
	apiKey      string
	model       string
	http        *http.Client
	log         *slog.Logger
	clueTimeout time.Duration
}

// New returns a client for baseURL (DefaultBaseURL when empty) and model
// (DefaultModel when empty). httpClient may be nil. Timeouts come from the
// context passed to each call.
func New(baseURL, apiKey, model string, httpClient *http.Client) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if model == "" {
		model = DefaultModel
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		baseURL:     strings.TrimRight(baseURL, "/"),
		apiKey:      apiKey,
		model:       model,
		http:        httpClient,
		log:         slog.New(slog.DiscardHandler),
		clueTimeout: DefaultClueTimeout,
	}
}

// WithLogger sets the logger for debug traces (discarded by default).
func (c *Client) WithLogger(log *slog.Logger) *Client {
	if log != nil {
		c.log = log
	}
	return c
}

// WithClueTimeout bounds the storyteller's candidate search
// (DefaultClueTimeout by default) before ChooseClue falls back to one shot.
func (c *Client) WithClueTimeout(d time.Duration) *Client {
	if d > 0 {
		c.clueTimeout = d
	}
	return c
}

// Model returns the model id used for requests.
func (c *Client) Model() string { return c.model }

// ErrInvalidAnswer is returned when Gemini answers with a clip that is not a
// valid choice or with an empty clue.
var ErrInvalidAnswer = errors.New("gemini: invalid answer")

// ChooseClueSingle picks a clip from the hand and writes a clue for it in
// one Gemini call. ChooseClue uses it as a fallback.
func (c *Client) ChooseClueSingle(ctx context.Context, req protocol.ClueRequest) (clipID, clue string, err error) {
	hand := req.Hand
	prompt := `You are playing Dixit with 2-second sound clips instead of cards. You are the storyteller.
Each clip is described by the text that is spoken and its emotion. Pick the clip you can hint at most
creatively and write a short, evocative clue (2 to 8 words) that fits the clip without giving it away:
do not quote or paraphrase the clip's text and do not name its emotion literally. Other players must
find your clip among decoys, but if everybody finds it you score nothing, so stay subtle.

Your hand:
` + describeClips(hand) + `
Answer with JSON: {"clipId": "<id from the hand>", "clue": "<your clue>"}.`
	schema := map[string]any{
		"type":     "OBJECT",
		"required": []string{"clipId", "clue"},
		"properties": map[string]any{
			"clipId": map[string]any{"type": "STRING", "enum": clipIDs(hand)},
			"clue":   map[string]any{"type": "STRING"},
		},
	}
	var out struct {
		ClipID string `json:"clipId"`
		Clue   string `json:"clue"`
	}
	if err := c.generate(ctx, prompt, schema, &out); err != nil {
		return "", "", err
	}
	out.Clue = strings.TrimSpace(out.Clue)
	if !hasClip(hand, out.ClipID) || out.Clue == "" {
		return "", "", fmt.Errorf("%w: clipId=%q clue=%q", ErrInvalidAnswer, out.ClipID, out.Clue)
	}
	return out.ClipID, out.Clue, nil
}

// ChooseSubmission picks the clip from the hand that best matches the clue.
func (c *Client) ChooseSubmission(ctx context.Context, clue string, hand []protocol.Clip) (string, error) {
	prompt := `You are playing Dixit with 2-second sound clips instead of cards. The storyteller gave the clue:
"` + clue + `"
Each clip in your hand is described by the text that is spoken and its emotion. Pick the clip from your
hand that best matches the clue, so that other players might mistake it for the storyteller's clip.

Your hand:
` + describeClips(hand) + `
Answer with JSON: {"clipId": "<id from the hand>"}.`
	return c.chooseClip(ctx, prompt, hand)
}

// ChooseVote picks the clip on the table most likely to be the storyteller's.
// The caller must remove the companion's own submission from table first.
func (c *Client) ChooseVote(ctx context.Context, clue string, table []protocol.Clip) (string, error) {
	prompt := `You are playing Dixit with 2-second sound clips instead of cards. The storyteller gave the clue:
"` + clue + `"
The clips on the table are described by the text that is spoken and its emotion. One of them is the
storyteller's clip, the others were submitted by other players to match the clue. Vote for the clip most
likely to be the storyteller's.

Clips on the table:
` + describeClips(table) + `
Answer with JSON: {"clipId": "<id from the table>"}.`
	return c.chooseClip(ctx, prompt, table)
}

func (c *Client) chooseClip(ctx context.Context, prompt string, choices []protocol.Clip) (string, error) {
	schema := map[string]any{
		"type":     "OBJECT",
		"required": []string{"clipId"},
		"properties": map[string]any{
			"clipId": map[string]any{"type": "STRING", "enum": clipIDs(choices)},
		},
	}
	var out struct {
		ClipID string `json:"clipId"`
	}
	if err := c.generate(ctx, prompt, schema, &out); err != nil {
		return "", err
	}
	if !hasClip(choices, out.ClipID) {
		return "", fmt.Errorf("%w: clipId=%q", ErrInvalidAnswer, out.ClipID)
	}
	return out.ClipID, nil
}

type request struct {
	Contents         []content        `json:"contents"`
	GenerationConfig generationConfig `json:"generationConfig"`
}

type content struct {
	Role  string `json:"role,omitempty"`
	Parts []part `json:"parts"`
}

type part struct {
	Text string `json:"text"`
}

type generationConfig struct {
	ResponseMimeType string         `json:"responseMimeType"`
	ResponseSchema   map[string]any `json:"responseSchema"`
	Temperature      float64        `json:"temperature"`
}

type response struct {
	Candidates []struct {
		Content content `json:"content"`
	} `json:"candidates"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// generate sends prompt and decodes the JSON text of the first candidate
// into out.
func (c *Client) generate(ctx context.Context, prompt string, schema map[string]any, out any) error {
	body, err := json.Marshal(request{
		Contents: []content{{Role: "user", Parts: []part{{Text: prompt}}}},
		GenerationConfig: generationConfig{
			ResponseMimeType: "application/json",
			ResponseSchema:   schema,
			Temperature:      1,
		},
	})
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent", c.baseURL, c.model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", c.apiKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("gemini: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("gemini: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gemini: status %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var r response
	if err := json.Unmarshal(raw, &r); err != nil {
		return fmt.Errorf("gemini: bad response body: %w", err)
	}
	if r.Error != nil {
		return fmt.Errorf("gemini: %d %s", r.Error.Code, r.Error.Message)
	}
	if len(r.Candidates) == 0 || len(r.Candidates[0].Content.Parts) == 0 {
		return errors.New("gemini: no candidates")
	}
	var text strings.Builder
	for _, p := range r.Candidates[0].Content.Parts {
		text.WriteString(p.Text)
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(text.String())), out); err != nil {
		return fmt.Errorf("%w: not JSON: %v", ErrInvalidAnswer, err)
	}
	return nil
}

func describeClips(clips []protocol.Clip) string {
	var b strings.Builder
	for _, c := range clips {
		fmt.Fprintf(&b, "- clipId %q: text %q, emotion %q\n", c.ClipID, c.Text, c.Emotion)
	}
	return b.String()
}

func clipIDs(clips []protocol.Clip) []string {
	ids := make([]string, 0, len(clips))
	for _, c := range clips {
		ids = append(ids, c.ClipID)
	}
	return ids
}

func hasClip(clips []protocol.Clip, id string) bool {
	for _, c := range clips {
		if c.ClipID == id {
			return true
		}
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

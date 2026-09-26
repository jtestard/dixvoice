// Package audio is the client of the audio generator microservice
// (spec/audio-service.openapi.json). The first version only reads.
package audio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Response is an AudioResponse (spec/audio-response.schema.json).
type Response struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Emotion string `json:"emotion"`
	VoiceID string `json:"voiceId"`
	ClipURL string `json:"clipUrl"`
}

var ErrNotFound = errors.New("audio: not found")

type Client struct {
	base string
	http *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		base: strings.TrimRight(baseURL, "/"),
		http: &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("audio service: %w", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case resp.StatusCode/100 != 2:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("audio service: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// List returns every sound the service knows about.
func (c *Client) List(ctx context.Context) ([]Response, error) {
	var out []Response
	if err := c.get(ctx, "/audio/list", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns one sound, or ErrNotFound.
func (c *Client) Get(ctx context.Context, id string) (Response, error) {
	var out Response
	err := c.get(ctx, "/audio/"+url.PathEscape(id), &out)
	return out, err
}

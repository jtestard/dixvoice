// Package audio is the client of the audio generator microservice
// (spec/audio-service.openapi.json).
package audio

import (
	"bytes"
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

// Request is an AudioRequest (spec/audio-request.schema.json).
type Request struct {
	Text    string `json:"text"`
	Emotion string `json:"emotion"`
}

var ErrNotFound = errors.New("audio: not found")

// ServiceError is an error answered by the audio service, whose body is
// {"error": code, "message": ...}.
type ServiceError struct {
	Status  int
	Code    string
	Message string
}

func (e *ServiceError) Error() string {
	return fmt.Sprintf("audio service: %d %s: %s", e.Status, e.Code, e.Message)
}

// CreateTimeout bounds POST /audio: generation takes seconds, and the
// contract asks callers for a timeout of at least 30 seconds.
const CreateTimeout = 35 * time.Second

type Client struct {
	base   string
	http   *http.Client
	create *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		base:   strings.TrimRight(baseURL, "/"),
		http:   &http.Client{Timeout: 15 * time.Second},
		create: &http.Client{Timeout: CreateTimeout},
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

// Create generates a new sound (POST /audio). Errors answered by the service
// are returned as *ServiceError.
func (c *Client) Create(ctx context.Context, req Request) (Response, error) {
	var out Response
	body, err := json.Marshal(req)
	if err != nil {
		return out, err
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/audio", bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := c.create.Do(hreq)
	if err != nil {
		return out, fmt.Errorf("audio service: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		se := &ServiceError{Status: resp.StatusCode}
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&e) == nil {
			se.Code, se.Message = e.Error, e.Message
		}
		return out, se
	}
	err = json.NewDecoder(resp.Body).Decode(&out)
	return out, err
}

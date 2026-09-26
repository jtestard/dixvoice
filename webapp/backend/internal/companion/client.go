// Package companion is the client of the AI companion service (README > AI
// companions): it asks the service to seat one companion in a room.
package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrUnconfigured is returned when no service URL is set.
var ErrUnconfigured = errors.New("companion service: no COMPANION_SERVICE_URL configured")

// Timeout bounds each request: the service only acknowledges the request
// (202) and joins the room on its own.
const Timeout = 5 * time.Second

type Client struct {
	base string
	http *http.Client
}

// NewClient returns a client for baseURL; an empty URL yields a client whose
// every call fails with ErrUnconfigured.
func NewClient(baseURL string) *Client {
	return &Client{
		base: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		http: &http.Client{Timeout: Timeout},
	}
}

// Configured reports whether a service URL is set.
func (c *Client) Configured() bool { return c.base != "" }

type addRequest struct {
	RoomCode string `json:"roomCode"`
}

// Add asks the service to add one companion to the room. Any 2xx answer is a
// success.
func (c *Client) Add(ctx context.Context, roomCode string) error {
	if !c.Configured() {
		return ErrUnconfigured
	}
	body, err := json.Marshal(addRequest{RoomCode: roomCode})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/companions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("companion service: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("companion service: %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

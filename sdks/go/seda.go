// Package seda provides a typed client for Seda's local HTTP and WebSocket API.
package seda

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

	"github.com/gorilla/websocket"
)

const protocolVersion = 1

// Status describes a running Seda service.
type Status struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Ready    bool   `json:"ready"`
}

// ModelIdentity is the exact loaded model, revision, variant, and runtime.
type ModelIdentity struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
	Variant  string `json:"variant"`
	Runtime  string `json:"runtime"`
}

// LanguageCapabilities describes when and how a loaded model accepts language.
type LanguageCapabilities struct {
	Mode         string   `json:"mode"`
	Supported    []string `json:"supported"`
	SupportsAuto bool     `json:"supportsAuto"`
	Fixed        string   `json:"fixed,omitempty"`
}

// Capabilities describes the active model and service features.
type Capabilities struct {
	Runtime             string               `json:"runtime"`
	ResolvedModel       ModelIdentity        `json:"resolvedModel"`
	Language            LanguageCapabilities `json:"language"`
	Streaming           string               `json:"streaming"`
	Punctuation         bool                 `json:"punctuation"`
	WordTimestamps      bool                 `json:"wordTimestamps"`
	GlobalPushToTalk    bool                 `json:"globalPushToTalk"`
	FocusedAppInsertion bool                 `json:"focusedAppInsertion"`
}

// Word is one timestamped recognized word.
type Word struct {
	Text       string   `json:"text"`
	StartMS    uint64   `json:"startMs"`
	EndMS      uint64   `json:"endMs"`
	Confidence *float32 `json:"confidence,omitempty"`
}

// Transcript is a completed transcription.
type Transcript struct {
	Text       string `json:"text"`
	Words      []Word `json:"words"`
	Language   string `json:"language,omitempty"`
	DurationMS uint64 `json:"durationMs"`
}

// TranscriptUpdate is a revisable or final live result.
type TranscriptUpdate struct {
	SegmentID    string `json:"segment_id"`
	Revision     uint64 `json:"revision"`
	Text         string `json:"text"`
	StableText   string `json:"stable_text"`
	UnstableText string `json:"unstable_text"`
	Final        bool   `json:"final"`
	Words        []Word `json:"words"`
}

// Error is a stable Seda protocol failure.
type Error struct {
	Code        string
	Message     string
	Recoverable bool
	StatusCode  int
}

func (e *Error) Error() string { return e.Message }

type socket interface {
	WriteMessage(messageType int, data []byte) error
	ReadMessage() (messageType int, data []byte, err error)
	SetReadDeadline(time.Time) error
	Close() error
}

type socketDialer func(context.Context, string) (socket, error)

// Options configures a client connection.
type Options struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
	dial       socketDialer
}

// Client is safe to reuse across complete and live transcriptions.
type Client struct {
	baseURL    *url.URL
	token      string
	httpClient *http.Client
	dial       socketDialer
}

// Connect verifies the service and returns a reusable client.
func Connect(ctx context.Context, options Options) (*Client, error) {
	if options.Token == "" {
		return nil, errors.New("seda: token is required")
	}
	baseURL, err := url.Parse(options.BaseURL)
	if err != nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") {
		return nil, errors.New("seda: BaseURL must use http or https")
	}
	if !strings.HasSuffix(baseURL.Path, "/") {
		baseURL.Path += "/"
	}
	client := &Client{
		baseURL:    baseURL,
		token:      options.Token,
		httpClient: options.HTTPClient,
		dial:       options.dial,
	}
	if client.httpClient == nil {
		client.httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	if client.dial == nil {
		client.dial = func(ctx context.Context, target string) (socket, error) {
			connection, _, err := websocket.DefaultDialer.DialContext(ctx, target, nil)
			return connection, err
		}
	}
	status, err := client.Status(ctx)
	if err != nil {
		return nil, err
	}
	if status.Protocol != protocolVersion {
		return nil, fmt.Errorf(
			"seda: unsupported protocol %d; this client supports %d",
			status.Protocol,
			protocolVersion,
		)
	}
	return client, nil
}

// Status returns service health and protocol compatibility.
func (c *Client) Status(ctx context.Context) (Status, error) {
	var result Status
	err := c.request(ctx, http.MethodGet, "v1/status", nil, "", &result)
	return result, err
}

// Capabilities returns the exact resolved model and language behavior.
func (c *Client) Capabilities(ctx context.Context) (Capabilities, error) {
	var result Capabilities
	err := c.request(ctx, http.MethodGet, "v1/capabilities", nil, "", &result)
	return result, err
}

// TranscribeOptions are scoped to one complete audio request.
type TranscribeOptions struct {
	Language string
}

// Transcribe recognizes one mono PCM WAV file.
func (c *Client) Transcribe(
	ctx context.Context,
	wav []byte,
	options TranscribeOptions,
) (Transcript, error) {
	path := "v1/transcriptions"
	if options.Language != "" {
		path += "?language=" + url.QueryEscape(options.Language)
	}
	var result Transcript
	err := c.request(ctx, http.MethodPost, path, wav, "audio/wav", &result)
	return result, err
}

// ListenOptions are fixed when a new live stream begins.
type ListenOptions struct {
	Language string
}

type sessionCreated struct {
	ID            string `json:"id"`
	WebSocketPath string `json:"websocketPath"`
	Ticket        string `json:"ticket"`
}

// Listen opens a new language-scoped live stream against the prepared model.
func (c *Client) Listen(
	ctx context.Context,
	options ListenOptions,
) (*Session, error) {
	request := map[string]any{
		"input": map[string]any{
			"encoding":   "pcm_s16le",
			"sampleRate": 16_000,
			"channels":   1,
		},
	}
	if options.Language != "" {
		request["language"] = options.Language
	}
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	var created sessionCreated
	if err := c.request(
		ctx,
		http.MethodPost,
		"v1/sessions",
		body,
		"application/json",
		&created,
	); err != nil {
		return nil, err
	}
	target := c.baseURL.ResolveReference(&url.URL{Path: created.WebSocketPath})
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	query := target.Query()
	query.Set("ticket", created.Ticket)
	target.RawQuery = query.Encode()
	connection, err := c.dial(ctx, target.String())
	if err != nil {
		return nil, fmt.Errorf("seda: open live session: %w", err)
	}
	return &Session{id: created.ID, socket: connection}, nil
}

func (c *Client) request(
	ctx context.Context,
	method string,
	path string,
	body []byte,
	contentType string,
	output any,
) error {
	target, err := c.baseURL.Parse(path)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		target.String(),
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("seda: request failed: %w", err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return responseError(payload, response.StatusCode)
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("seda: invalid JSON response: %w", err)
	}
	return nil
}

// Session is one independent live transcription stream.
type Session struct {
	id      string
	socket  socket
	settled bool
}

// ID returns the server-generated session identifier.
func (s *Session) ID() string { return s.id }

// Write sends 16 kHz mono signed little-endian PCM.
func (s *Session) Write(pcmS16LE []byte) error {
	if s.settled {
		return errors.New("seda: session is already closed")
	}
	return s.socket.WriteMessage(websocket.BinaryMessage, pcmS16LE)
}

// Commit finalizes the stream. onTranscript receives every revisable result.
func (s *Session) Commit(
	ctx context.Context,
	onTranscript func(TranscriptUpdate),
) (Transcript, error) {
	if s.settled {
		return Transcript{}, errors.New("seda: session is already closed")
	}
	if err := s.socket.WriteMessage(
		websocket.TextMessage,
		[]byte(`{"type":"commit"}`),
	); err != nil {
		return Transcript{}, err
	}
	defer s.close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = s.socket.SetReadDeadline(deadline)
	}
	for {
		messageType, payload, err := s.socket.ReadMessage()
		if err != nil {
			return Transcript{}, fmt.Errorf("seda: read live event: %w", err)
		}
		if messageType != websocket.TextMessage {
			continue
		}
		var envelope struct {
			Type       string         `json:"type"`
			Transcript *Transcript    `json:"transcript"`
			Error      *protocolError `json:"error"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return Transcript{}, fmt.Errorf("seda: invalid live event: %w", err)
		}
		switch envelope.Type {
		case "transcript":
			if onTranscript != nil {
				var update TranscriptUpdate
				if err := json.Unmarshal(payload, &update); err != nil {
					return Transcript{}, err
				}
				onTranscript(update)
			}
		case "completed":
			if envelope.Transcript == nil {
				return Transcript{}, errors.New("seda: completed event has no transcript")
			}
			return *envelope.Transcript, nil
		case "error":
			if envelope.Error == nil {
				return Transcript{}, errors.New("seda: malformed error event")
			}
			return Transcript{}, envelope.Error.toError(0)
		}
	}
}

// Cancel closes a stream without producing a final transcript.
func (s *Session) Cancel() error {
	if s.settled {
		return nil
	}
	defer s.close()
	return s.socket.WriteMessage(
		websocket.TextMessage,
		[]byte(`{"type":"cancel"}`),
	)
}

func (s *Session) close() {
	s.settled = true
	_ = s.socket.Close()
}

type protocolError struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	Recoverable bool   `json:"recoverable"`
}

func (e protocolError) toError(status int) *Error {
	return &Error{
		Code:        e.Code,
		Message:     e.Message,
		Recoverable: e.Recoverable,
		StatusCode:  status,
	}
}

func responseError(payload []byte, status int) error {
	var envelope struct {
		Error protocolError `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil &&
		envelope.Error.Message != "" {
		return envelope.Error.toError(status)
	}
	return &Error{
		Code:        "runtime_failed",
		Message:     fmt.Sprintf("Seda request failed with HTTP %d", status),
		Recoverable: status >= 500,
		StatusCode:  status,
	}
}

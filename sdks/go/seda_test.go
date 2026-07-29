package seda

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeSocket struct {
	writes   [][]byte
	messages [][]byte
	closed   bool
}

func (f *fakeSocket) WriteMessage(_ int, data []byte) error {
	f.writes = append(f.writes, append([]byte(nil), data...))
	return nil
}

func (f *fakeSocket) ReadMessage() (int, []byte, error) {
	message := f.messages[0]
	f.messages = f.messages[1:]
	return 1, message, nil
}

func (f *fakeSocket) SetReadDeadline(time.Time) error { return nil }
func (f *fakeSocket) Close() error {
	f.closed = true
	return nil
}

func TestResolvedModelAndStreamLanguage(t *testing.T) {
	var sessionRequest map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("missing bearer token")
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/status":
			io.WriteString(response, `{
				"name":"seda","version":"0.2.0","protocol":1,"ready":true
			}`)
		case "/v1/capabilities":
			io.WriteString(response, `{
				"runtime":"fixture",
				"resolvedModel":{
					"id":"fixture/streaming","revision":"test",
					"variant":"fixture","runtime":"fixture"
				},
				"language":{
					"mode":"prompted","supported":["en-US","de-DE"],
					"supportsAuto":true
				},
				"streaming":"true","punctuation":true,
				"wordTimestamps":true,"globalPushToTalk":false,
				"focusedAppInsertion":false
			}`)
		case "/v1/sessions":
			if err := json.NewDecoder(request.Body).Decode(&sessionRequest); err != nil {
				t.Fatal(err)
			}
			io.WriteString(response, `{
				"id":"session-1",
				"websocketPath":"/v1/sessions/session-1/stream",
				"ticket":"ticket-1"
			}`)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	fake := &fakeSocket{messages: [][]byte{
		[]byte(`{
			"type":"transcript","segment_id":"session-1:0","revision":1,
			"text":"hallo","stable_text":"","unstable_text":"hallo",
			"final":false,"words":[]
		}`),
		[]byte(`{
			"type":"completed",
			"transcript":{
				"text":"hallo welt","words":[],"language":"de-DE","durationMs":900
			}
		}`),
	}}
	client, err := Connect(context.Background(), Options{
		BaseURL: server.URL,
		Token:   "token",
		dial: func(_ context.Context, target string) (socket, error) {
			if !strings.Contains(target, "ticket=ticket-1") {
				t.Fatalf("ticket missing from %s", target)
			}
			return fake, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	capabilities, err := client.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.ResolvedModel.ID != "fixture/streaming" {
		t.Fatalf("unexpected model: %s", capabilities.ResolvedModel.ID)
	}

	session, err := client.Listen(
		context.Background(),
		ListenOptions{Language: "de-DE"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if sessionRequest["language"] != "de-DE" {
		t.Fatalf("unexpected language: %#v", sessionRequest["language"])
	}
	if err := session.Write([]byte{0, 0, 1, 0}); err != nil {
		t.Fatal(err)
	}
	var partial string
	transcript, err := session.Commit(
		context.Background(),
		func(update TranscriptUpdate) { partial = update.Text },
	)
	if err != nil {
		t.Fatal(err)
	}
	if partial != "hallo" || transcript.Text != "hallo welt" {
		t.Fatalf("unexpected results: %q, %q", partial, transcript.Text)
	}
	if !fake.closed {
		t.Fatal("socket was not closed")
	}
}

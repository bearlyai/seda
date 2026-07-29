package seda

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"testing"
)

func TestFixtureSidecarIntegration(t *testing.T) {
	baseURL := os.Getenv("SEDA_TEST_BASE_URL")
	token := os.Getenv("SEDA_TEST_TOKEN")
	if baseURL == "" || token == "" {
		t.Skip("set SEDA_TEST_BASE_URL and SEDA_TEST_TOKEN")
	}
	client, err := Connect(
		context.Background(),
		Options{BaseURL: baseURL, Token: token},
	)
	if err != nil {
		t.Fatal(err)
	}
	capabilities, err := client.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.ResolvedModel.ID != "fixture/streaming-en" {
		t.Fatalf("unexpected model: %s", capabilities.ResolvedModel.ID)
	}
	transcript, err := client.Transcribe(
		context.Background(),
		wavFixture(320),
		TranscribeOptions{Language: "en"},
	)
	if err != nil || transcript.Text != "hello world" {
		t.Fatalf("complete transcription: %#v, %v", transcript, err)
	}

	session, err := client.Listen(
		context.Background(),
		ListenOptions{Language: "en"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Write(make([]byte, 320)); err != nil {
		t.Fatal(err)
	}
	if err := session.Write(make([]byte, 320)); err != nil {
		t.Fatal(err)
	}
	updates := 0
	transcript, err = session.Commit(
		context.Background(),
		func(TranscriptUpdate) { updates++ },
	)
	if err != nil || transcript.Text != "hello world" || updates < 2 {
		t.Fatalf("live transcription: %#v, updates=%d, %v", transcript, updates, err)
	}
}

func wavFixture(samples uint32) []byte {
	var output bytes.Buffer
	output.WriteString("RIFF")
	_ = binary.Write(&output, binary.LittleEndian, uint32(36+samples*2))
	output.WriteString("WAVEfmt ")
	_ = binary.Write(&output, binary.LittleEndian, uint32(16))
	_ = binary.Write(&output, binary.LittleEndian, uint16(1))
	_ = binary.Write(&output, binary.LittleEndian, uint16(1))
	_ = binary.Write(&output, binary.LittleEndian, uint32(16_000))
	_ = binary.Write(&output, binary.LittleEndian, uint32(32_000))
	_ = binary.Write(&output, binary.LittleEndian, uint16(2))
	_ = binary.Write(&output, binary.LittleEndian, uint16(16))
	output.WriteString("data")
	_ = binary.Write(&output, binary.LittleEndian, samples*2)
	output.Write(make([]byte, samples*2))
	return output.Bytes()
}

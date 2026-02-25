package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type EventStream struct {
	mu      sync.Mutex
	clients map[chan string]struct{}
}

func NewEventStream() *EventStream {
	return &EventStream{clients: make(map[chan string]struct{})}
}

func (s *EventStream) Subscribe() (chan string, func()) {
	ch := make(chan string, 16)

	s.mu.Lock()
	s.clients[ch] = struct{}{}
	s.mu.Unlock()

	unsubscribe := func() {
		s.mu.Lock()
		if _, ok := s.clients[ch]; ok {
			delete(s.clients, ch)
			close(ch)
		}
		s.mu.Unlock()
	}

	return ch, unsubscribe
}

func (s *EventStream) Publish(payload string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for ch := range s.clients {
		select {
		case ch <- payload:
		default:
			// Drop when a subscriber is lagging to keep stream non-blocking.
		}
	}
}

func (s *Service) publishEvent(eventType string, payload any) {
	if s.stream == nil {
		return
	}

	message := map[string]any{
		"type": eventType,
		"at":   time.Now().UTC().Format(time.RFC3339Nano),
		"data": payload,
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return
	}

	s.stream.Publish(string(encoded))
}

func (s *Service) handleEventsStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	msgCh, unsubscribe := s.stream.Subscribe()
	defer unsubscribe()

	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-msgCh:
			if !ok {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				return
			}
			flusher.Flush()
		case <-pingTicker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

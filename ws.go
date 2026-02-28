package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	wsTypeAck                   = "ack"
	wsTypeHeartbeat             = "heartbeat"
	wsTypeHeartbeatAck          = "heartbeat_ack"
	wsTypeReceiveToken          = "receive-token"
	wsTypeClearToken            = "clear-token"
	wsTypeStudiesHeaders        = "receive-studies-headers"
	wsTypeStudiesRefresh        = "receive-studies-refresh"
	wsTypeStudiesResponse       = "receive-studies-response"
	wsTypeSubmission            = "receive-submission-response"
	wsTypeParticipantSubs       = "receive-participant-submissions-response"
	wsTypeScheduleDelayed       = "schedule-delayed-refresh"
	wsTypeStudiesRefreshEvent   = "studies_refresh_event"
	wsWriteTimeout              = 10 * time.Second
	wsReadLimitBytes      int64 = 8 << 20
)

type wsClientMessage struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	SentAt  string          `json:"sent_at,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type wsServerMessage struct {
	Type  string `json:"type"`
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
	Data  any    `json:"data,omitempty"`
	At    string `json:"at,omitempty"`
}

type wsConnClient struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func (s *Service) handleExtensionWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{
			"moz-extension://*",
			"chrome-extension://*",
			"http://localhost",
			"http://localhost:*",
			"http://127.0.0.1",
			"http://127.0.0.1:*",
		},
	})
	if err != nil {
		return
	}

	client := &wsConnClient{conn: conn}
	s.addWSClient(client)
	defer s.removeWSClient(client)

	closeCode := websocket.StatusNormalClosure
	closeReason := ""
	defer func() {
		_ = conn.Close(closeCode, closeReason)
	}()

	conn.SetReadLimit(wsReadLimitBytes)

	ctx := r.Context()
	for {
		var request wsClientMessage
		if err := wsjson.Read(ctx, conn, &request); err != nil {
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway || status == websocket.StatusNoStatusRcvd {
				return
			}
			logWarn("ws.read_failed", "error", err)
			closeCode = websocket.StatusInternalError
			closeReason = "read failed"
			return
		}

		response := s.handleWSRequest(request)
		if err := s.writeWSMessage(ctx, client, response); err != nil {
			logWarn("ws.write_failed", "error", err)
			closeCode = websocket.StatusInternalError
			closeReason = "write failed"
			return
		}
	}
}

func (s *Service) addWSClient(client *wsConnClient) {
	if client == nil {
		return
	}

	s.wsClientsMu.Lock()
	s.wsClientsSet[client] = struct{}{}
	s.wsClientsMu.Unlock()
}

func (s *Service) removeWSClient(client *wsConnClient) {
	if client == nil {
		return
	}

	s.wsClientsMu.Lock()
	delete(s.wsClientsSet, client)
	s.wsClientsMu.Unlock()
}

func (s *Service) snapshotWSClients() []*wsConnClient {
	s.wsClientsMu.Lock()
	defer s.wsClientsMu.Unlock()

	clients := make([]*wsConnClient, 0, len(s.wsClientsSet))
	for client := range s.wsClientsSet {
		clients = append(clients, client)
	}
	return clients
}

func (s *Service) writeWSMessage(parentCtx context.Context, client *wsConnClient, message wsServerMessage) error {
	if client == nil || client.conn == nil {
		return errors.New("invalid websocket client")
	}

	client.writeMu.Lock()
	defer client.writeMu.Unlock()

	writeCtx, cancel := context.WithTimeout(parentCtx, wsWriteTimeout)
	defer cancel()
	return wsjson.Write(writeCtx, client.conn, message)
}

func (s *Service) broadcastStudiesRefreshEvent(update StudiesRefreshUpdate) {
	observedAt := utcNowOr(update.ObservedAt)
	event := wsServerMessage{
		Type: wsTypeStudiesRefreshEvent,
		Data: map[string]any{
			"source":      update.Source,
			"url":         update.URL,
			"status_code": update.StatusCode,
			"observed_at": observedAt.Format(time.RFC3339Nano),
		},
		At: observedAt.Format(time.RFC3339Nano),
	}

	clients := s.snapshotWSClients()
	for _, client := range clients {
		if err := s.writeWSMessage(context.Background(), client, event); err != nil {
			logWarn("ws.broadcast_failed", "type", wsTypeStudiesRefreshEvent, "error", err)
		}
	}
}

func (s *Service) handleWSRequest(request wsClientMessage) wsServerMessage {
	requestType := strings.TrimSpace(request.Type)
	requestID := strings.TrimSpace(request.ID)

	if requestType == wsTypeHeartbeat {
		return wsServerMessage{
			Type: wsTypeHeartbeatAck,
			ID:   requestID,
			At:   time.Now().UTC().Format(time.RFC3339Nano),
		}
	}

	response := wsServerMessage{
		Type: wsTypeAck,
		ID:   requestID,
	}
	if requestType == "" {
		response.OK = false
		response.Error = "missing type"
		return response
	}

	result, err := s.dispatchWSRequest(requestType, request.Payload)
	if err != nil {
		response.OK = false
		response.Error = wsErrorMessage(err)
		logWarn("ws.request_failed", "type", requestType, "id", requestID, "error", err)
		return response
	}

	response.OK = true
	response.Data = result
	return response
}

func (s *Service) dispatchWSRequest(requestType string, payload json.RawMessage) (map[string]any, error) {
	switch requestType {
	case wsTypeReceiveToken:
		return decodeWSAndDispatch(payload, true, s.processReceiveToken)
	case wsTypeClearToken:
		return decodeWSAndDispatch(payload, false, s.processClearToken)
	case wsTypeStudiesHeaders:
		return decodeWSAndDispatch(payload, true, s.processReceiveStudiesHeaders)
	case wsTypeStudiesRefresh:
		return decodeWSAndDispatch(payload, true, s.processReceiveStudiesRefresh)
	case wsTypeStudiesResponse:
		return decodeWSAndDispatch(payload, true, s.processReceiveStudiesResponse)
	case wsTypeSubmission:
		return decodeWSAndDispatch(payload, true, s.processReceiveSubmissionResponse)
	case wsTypeParticipantSubs:
		return decodeWSAndDispatch(payload, true, s.processReceiveParticipantSubmissionsResponse)
	case wsTypeScheduleDelayed:
		return decodeWSAndDispatch(payload, true, s.processScheduleDelayedRefresh)
	default:
		return nil, badRequest(fmt.Sprintf("unknown message type %q", requestType), nil)
	}
}

func decodeWSAndDispatch[T any](
	payload json.RawMessage,
	required bool,
	processor func(T) (map[string]any, error),
) (map[string]any, error) {
	var parsed T
	if err := decodeWSPayload(payload, &parsed, required); err != nil {
		return nil, err
	}
	return processor(parsed)
}

func decodeWSPayload(raw json.RawMessage, dst any, required bool) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		if required {
			return badRequest("missing payload", nil)
		}
		return nil
	}
	if err := json.Unmarshal(trimmed, dst); err != nil {
		return badRequest("invalid payload", err)
	}
	return nil
}

func wsErrorMessage(err error) string {
	var typed *apiError
	if errors.As(err, &typed) && typed != nil {
		return typed.message
	}
	return "internal server error"
}

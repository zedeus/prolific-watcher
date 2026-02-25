package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
)

func (s *Service) handleHome(w http.ResponseWriter, _ *http.Request) {
	html := "<!doctype html><html><body><h1>Prolific Watcher Service</h1><p>See README for endpoint details.</p></body></html>"
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(html))
}

func (s *Service) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) handleStatus(w http.ResponseWriter, _ *http.Request) {
	token, err := s.tokenStore.Get()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load token state", nil)
		return
	}

	capture, err := s.headersStore.Get()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load studies headers state", nil)
		return
	}

	status := map[string]any{
		"has_token":           token != nil,
		"has_studies_headers": capture != nil,
	}
	if token != nil {
		status["token_type"] = token.TokenType
		status["token_preview"] = maskToken(token.AccessToken)
		status["origin"] = token.Origin
		status["browser_info"] = token.BrowserInfo
		status["key"] = token.Key
		status["received_at"] = token.ReceivedAt
	}
	if capture != nil {
		status["studies_headers_url"] = capture.URL
		status["studies_headers_method"] = capture.Method
		status["studies_headers_count"] = len(capture.Headers)
		status["studies_headers_captured_at"] = capture.CapturedAt
	}

	if s.stateStore != nil {
		refreshState, err := s.stateStore.GetStudiesRefresh()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load studies refresh state", nil)
			return
		}
		if refreshState != nil && !refreshState.LastStudiesRefreshAt.IsZero() {
			status["last_studies_refresh_at"] = refreshState.LastStudiesRefreshAt
			status["last_studies_refresh_source"] = refreshState.LastStudiesRefreshSource
			status["last_studies_refresh_url"] = refreshState.LastStudiesRefreshURL
			status["last_studies_refresh_status"] = refreshState.LastStudiesRefreshStatus
		}
	}

	writeJSON(w, http.StatusOK, status)
}

func (s *Service) handleToken(w http.ResponseWriter, _ *http.Request) {
	token, err := s.tokenStore.Get()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load token state", nil)
		return
	}
	if token == nil {
		writeError(w, http.StatusNotFound, "no token available", nil)
		return
	}
	writeJSON(w, http.StatusOK, token)
}

func (s *Service) handleStudiesHeaders(w http.ResponseWriter, _ *http.Request) {
	capture, err := s.headersStore.Get()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load studies headers state", nil)
		return
	}
	if capture == nil {
		writeError(w, http.StatusNotFound, "no captured studies headers available", nil)
		return
	}
	writeJSON(w, http.StatusOK, capture)
}

func (s *Service) handleStudyEvents(w http.ResponseWriter, r *http.Request) {
	limit, err := parseIntQuery(r, "limit", defaultRecentEventsLimit, 1, maxRecentEventsLimit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}

	events, err := s.studiesStore.GetRecentAvailabilityEvents(limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load study events", nil)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"events": events,
		"meta": map[string]any{
			"count": len(events),
		},
	})
}

func (s *Service) handleStudiesRefresh(w http.ResponseWriter, r *http.Request) {
	if s.stateStore == nil {
		writeJSON(w, http.StatusOK, map[string]any{"has_refresh": false})
		return
	}

	state, err := s.stateStore.GetStudiesRefresh()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load studies refresh state", nil)
		return
	}
	if state == nil || state.LastStudiesRefreshAt.IsZero() {
		writeJSON(w, http.StatusOK, map[string]any{"has_refresh": false})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"has_refresh":                 true,
		"last_studies_refresh_at":     state.LastStudiesRefreshAt,
		"last_studies_refresh_source": state.LastStudiesRefreshSource,
		"last_studies_refresh_url":    state.LastStudiesRefreshURL,
		"last_studies_refresh_status": state.LastStudiesRefreshStatus,
		"updated_at":                  state.UpdatedAt,
	})
}

func (s *Service) handleReceiveToken(w http.ResponseWriter, r *http.Request) {
	var payload StoredToken
	if !decodeJSONBodyOrBadRequest(w, r, &payload) {
		return
	}
	if payload.AccessToken == "" {
		writeError(w, http.StatusBadRequest, "missing access_token", nil)
		return
	}
	if err := s.tokenStore.Set(payload); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to persist token", nil)
		return
	}

	logInfo("token.received", "origin", payload.Origin, "key", payload.Key, "browser_info", payload.BrowserInfo)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "token stored"})
}

type clearTokenRequest struct {
	Reason string `json:"reason"`
}

func (s *Service) handleClearToken(w http.ResponseWriter, r *http.Request) {
	var payload clearTokenRequest
	if err := decodeJSONBody(r, &payload); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid JSON body", nil)
		return
	}

	if err := s.tokenStore.Clear(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear token", err)
		return
	}

	reason := strings.TrimSpace(payload.Reason)
	if reason == "" {
		reason = "extension.clear_token"
	}
	s.cancelDelayedServiceRefresh(reason)

	logInfo("token.cleared", "reason", reason)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "reason": reason})
}

func (s *Service) handleReceiveStudiesHeaders(w http.ResponseWriter, r *http.Request) {
	var payload StudiesHeadersCapture
	if !decodeJSONBodyOrBadRequest(w, r, &payload) {
		return
	}

	normalizedURL, ok := normalizeStudiesURLOrBadRequest(w, payload.URL)
	if !ok {
		return
	}
	payload.URL = normalizedURL

	if len(payload.Headers) == 0 {
		writeError(w, http.StatusBadRequest, "headers cannot be empty", nil)
		return
	}
	if len(payload.Headers) > 250 {
		writeError(w, http.StatusBadRequest, "too many headers in payload", nil)
		return
	}

	if err := s.headersStore.Set(payload); err != nil {
		logWarn("studies.headers.persist_failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to persist studies headers", err)
		return
	}

	logInfo("studies.headers.received", "url", payload.URL, "method", payload.Method, "count", len(payload.Headers))
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "studies headers stored", "count": len(payload.Headers)})
}

func (s *Service) handleReceiveStudiesRefresh(w http.ResponseWriter, r *http.Request) {
	var payload StudiesRefreshUpdate
	if !decodeJSONBodyOrBadRequest(w, r, &payload) {
		return
	}

	if payload.URL != "" {
		normalizedURL, ok := normalizeStudiesURLOrBadRequest(w, payload.URL)
		if !ok {
			return
		}
		payload.URL = normalizedURL
	}

	if err := s.markStudiesRefresh(payload.ObservedAt, payload.Source, payload.URL, payload.StatusCode); err != nil {
		logWarn("studies.refresh.persist_failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to persist studies refresh", err)
		return
	}

	s.publishStudiesRefreshEvent(payload)
	logInfo("studies.refresh.received", "source", payload.Source, "status_code", payload.StatusCode, "url", payload.URL, "observed_at", payload.ObservedAt)
	if shouldScheduleDelayedRefresh(payload.Source, payload.StatusCode) {
		authReady, err := s.canScheduleDelayedRefresh()
		if err != nil {
			logWarn("refresh.delayed.schedule_skipped", "source", payload.Source, "reason", "token_lookup_failed", "error", err)
		} else if !authReady {
			logInfo("refresh.delayed.schedule_skipped", "source", payload.Source, "reason", "not_authenticated")
		} else {
			s.scheduleDelayedServiceRefresh(payload.Source, payload.DelayedRefreshPolicy)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

type delayedRefreshScheduleRequest struct {
	Policy  DelayedRefreshPolicy `json:"policy"`
	Trigger string               `json:"trigger"`
}

func (s *Service) handleScheduleDelayedRefresh(w http.ResponseWriter, r *http.Request) {
	var payload delayedRefreshScheduleRequest
	if !decodeJSONBodyOrBadRequest(w, r, &payload) {
		return
	}

	trigger := strings.TrimSpace(payload.Trigger)
	if trigger == "" {
		trigger = "extension.policy_update"
	}

	authReady, err := s.canScheduleDelayedRefresh()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to verify token state", err)
		return
	}
	if !authReady {
		s.cancelDelayedServiceRefresh("extension.schedule.request_while_signed_out")
		writeJSON(w, http.StatusOK, map[string]any{
			"success":   true,
			"trigger":   trigger,
			"scheduled": false,
			"reason":    "not authenticated",
		})
		return
	}

	s.scheduleDelayedServiceRefresh(trigger, &payload.Policy)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "trigger": trigger})
}

type interceptedStudiesResponsePayload struct {
	URL        string          `json:"url"`
	StatusCode int             `json:"status_code"`
	ObservedAt time.Time       `json:"observed_at"`
	Body       json.RawMessage `json:"body"`
}

func normalizeStudiesURLOrBadRequest(w http.ResponseWriter, raw string) (string, bool) {
	normalizedURL, ok := normalizeStudiesCollectionURL(raw)
	if !ok {
		writeError(w, http.StatusBadRequest, "url must target internal studies endpoint", nil)
		return "", false
	}
	return normalizedURL, true
}

func (s *Service) handleReceiveStudiesResponse(w http.ResponseWriter, r *http.Request) {
	var payload interceptedStudiesResponsePayload
	if !decodeJSONBodyOrBadRequest(w, r, &payload) {
		return
	}

	normalizedURL, ok := normalizeStudiesURLOrBadRequest(w, payload.URL)
	if !ok {
		return
	}
	payload.URL = normalizedURL

	if len(payload.Body) == 0 {
		writeError(w, http.StatusBadRequest, "body cannot be empty", nil)
		return
	}

	if payload.StatusCode != 0 && payload.StatusCode != http.StatusOK {
		if err := s.markStudiesRefresh(payload.ObservedAt, "extension.intercepted_response", payload.URL, payload.StatusCode); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to persist studies refresh status", nil)
			return
		}
		s.publishStudiesRefreshEvent(StudiesRefreshUpdate{
			ObservedAt: payload.ObservedAt,
			Source:     "extension.intercepted_response",
			URL:        payload.URL,
			StatusCode: payload.StatusCode,
		})
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	normalized, availability, err := s.ingestStudiesPayload(payload.Body, payload.ObservedAt, "extension.intercepted_response", payload.URL, http.StatusOK)
	if err != nil {
		logWarn("studies.response.ingest_failed", "source", "extension.intercepted_response", "url", payload.URL, "error", err)
		writeError(w, http.StatusBadRequest, "failed to ingest studies response", err)
		return
	}

	response := map[string]any{"success": true, "meta": map[string]any{"count": len(normalized.Results)}}
	if availability != nil {
		response["changes"] = availability
	}

	logInfo("studies.response.ingested", "source", "extension.intercepted_response", "count", len(normalized.Results), "url", payload.URL)
	writeJSON(w, http.StatusOK, response)
}

func (s *Service) markStudiesRefresh(observedAt time.Time, source, url string, statusCode int) error {
	if s.stateStore == nil {
		return nil
	}
	if source == "" {
		source = "unknown"
	}

	return s.stateStore.SetStudiesRefresh(StudiesRefreshUpdate{
		ObservedAt: utcNowOr(observedAt),
		Source:     source,
		URL:        url,
		StatusCode: statusCode,
	})
}

func (s *Service) publishStudiesRefreshEvent(update StudiesRefreshUpdate) {
	s.publishEvent("studies_refresh", map[string]any{
		"source":      update.Source,
		"url":         update.URL,
		"status_code": update.StatusCode,
		"observed_at": utcNowOr(update.ObservedAt).Format(time.RFC3339Nano),
	})
}

func (s *Service) ingestStudiesPayload(
	body []byte,
	observedAt time.Time,
	source string,
	sourceURL string,
	statusCode int,
) (*normalizedStudiesResponse, *StudyAvailabilitySummary, error) {
	observedAt = utcNowOr(observedAt)
	if statusCode == 0 {
		statusCode = http.StatusOK
	}

	if err := s.markStudiesRefresh(observedAt, source, sourceURL, statusCode); err != nil {
		logWarn("studies.refresh.persist_state_failed", "error", err)
	}

	normalizedBody, err := normalizeStudiesResponse(body)
	if err != nil {
		return nil, nil, err
	}
	if err := s.studiesStore.StoreNormalizedStudies(normalizedBody.Results, observedAt); err != nil {
		logWarn("studies.persist_failed", "error", err)
	}

	availability, err := s.studiesStore.ReconcileAvailability(normalizedBody.Results, observedAt)
	if err != nil {
		logWarn("studies.reconcile_failed", "error", err)
	}

	if availability != nil {
		for _, change := range availability.NewlyAvailable {
			logInfo("study_event", "event_type", "available", "study_id", change.StudyID, "name", change.Name, "observed_at", availability.ObservedAt)
		}
		for _, change := range availability.BecameUnavailable {
			logInfo("study_event", "event_type", "unavailable", "study_id", change.StudyID, "name", change.Name, "observed_at", availability.ObservedAt)
		}
	}

	eventPayload := map[string]any{
		"source":          source,
		"url":             sourceURL,
		"status_code":     statusCode,
		"observed_at":     observedAt.Format(time.RFC3339Nano),
		"available_count": len(normalizedBody.Results),
	}
	if availability != nil {
		eventPayload["newly_available"] = availability.NewlyAvailable
		eventPayload["became_unavailable"] = availability.BecameUnavailable
	}
	s.publishEvent("studies_updated", eventPayload)

	return normalizedBody, availability, nil
}

func buildStudiesHeaders(token *StoredToken, capture *StudiesHeadersCapture) azuretls.OrderedHeaders {
	tokenType := strings.TrimSpace(token.TokenType)
	if tokenType == "" {
		tokenType = "Bearer"
	}

	browserInfo := strings.TrimSpace(token.BrowserInfo)
	if browserInfo == "" {
		browserInfo = "UTC"
	}

	ordered := azuretls.OrderedHeaders{}
	seen := map[string]bool{}
	appendHeader := func(name, value string) {
		name = strings.ToLower(strings.TrimSpace(name))
		value = strings.TrimSpace(value)
		if name == "" || value == "" || seen[name] {
			return
		}
		seen[name] = true
		ordered = append(ordered, []string{name, value})
	}

	if capture != nil {
		for _, h := range capture.Headers {
			name := strings.ToLower(strings.TrimSpace(h.Name))
			switch name {
			case "", "authorization", "user-agent", "host", "content-length", "connection":
				continue
			}
			appendHeader(name, h.Value)
		}
	}

	appendHeader("accept", "application/json, text/plain, */*")
	appendHeader("accept-language", "en-US,en;q=0.9")
	appendHeader("x-client-version", internalClientVersion)
	appendHeader("x-browser-info", browserInfo)
	appendHeader("origin", frontendOrigin)
	appendHeader("referer", frontendReferer)
	appendHeader("authorization", tokenType+" "+token.AccessToken)
	return ordered
}

func (s *Service) handleStudies(w http.ResponseWriter, r *http.Request) {
	limit, err := parseIntQuery(r, "limit", defaultCurrentStudies, 1, maxCurrentStudies)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}

	studies, err := s.studiesStore.GetCurrentAvailableStudies(limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load current studies", nil)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"results": studies,
		"meta": map[string]any{
			"count":  len(studies),
			"source": "cache",
		},
	})
}

func (s *Service) handleStudiesLive(w http.ResponseWriter, r *http.Request) {
	s.handleStudies(w, r)
}

func (s *Service) handleStudiesForceRefresh(w http.ResponseWriter, r *http.Request) {
	token, capture, targetURL, err := s.resolveStudiesRefreshInputs()
	if err != nil {
		if strings.Contains(err.Error(), "not authenticated") {
			writeError(w, http.StatusUnauthorized, err.Error(), nil)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to prepare studies refresh inputs", err)
		return
	}

	acquired, retryAfter := s.acquireUpstreamRefreshSlot(defaultUpstreamRefreshMinGap)
	if !acquired {
		retryAfterSeconds := int(retryAfter / time.Second)
		if retryAfter%time.Second != 0 {
			retryAfterSeconds++
		}
		if retryAfterSeconds < 1 {
			retryAfterSeconds = 1
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":               "refresh guard active",
			"retry_after_seconds": retryAfterSeconds,
		})
		return
	}
	defer s.releaseUpstreamRefreshSlot()

	session := azuretls.NewSession()
	defer session.Close()

	resp, err := session.Get(targetURL, buildStudiesHeaders(token, capture), 30*time.Second)
	if err != nil {
		writeError(w, http.StatusBadGateway, "request to prolific failed", err)
		return
	}

	if resp.StatusCode != http.StatusOK {
		if err := s.markStudiesRefresh(time.Now().UTC(), "service.studies_refresh", targetURL, resp.StatusCode); err != nil {
			logWarn("studies.refresh.persist_state_failed", "source", "service.studies_refresh", "error", err)
		}
		writePassthroughResponse(w, resp.StatusCode, resp.Header.Get("Content-Type"), resp.Body)
		return
	}

	observedAt := time.Now().UTC()
	normalizedBody, availability, err := s.ingestStudiesPayload(resp.Body, observedAt, "service.studies_refresh", targetURL, resp.StatusCode)
	if err != nil {
		logWarn("studies.normalize_failed", "source", "service.studies_refresh", "error", err)
		writePassthroughResponse(w, resp.StatusCode, resp.Header.Get("Content-Type"), resp.Body)
		return
	}

	response := map[string]any{
		"results": normalizedBody.Results,
		"_links":  normalizedBody.Links,
		"meta":    normalizedBody.Meta,
	}
	if availability != nil {
		response["changes"] = availability
	}

	logInfo("studies.refresh.forced", "count", len(normalizedBody.Results), "target", targetURL, "observed_at", observedAt)
	writeJSON(w, http.StatusOK, response)
}

func writePassthroughResponse(w http.ResponseWriter, statusCode int, contentType string, body []byte) {
	if contentType == "" {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(statusCode)
	_, _ = w.Write(body)
}

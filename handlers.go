package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
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

func normalizeSubmissionPhaseQueryOrBadRequest(w http.ResponseWriter, raw string) (string, bool) {
	phase := strings.ToLower(strings.TrimSpace(raw))
	if phase == "" || phase == "all" {
		return "all", true
	}

	if phase == SubmissionPhaseSubmitting || phase == SubmissionPhaseSubmitted {
		return phase, true
	}

	writeError(w, http.StatusBadRequest, "phase must be one of: all, submitting, submitted", nil)
	return "", false
}

func (s *Service) handleSubmissions(w http.ResponseWriter, r *http.Request) {
	if s.submissionsStore == nil {
		writeError(w, http.StatusServiceUnavailable, "submissions store not configured", nil)
		return
	}

	phase, ok := normalizeSubmissionPhaseQueryOrBadRequest(w, r.URL.Query().Get("phase"))
	if !ok {
		return
	}
	limit, err := parseIntQuery(r, "limit", defaultCurrentSubmissions, 1, maxCurrentSubmissions)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}

	submissions, err := s.submissionsStore.GetCurrentSubmissions(limit, phase)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load submissions", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"results": submissions,
		"meta": map[string]any{
			"count": len(submissions),
			"phase": phase,
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

type clearTokenRequest struct {
	Reason string `json:"reason"`
}

type delayedRefreshScheduleRequest struct {
	Policy  DelayedRefreshPolicy `json:"policy"`
	Trigger string               `json:"trigger"`
}

type interceptedStudiesResponsePayload struct {
	URL        string          `json:"url"`
	StatusCode int             `json:"status_code"`
	ObservedAt time.Time       `json:"observed_at"`
	Body       json.RawMessage `json:"body"`
}

type interceptedSubmissionResponsePayload struct {
	URL        string          `json:"url"`
	StatusCode int             `json:"status_code"`
	ObservedAt time.Time       `json:"observed_at"`
	Body       json.RawMessage `json:"body"`
}

type interceptedParticipantSubmissionsResponsePayload struct {
	URL        string          `json:"url"`
	StatusCode int             `json:"status_code"`
	ObservedAt time.Time       `json:"observed_at"`
	Body       json.RawMessage `json:"body"`
}

func normalizeSubmissionURL(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil {
		return "", false
	}
	if parsed.Scheme != "https" || strings.ToLower(strings.TrimSpace(parsed.Hostname())) != internalStudiesHost {
		return "", false
	}

	path := parsed.Path
	if path == "/api/v1/submissions/reserve/" {
		parsed.Path = "/api/v1/submissions/reserve/"
		parsed.RawQuery = ""
		return parsed.String(), true
	}

	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 5 &&
		parts[0] == "api" &&
		parts[1] == "v1" &&
		parts[2] == "submissions" &&
		parts[3] != "" &&
		parts[4] == "transition" {
		parsed.Path = "/api/v1/submissions/" + parts[3] + "/transition/"
		parsed.RawQuery = ""
		return parsed.String(), true
	}

	return "", false
}

func normalizeParticipantSubmissionsURL(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil {
		return "", false
	}
	if parsed.Scheme != "https" || strings.ToLower(strings.TrimSpace(parsed.Hostname())) != internalStudiesHost {
		return "", false
	}

	path := strings.TrimSpace(parsed.Path)
	if path != internalParticipantSubmissionsPath && path != strings.TrimSuffix(internalParticipantSubmissionsPath, "/") {
		return "", false
	}

	parsed.Path = internalParticipantSubmissionsPath
	return parsed.String(), true
}

type submissionStudyPayload struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type submissionResponseBody struct {
	ID            string                 `json:"id"`
	Status        string                 `json:"status"`
	ParticipantID string                 `json:"participant_id"`
	Participant   string                 `json:"participant"`
	StudyID       string                 `json:"study_id"`
	Study         submissionStudyPayload `json:"study"`
	StudyURL      string                 `json:"study_url"`
}

type participantSubmissionLink struct {
	Href  *string `json:"href"`
	Title string  `json:"title"`
}

type participantSubmissionsLinks struct {
	Self     participantSubmissionLink `json:"self"`
	Next     participantSubmissionLink `json:"next"`
	Previous participantSubmissionLink `json:"previous"`
	Last     participantSubmissionLink `json:"last"`
}

type participantSubmissionsMeta struct {
	Count                 int        `json:"count"`
	TotalEarned           int        `json:"total_earned"`
	TotalEarnedByCurrency []apiMoney `json:"total_earned_by_currency"`
	TotalApproved         int        `json:"total_approved"`
	TotalScreenedOut      int        `json:"total_screened_out"`
}

type participantSubmissionInstitution struct {
	Name *string `json:"name"`
	Logo *string `json:"logo"`
	Link string  `json:"link"`
}

type participantSubmissionPublisher struct {
	ID          string                           `json:"id"`
	Name        string                           `json:"name"`
	Country     string                           `json:"country"`
	Institution participantSubmissionInstitution `json:"institution"`
}

type participantSubmissionStudy struct {
	ID                         string                         `json:"id"`
	DynamicPayment             json.RawMessage                `json:"dynamic_payment"`
	IsTrialStudy               bool                           `json:"is_trial_study"`
	Name                       string                         `json:"name"`
	Publisher                  participantSubmissionPublisher `json:"publisher"`
	Researcher                 participantSubmissionPublisher `json:"researcher"`
	TermsAndConditionsRequired []json.RawMessage              `json:"terms_and_conditions_required"`
}

type participantSubmissionListItem struct {
	ID                       string                     `json:"id"`
	Status                   string                     `json:"status"`
	StartedAt                *string                    `json:"started_at"`
	CompletedAt              *string                    `json:"completed_at"`
	TimeTaken                string                     `json:"time_taken"`
	DynamicPaymentPercentage *float64                   `json:"dynamic_payment_percentage"`
	HasSiblings              bool                       `json:"has_siblings"`
	IsComplete               bool                       `json:"is_complete"`
	ReturnRequested          json.RawMessage            `json:"return_requested"`
	ScreenedOutPayments      []apiMoney                 `json:"screened_out_payments"`
	StudyCode                *string                    `json:"study_code"`
	SubmissionAdjustments    []apiMoney                 `json:"submission_adjustments"`
	SubmissionBonuses        []apiMoney                 `json:"submission_bonuses"`
	SubmissionReward         apiMoney                   `json:"submission_reward"`
	Study                    participantSubmissionStudy `json:"study"`
	ParticipantID            string                     `json:"participant_id,omitempty"`
	Participant              string                     `json:"participant,omitempty"`
	StudyID                  string                     `json:"study_id,omitempty"`
	StudyURL                 string                     `json:"study_url,omitempty"`
}

type participantSubmissionsListResponse struct {
	Results []json.RawMessage            `json:"results"`
	Links   *participantSubmissionsLinks `json:"_links,omitempty"`
	Meta    *participantSubmissionsMeta  `json:"meta,omitempty"`
}

func parseStudyIDFromSubmissionURL(studyURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(studyURL))
	if err != nil || parsed == nil {
		return ""
	}

	studyID := strings.TrimSpace(parsed.Query().Get("STUDY_ID"))
	if studyID != "" {
		return studyID
	}
	return strings.TrimSpace(parsed.Query().Get("study_id"))
}

func buildSubmissionSnapshot(
	submissionID string,
	status string,
	participantID string,
	studyID string,
	studyName string,
	payload json.RawMessage,
) (*SubmissionSnapshot, error) {
	submissionID = strings.TrimSpace(submissionID)
	if submissionID == "" {
		return nil, errors.New("submission response missing id")
	}

	status = strings.ToUpper(strings.TrimSpace(status))
	if status == "" {
		return nil, errors.New("submission response missing status")
	}

	participantID = strings.TrimSpace(participantID)
	studyID = strings.TrimSpace(studyID)
	studyName = strings.TrimSpace(studyName)
	if studyName == "" {
		studyName = "Unknown Study"
	}
	if studyID == "" {
		studyID = "unknown"
	}
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}

	return &SubmissionSnapshot{
		SubmissionID:  submissionID,
		StudyID:       studyID,
		StudyName:     studyName,
		ParticipantID: participantID,
		Status:        status,
		Phase:         normalizedSubmissionPhase(status),
		Payload:       append(json.RawMessage(nil), payload...),
	}, nil
}

func normalizeSubmissionSnapshot(body []byte) (*SubmissionSnapshot, error) {
	var parsed submissionResponseBody
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}

	participantID := strings.TrimSpace(parsed.ParticipantID)
	if participantID == "" {
		participantID = strings.TrimSpace(parsed.Participant)
	}

	studyID := strings.TrimSpace(parsed.StudyID)
	if studyID == "" {
		studyID = strings.TrimSpace(parsed.Study.ID)
	}
	if studyID == "" {
		studyID = parseStudyIDFromSubmissionURL(parsed.StudyURL)
	}

	return buildSubmissionSnapshot(
		parsed.ID,
		parsed.Status,
		participantID,
		studyID,
		parsed.Study.Name,
		append(json.RawMessage(nil), body...),
	)
}

func normalizeSubmissionSnapshotFromParticipantListItem(itemPayload json.RawMessage) (*SubmissionSnapshot, error) {
	var item participantSubmissionListItem
	if err := json.Unmarshal(itemPayload, &item); err != nil {
		return nil, fmt.Errorf("unmarshal participant submission item: %w", err)
	}

	participantID := strings.TrimSpace(item.ParticipantID)
	if participantID == "" {
		participantID = strings.TrimSpace(item.Participant)
	}

	studyID := strings.TrimSpace(item.StudyID)
	if studyID == "" {
		studyID = strings.TrimSpace(item.Study.ID)
	}
	if studyID == "" {
		studyID = parseStudyIDFromSubmissionURL(item.StudyURL)
	}

	snapshot, err := buildSubmissionSnapshot(
		item.ID,
		item.Status,
		participantID,
		studyID,
		item.Study.Name,
		append(json.RawMessage(nil), itemPayload...),
	)
	if err != nil {
		return nil, err
	}

	return snapshot, nil
}

func (s *Service) ingestSubmissionPayload(
	body []byte,
	observedAt time.Time,
) (*SubmissionUpdateResult, error) {
	if s.submissionsStore == nil {
		return nil, errors.New("submissions store is not configured")
	}

	snapshot, err := normalizeSubmissionSnapshot(body)
	if err != nil {
		return nil, err
	}

	update, err := s.submissionsStore.UpsertSnapshot(*snapshot, observedAt)
	if err != nil {
		return nil, err
	}

	return update, nil
}

func (s *Service) ingestParticipantSubmissionsPayload(
	body []byte,
	observedAt time.Time,
) (int, int, error) {
	if s.submissionsStore == nil {
		return 0, 0, errors.New("submissions store is not configured")
	}

	var parsed participantSubmissionsListResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return 0, 0, err
	}

	total := len(parsed.Results)
	upserted := 0
	baseObservedAt := utcNowOr(observedAt)

	for _, itemPayload := range parsed.Results {
		snapshot, err := normalizeSubmissionSnapshotFromParticipantListItem(itemPayload)
		if err != nil {
			logWarn("participant.submissions.item_parse_failed", "error", err)
			continue
		}

		if _, err := s.submissionsStore.UpsertSnapshot(*snapshot, baseObservedAt); err != nil {
			return total, upserted, err
		}
		upserted++
	}

	return total, upserted, nil
}

func (s *Service) markStudiesRefresh(observedAt time.Time, source, url string, statusCode int) error {
	if s.stateStore == nil {
		return nil
	}
	if source == "" {
		source = "unknown"
	}

	update := StudiesRefreshUpdate{
		ObservedAt: utcNowOr(observedAt),
		Source:     source,
		URL:        url,
		StatusCode: statusCode,
	}
	if err := s.stateStore.SetStudiesRefresh(update); err != nil {
		return err
	}

	s.broadcastStudiesRefreshEvent(update)
	return nil
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

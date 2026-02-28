package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	defaultRecentEventsLimit  = 50
	maxRecentEventsLimit      = 1000
	defaultCurrentStudies     = 200
	maxCurrentStudies         = 2000
	defaultCurrentSubmissions = 200
	maxCurrentSubmissions     = 2000
)

var submissionStatusPhase = map[string]string{
	"RESERVED":        SubmissionPhaseSubmitting,
	"ACTIVE":          SubmissionPhaseSubmitting,
	"AWAITING REVIEW": SubmissionPhaseSubmitted,
	"APPROVED":        SubmissionPhaseSubmitted,
	"REJECTED":        SubmissionPhaseSubmitted,
	"SCREENED OUT":    SubmissionPhaseSubmitted,
	"RETURNED":        SubmissionPhaseSubmitted,
}

type TokenStore struct{ db *sql.DB }

type StudiesHeaderStore struct{ db *sql.DB }

type ServiceStateStore struct{ db *sql.DB }

type StudiesStore struct{ db *sql.DB }

type SubmissionsStore struct{ db *sql.DB }

func NewTokenStore(db *sql.DB) *TokenStore { return &TokenStore{db: db} }

func NewStudiesHeaderStore(db *sql.DB) *StudiesHeaderStore { return &StudiesHeaderStore{db: db} }

func NewServiceStateStore(db *sql.DB) *ServiceStateStore { return &ServiceStateStore{db: db} }

func NewStudiesStore(db *sql.DB) *StudiesStore { return &StudiesStore{db: db} }

func NewSubmissionsStore(db *sql.DB) *SubmissionsStore { return &SubmissionsStore{db: db} }

func (s *TokenStore) Set(token StoredToken) error {
	token.ReceivedAt = utcNowOr(token.ReceivedAt)
	if token.TokenType == "" {
		token.TokenType = "Bearer"
	}

	_, err := s.db.Exec(
		`INSERT INTO token_state (id, access_token, token_type, storage_key, origin, browser_info, received_at)
		 VALUES (1, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   access_token = excluded.access_token,
		   token_type = excluded.token_type,
		   storage_key = excluded.storage_key,
		   origin = excluded.origin,
		   browser_info = excluded.browser_info,
		   received_at = excluded.received_at`,
		token.AccessToken,
		token.TokenType,
		token.Key,
		token.Origin,
		token.BrowserInfo,
		formatTime(token.ReceivedAt),
	)
	if err != nil {
		return fmt.Errorf("save token: %w", err)
	}
	return nil
}

func (s *TokenStore) Get() (*StoredToken, error) {
	row := s.db.QueryRow(
		`SELECT access_token, token_type, storage_key, origin, browser_info, received_at
		 FROM token_state
		 WHERE id = 1`,
	)

	var token StoredToken
	var receivedAt string
	if err := row.Scan(&token.AccessToken, &token.TokenType, &token.Key, &token.Origin, &token.BrowserInfo, &receivedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("load token: %w", err)
	}

	token.ReceivedAt = parseTime(receivedAt)
	if token.TokenType == "" {
		token.TokenType = "Bearer"
	}
	return &token, nil
}

func (s *TokenStore) Clear() error {
	_, err := s.db.Exec(`DELETE FROM token_state WHERE id = 1`)
	if err != nil {
		return fmt.Errorf("clear token: %w", err)
	}
	return nil
}

func (s *StudiesHeaderStore) Set(capture StudiesHeadersCapture) error {
	capture.CapturedAt = utcNowOr(capture.CapturedAt)
	if capture.Method == "" {
		capture.Method = "GET"
	}

	headersJSON, err := json.Marshal(capture.Headers)
	if err != nil {
		return fmt.Errorf("marshal captured headers: %w", err)
	}

	_, err = s.db.Exec(
		`INSERT INTO studies_headers_state (id, url, method, headers_json, captured_at)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   url = excluded.url,
		   method = excluded.method,
		   headers_json = excluded.headers_json,
		   captured_at = excluded.captured_at`,
		capture.URL,
		capture.Method,
		string(headersJSON),
		formatTime(capture.CapturedAt),
	)
	if err != nil {
		return fmt.Errorf("save studies headers: %w", err)
	}
	return nil
}

func (s *StudiesHeaderStore) Get() (*StudiesHeadersCapture, error) {
	row := s.db.QueryRow(
		`SELECT url, method, headers_json, captured_at
		 FROM studies_headers_state
		 WHERE id = 1`,
	)

	var capture StudiesHeadersCapture
	var headersJSON, capturedAt string
	if err := row.Scan(&capture.URL, &capture.Method, &headersJSON, &capturedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("load studies headers: %w", err)
	}
	if err := json.Unmarshal([]byte(headersJSON), &capture.Headers); err != nil {
		return nil, fmt.Errorf("parse studies headers: %w", err)
	}
	capture.CapturedAt = parseTime(capturedAt)
	return &capture, nil
}

func (s *ServiceStateStore) SetStudiesRefresh(update StudiesRefreshUpdate) error {
	observedAt := utcNowOr(update.ObservedAt)
	updatedAt := time.Now().UTC()

	const maxBusyRetries = 5
	for attempt := 0; attempt <= maxBusyRetries; attempt++ {
		_, err := s.db.Exec(
			`INSERT INTO service_state (
				id,
				last_studies_refresh_at,
				last_studies_refresh_source,
				last_studies_refresh_url,
				last_studies_refresh_status,
				updated_at
			)
			VALUES (1, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				last_studies_refresh_at = excluded.last_studies_refresh_at,
				last_studies_refresh_source = excluded.last_studies_refresh_source,
				last_studies_refresh_url = excluded.last_studies_refresh_url,
				last_studies_refresh_status = excluded.last_studies_refresh_status,
				updated_at = excluded.updated_at`,
			formatTime(observedAt),
			update.Source,
			update.URL,
			update.StatusCode,
			formatTime(updatedAt),
		)
		if err == nil {
			return nil
		}
		if !isSQLiteBusy(err) || attempt == maxBusyRetries {
			return fmt.Errorf("save service state refresh: %w", err)
		}

		// Short backoff smooths concurrent write bursts from extension events.
		time.Sleep(time.Duration(25*(attempt+1)) * time.Millisecond)
	}
	return nil
}

func (s *ServiceStateStore) GetStudiesRefresh() (*StudiesRefreshState, error) {
	row := s.db.QueryRow(
		`SELECT
			last_studies_refresh_at,
			last_studies_refresh_source,
			last_studies_refresh_url,
			last_studies_refresh_status,
			updated_at
		FROM service_state
		WHERE id = 1`,
	)

	var (
		lastAtText sql.NullString
		source     sql.NullString
		url        sql.NullString
		status     sql.NullInt64
		updatedAt  string
	)
	if err := row.Scan(&lastAtText, &source, &url, &status, &updatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("load service state refresh: %w", err)
	}

	state := &StudiesRefreshState{UpdatedAt: parseTime(updatedAt)}
	if lastAtText.Valid {
		state.LastStudiesRefreshAt = parseTime(lastAtText.String)
	}
	if source.Valid {
		state.LastStudiesRefreshSource = source.String
	}
	if url.Valid {
		state.LastStudiesRefreshURL = url.String
	}
	if status.Valid {
		state.LastStudiesRefreshStatus = int(status.Int64)
	}
	return state, nil
}

func canonicalSubmissionStatus(status string) string {
	normalized := strings.ToUpper(strings.TrimSpace(status))
	normalized = strings.ReplaceAll(normalized, "_", " ")
	normalized = strings.ReplaceAll(normalized, "-", " ")
	for strings.Contains(normalized, "  ") {
		normalized = strings.ReplaceAll(normalized, "  ", " ")
	}
	return strings.TrimSpace(normalized)
}

func normalizedSubmissionPhase(status string) string {
	normalized := canonicalSubmissionStatus(status)
	if phase, ok := submissionStatusPhase[normalized]; ok {
		return phase
	}

	if normalized != "" {
		logWarn(
			"submission.status.unmapped",
			"status",
			status,
			"normalized_status",
			normalized,
			"default_phase",
			SubmissionPhaseSubmitting,
		)
	}

	return SubmissionPhaseSubmitting
}

func (s *SubmissionsStore) UpsertSnapshot(snapshot SubmissionSnapshot, observedAt time.Time) (*SubmissionUpdateResult, error) {
	if strings.TrimSpace(snapshot.SubmissionID) == "" {
		return nil, fmt.Errorf("missing submission_id")
	}

	snapshot.SubmissionID = strings.TrimSpace(snapshot.SubmissionID)
	snapshot.Status = canonicalSubmissionStatus(snapshot.Status)
	if snapshot.Status == "" {
		return nil, fmt.Errorf("missing status")
	}

	snapshot.Phase = normalizedSubmissionPhase(snapshot.Status)
	snapshot.StudyID = strings.TrimSpace(snapshot.StudyID)
	snapshot.StudyName = strings.TrimSpace(snapshot.StudyName)
	snapshot.ParticipantID = strings.TrimSpace(snapshot.ParticipantID)
	if snapshot.StudyID == "" {
		snapshot.StudyID = "unknown"
	}
	if snapshot.StudyName == "" {
		snapshot.StudyName = "Unknown Study"
	}
	if len(snapshot.Payload) == 0 {
		snapshot.Payload = json.RawMessage(`{}`)
	}
	observedAt = utcNowOr(observedAt)

	result := &SubmissionUpdateResult{
		SubmissionID: snapshot.SubmissionID,
		StudyID:      snapshot.StudyID,
		StudyName:    snapshot.StudyName,
		Status:       snapshot.Status,
		Phase:        snapshot.Phase,
		ObservedAt:   observedAt,
	}

	payload := string(snapshot.Payload)
	at := formatTime(observedAt)
	updatedAt := formatTime(time.Now().UTC())

	err := withTx(s.db, func(tx *sql.Tx) error {
		if _, err := tx.Exec(
			`INSERT INTO submissions (
				submission_id, study_id, study_name, participant_id, status, phase, payload_json, observed_at, updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(submission_id) DO UPDATE SET
				study_id = CASE
					WHEN excluded.study_id <> '' AND excluded.study_id <> 'unknown' THEN excluded.study_id
					ELSE submissions.study_id
				END,
				study_name = CASE
					WHEN excluded.study_name <> '' AND excluded.study_name <> 'Unknown Study' THEN excluded.study_name
					ELSE submissions.study_name
				END,
				participant_id = CASE
					WHEN excluded.participant_id <> '' THEN excluded.participant_id
					ELSE submissions.participant_id
				END,
				status = excluded.status,
				phase = excluded.phase,
				payload_json = CASE
					WHEN submissions.phase = excluded.phase
						AND submissions.phase = 'submitted'
						AND (
							json_extract(submissions.payload_json, '$.returned_at') IS NOT NULL
							OR json_extract(submissions.payload_json, '$.completed_at') IS NOT NULL
						)
						AND json_extract(excluded.payload_json, '$.returned_at') IS NULL
						AND json_extract(excluded.payload_json, '$.completed_at') IS NULL
					THEN submissions.payload_json
					ELSE excluded.payload_json
				END,
				observed_at = CASE
					WHEN submissions.phase = excluded.phase
						AND submissions.phase = 'submitted'
					THEN submissions.observed_at
					ELSE excluded.observed_at
				END,
				updated_at = excluded.updated_at`,
			snapshot.SubmissionID,
			snapshot.StudyID,
			snapshot.StudyName,
			snapshot.ParticipantID,
			snapshot.Status,
			snapshot.Phase,
			payload,
			at,
			updatedAt,
		); err != nil {
			return fmt.Errorf("upsert current submission: %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return result, nil
}

func (s *SubmissionsStore) GetCurrentSubmissions(limit int, phase string) ([]SubmissionState, error) {
	limit = clamp(limit, defaultCurrentSubmissions, maxCurrentSubmissions)
	phase = strings.ToLower(strings.TrimSpace(phase))
	if phase == "" {
		phase = "all"
	}
	if phase != "all" && phase != SubmissionPhaseSubmitting && phase != SubmissionPhaseSubmitted {
		return nil, fmt.Errorf("invalid submission phase")
	}

	var (
		rows *sql.Rows
		err  error
	)
	if phase == "all" {
		rows, err = s.db.Query(
			`SELECT submission_id, study_id, study_name, participant_id, status, phase, observed_at, updated_at, payload_json
			 FROM submissions
			 ORDER BY observed_at DESC, submission_id DESC
			 LIMIT ?`,
			limit,
		)
	} else {
		rows, err = s.db.Query(
			`SELECT submission_id, study_id, study_name, participant_id, status, phase, observed_at, updated_at, payload_json
			 FROM submissions
			 WHERE phase = ?
			 ORDER BY observed_at DESC, submission_id DESC
			 LIMIT ?`,
			phase,
			limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("query current submissions: %w", err)
	}
	defer rows.Close()

	submissions := make([]SubmissionState, 0, limit)
	for rows.Next() {
		var (
			state       SubmissionState
			participant sql.NullString
			observedAt  string
			updatedAt   string
			payloadJSON string
		)
		if err := rows.Scan(
			&state.SubmissionID,
			&state.StudyID,
			&state.StudyName,
			&participant,
			&state.Status,
			&state.Phase,
			&observedAt,
			&updatedAt,
			&payloadJSON,
		); err != nil {
			return nil, fmt.Errorf("scan current submission: %w", err)
		}
		if participant.Valid {
			state.ParticipantID = participant.String
		}
		state.ObservedAt = parseTime(observedAt)
		state.UpdatedAt = parseTime(updatedAt)
		state.Payload = json.RawMessage(payloadJSON)
		submissions = append(submissions, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate current submissions: %w", err)
	}
	return submissions, nil
}

type StudyChange struct {
	StudyID string `json:"study_id"`
	Name    string `json:"name"`
}

type StudyAvailabilitySummary struct {
	ObservedAt        time.Time     `json:"observed_at"`
	NewlyAvailable    []StudyChange `json:"newly_available"`
	BecameUnavailable []StudyChange `json:"became_unavailable"`
}

type StudyAvailabilityEvent struct {
	RowID                   int64     `json:"row_id"`
	StudyID                 string    `json:"study_id"`
	StudyName               string    `json:"study_name"`
	EventType               string    `json:"event_type"`
	ObservedAt              time.Time `json:"observed_at"`
	Reward                  apiMoney  `json:"reward"`
	AverageRewardPerHour    apiMoney  `json:"average_reward_per_hour"`
	EstimatedCompletionTime int       `json:"estimated_completion_time"`
	TotalAvailablePlaces    int       `json:"total_available_places"`
	PlacesAvailable         int       `json:"places_available"`
}

func (s *StudiesStore) StoreNormalizedStudies(studies []normalizedStudy, observedAt time.Time) error {
	if len(studies) == 0 {
		return nil
	}
	observedAt = utcNowOr(observedAt)

	return withTx(s.db, func(tx *sql.Tx) error {
		for _, study := range studies {
			payloadJSON, err := json.Marshal(study)
			if err != nil {
				return fmt.Errorf("marshal study %s: %w", study.ID, err)
			}
			payload := string(payloadJSON)
			at := formatTime(observedAt)

			if _, err := tx.Exec(
				`INSERT INTO studies_history (study_id, observed_at, payload_json)
				 VALUES (?, ?, ?)`,
				study.ID,
				at,
				payload,
			); err != nil {
				return fmt.Errorf("insert studies history for %s: %w", study.ID, err)
			}

			if _, err := tx.Exec(
				`INSERT INTO studies_latest (study_id, name, payload_json, last_seen_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(study_id) DO UPDATE SET
				   name = excluded.name,
				   payload_json = excluded.payload_json,
				   last_seen_at = excluded.last_seen_at`,
				study.ID,
				study.Name,
				payload,
				at,
			); err != nil {
				return fmt.Errorf("upsert studies latest for %s: %w", study.ID, err)
			}
		}
		return nil
	})
}

func (s *StudiesStore) ReconcileAvailability(studies []normalizedStudy, observedAt time.Time) (*StudyAvailabilitySummary, error) {
	observedAt = utcNowOr(observedAt)
	current := currentStudyMap(studies)

	var summary *StudyAvailabilitySummary
	err := withTx(s.db, func(tx *sql.Tx) error {
		previous, err := loadActiveSnapshot(tx)
		if err != nil {
			return err
		}

		summary = &StudyAvailabilitySummary{
			ObservedAt:        observedAt,
			NewlyAvailable:    make([]StudyChange, 0),
			BecameUnavailable: make([]StudyChange, 0),
		}

		for id, name := range current {
			if _, exists := previous[id]; exists {
				continue
			}
			change := StudyChange{StudyID: id, Name: name}
			summary.NewlyAvailable = append(summary.NewlyAvailable, change)
			if err := insertAvailabilityEvent(tx, change, "available", observedAt); err != nil {
				return err
			}
		}

		for id, name := range previous {
			if _, exists := current[id]; exists {
				continue
			}
			change := StudyChange{StudyID: id, Name: name}
			summary.BecameUnavailable = append(summary.BecameUnavailable, change)
			if err := insertAvailabilityEvent(tx, change, "unavailable", observedAt); err != nil {
				return err
			}
		}

		if _, err := tx.Exec(`DELETE FROM studies_active_snapshot`); err != nil {
			return fmt.Errorf("clear active snapshot: %w", err)
		}
		for id, name := range current {
			if _, err := tx.Exec(
				`INSERT INTO studies_active_snapshot (study_id, name, last_seen_at)
				 VALUES (?, ?, ?)`,
				id,
				name,
				formatTime(observedAt),
			); err != nil {
				return fmt.Errorf("insert active snapshot for %s: %w", id, err)
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(summary.NewlyAvailable, func(i, j int) bool {
		return summary.NewlyAvailable[i].StudyID < summary.NewlyAvailable[j].StudyID
	})
	sort.Slice(summary.BecameUnavailable, func(i, j int) bool {
		return summary.BecameUnavailable[i].StudyID < summary.BecameUnavailable[j].StudyID
	})
	return summary, nil
}

func (s *StudiesStore) GetRecentAvailabilityEvents(limit int) ([]StudyAvailabilityEvent, error) {
	limit = clamp(limit, defaultRecentEventsLimit, maxRecentEventsLimit)

	rows, err := s.db.Query(
		`SELECT e.row_id, e.study_id, e.study_name, e.event_type, e.observed_at, l.payload_json
		 FROM study_availability_events e
		 LEFT JOIN studies_latest l ON l.study_id = e.study_id
		 ORDER BY row_id DESC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query availability events: %w", err)
	}
	defer rows.Close()

	events := make([]StudyAvailabilityEvent, 0, limit)
	for rows.Next() {
		var event StudyAvailabilityEvent
		var observedAt string
		var payloadJSON sql.NullString
		if err := rows.Scan(&event.RowID, &event.StudyID, &event.StudyName, &event.EventType, &observedAt, &payloadJSON); err != nil {
			return nil, fmt.Errorf("scan availability event: %w", err)
		}
		event.ObservedAt = parseTime(observedAt)

		if payloadJSON.Valid && payloadJSON.String != "" {
			var study normalizedStudy
			if err := json.Unmarshal([]byte(payloadJSON.String), &study); err == nil {
				event.Reward = study.Reward
				event.AverageRewardPerHour = study.AverageRewardPerHour
				event.EstimatedCompletionTime = study.EstimatedCompletionTime
				event.TotalAvailablePlaces = study.TotalAvailablePlaces
				event.PlacesAvailable = study.PlacesAvailable
			}
		}

		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate availability events: %w", err)
	}
	return events, nil
}

func (s *StudiesStore) GetCurrentAvailableStudies(limit int) ([]normalizedStudy, error) {
	limit = clamp(limit, defaultCurrentStudies, maxCurrentStudies)

	rows, err := s.db.Query(
		`SELECT l.payload_json
		 FROM studies_active_snapshot a
		 JOIN studies_latest l ON l.study_id = a.study_id
		 ORDER BY
		   a.last_seen_at ASC,
		   json_extract(l.payload_json, '$.published_at') ASC,
		   json_extract(l.payload_json, '$.date_created') ASC,
		   l.study_id ASC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query current available studies: %w", err)
	}
	defer rows.Close()

	studies := make([]normalizedStudy, 0, limit)
	for rows.Next() {
		var payloadJSON string
		if err := rows.Scan(&payloadJSON); err != nil {
			return nil, fmt.Errorf("scan current available study: %w", err)
		}

		var study normalizedStudy
		if err := json.Unmarshal([]byte(payloadJSON), &study); err != nil {
			return nil, fmt.Errorf("parse current available study payload: %w", err)
		}
		studies = append(studies, study)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate current available studies: %w", err)
	}
	return studies, nil
}

func withTx(db *sql.DB, fn func(*sql.Tx) error) (err error) {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func currentStudyMap(studies []normalizedStudy) map[string]string {
	current := make(map[string]string, len(studies))
	for _, study := range studies {
		if study.ID == "" {
			continue
		}
		current[study.ID] = study.Name
	}
	return current
}

func loadActiveSnapshot(tx *sql.Tx) (map[string]string, error) {
	rows, err := tx.Query(`SELECT study_id, name FROM studies_active_snapshot`)
	if err != nil {
		return nil, fmt.Errorf("query active snapshot: %w", err)
	}
	defer rows.Close()

	previous := map[string]string{}
	for rows.Next() {
		var studyID, name string
		if err := rows.Scan(&studyID, &name); err != nil {
			return nil, fmt.Errorf("scan active snapshot: %w", err)
		}
		previous[studyID] = name
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active snapshot: %w", err)
	}
	return previous, nil
}

func insertAvailabilityEvent(tx *sql.Tx, change StudyChange, eventType string, observedAt time.Time) error {
	_, err := tx.Exec(
		`INSERT INTO study_availability_events (study_id, study_name, event_type, observed_at)
		 VALUES (?, ?, ?, ?)`,
		change.StudyID,
		change.Name,
		eventType,
		formatTime(observedAt),
	)
	if err != nil {
		return fmt.Errorf("insert %s event for %s: %w", eventType, change.StudyID, err)
	}
	return nil
}

func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func parseTime(raw string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func clamp(value, fallback, max int) int {
	if value <= 0 {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}

func isSQLiteBusy(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "sqlbusy") ||
		strings.Contains(msg, "sqlite_busy") ||
		strings.Contains(msg, "database is locked") ||
		strings.Contains(msg, "database is busy")
}

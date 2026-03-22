package main

import (
	"encoding/json"
	"time"
)

type StudiesRefreshState struct {
	LastStudiesRefreshAt     time.Time `json:"last_studies_refresh_at"`
	LastStudiesRefreshSource string    `json:"last_studies_refresh_source,omitempty"`
	LastStudiesRefreshURL    string    `json:"last_studies_refresh_url,omitempty"`
	LastStudiesRefreshStatus int       `json:"last_studies_refresh_status,omitempty"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type StudiesRefreshUpdate struct {
	ObservedAt                time.Time         `json:"observed_at"`
	Source                    string            `json:"source"`
	URL                       string            `json:"url"`
	StatusCode                int               `json:"status_code"`
	NewlyAvailableStudies     []normalizedStudy `json:"newly_available_studies,omitempty"`
	BecameUnavailableStudyIDs []string          `json:"became_unavailable_study_ids,omitempty"`
}

const (
	SubmissionPhaseSubmitting = "submitting"
	SubmissionPhaseSubmitted  = "submitted"
)

type SubmissionSnapshot struct {
	SubmissionID  string          `json:"submission_id"`
	StudyID       string          `json:"study_id"`
	StudyName     string          `json:"study_name"`
	ParticipantID string          `json:"participant_id,omitempty"`
	Status        string          `json:"status"`
	Phase         string          `json:"phase"`
	Payload       json.RawMessage `json:"payload"`
}

type SubmissionState struct {
	SubmissionID  string          `json:"submission_id"`
	StudyID       string          `json:"study_id"`
	StudyName     string          `json:"study_name"`
	ParticipantID string          `json:"participant_id,omitempty"`
	Status        string          `json:"status"`
	Phase         string          `json:"phase"`
	ObservedAt    time.Time       `json:"observed_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	Payload       json.RawMessage `json:"payload,omitempty"`
}

type SubmissionUpdateResult struct {
	SubmissionID string    `json:"submission_id"`
	StudyID      string    `json:"study_id"`
	StudyName    string    `json:"study_name"`
	Status       string    `json:"status"`
	Phase        string    `json:"phase"`
	ObservedAt   time.Time `json:"observed_at"`
}

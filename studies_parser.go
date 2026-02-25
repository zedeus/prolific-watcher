package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

type apiMoney struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

type apiResearcher struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Country string `json:"country"`
}

type apiSubmissionsConfig struct {
	MaxSubmissionsPerParticipant int `json:"max_submissions_per_participant"`
}

type apiPII struct {
	Enabled bool `json:"enabled"`
}

type apiStudiesLink struct {
	Href  *string `json:"href"`
	Title string  `json:"title"`
}

type apiStudiesLinks struct {
	Self     apiStudiesLink `json:"self"`
	Next     apiStudiesLink `json:"next"`
	Previous apiStudiesLink `json:"previous"`
	Last     apiStudiesLink `json:"last"`
}

type apiStudy struct {
	ID                             string               `json:"id"`
	Name                           string               `json:"name"`
	StudyType                      string               `json:"study_type"`
	DateCreated                    string               `json:"date_created"`
	PublishedAt                    string               `json:"published_at"`
	TotalAvailablePlaces           int                  `json:"total_available_places"`
	PlacesTaken                    int                  `json:"places_taken"`
	SubmissionsConfig              apiSubmissionsConfig `json:"submissions_config"`
	StudyReward                    apiMoney             `json:"study_reward"`
	StudyAverageRewardPerHour      apiMoney             `json:"study_average_reward_per_hour"`
	Researcher                     apiResearcher        `json:"researcher"`
	Description                    string               `json:"description"`
	EstimatedCompletionTime        int                  `json:"estimated_completion_time"`
	DeviceCompatibility            []string             `json:"device_compatibility"`
	PeripheralRequirements         []string             `json:"peripheral_requirements"`
	MaximumAllowedTime             int                  `json:"maximum_allowed_time"`
	AverageCompletionTimeInSeconds int                  `json:"average_completion_time_in_seconds"`
	IsConfidential                 bool                 `json:"is_confidential"`
	IsOngoingStudy                 bool                 `json:"is_ongoing_study"`
	SubmissionStartedAt            *string              `json:"submission_started_at"`
	PII                            apiPII               `json:"pii"`
	StudyLabels                    []string             `json:"study_labels"`
	AIInferredStudyLabels          []string             `json:"ai_inferred_study_labels"`
	PreviousSubmissionCount        int                  `json:"previous_submission_count"`
}

type apiStudiesResponse struct {
	Results []apiStudy      `json:"results"`
	Links   apiStudiesLinks `json:"_links"`
}

type normalizedResearcher struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Country string `json:"country"`
}

type normalizedStudy struct {
	ID                             string               `json:"id"`
	Name                           string               `json:"name"`
	StudyType                      string               `json:"study_type"`
	DateCreated                    string               `json:"date_created"`
	PublishedAt                    string               `json:"published_at"`
	TotalAvailablePlaces           int                  `json:"total_available_places"`
	PlacesTaken                    int                  `json:"places_taken"`
	PlacesAvailable                int                  `json:"places_available"`
	Reward                         apiMoney             `json:"reward"`
	AverageRewardPerHour           apiMoney             `json:"average_reward_per_hour"`
	MaxSubmissionsPerParticipant   int                  `json:"max_submissions_per_participant"`
	Researcher                     normalizedResearcher `json:"researcher"`
	Description                    string               `json:"description"`
	EstimatedCompletionTime        int                  `json:"estimated_completion_time"`
	DeviceCompatibility            []string             `json:"device_compatibility"`
	PeripheralRequirements         []string             `json:"peripheral_requirements"`
	MaximumAllowedTime             int                  `json:"maximum_allowed_time"`
	AverageCompletionTimeInSeconds int                  `json:"average_completion_time_in_seconds"`
	IsConfidential                 bool                 `json:"is_confidential"`
	IsOngoingStudy                 bool                 `json:"is_ongoing_study"`
	SubmissionStartedAt            *string              `json:"submission_started_at"`
	PIIEnabled                     bool                 `json:"pii_enabled"`
	StudyLabels                    []string             `json:"study_labels"`
	AIInferredStudyLabels          []string             `json:"ai_inferred_study_labels"`
	PreviousSubmissionCount        int                  `json:"previous_submission_count"`
}

type normalizedStudiesResponse struct {
	Results []normalizedStudy `json:"results"`
	Links   apiStudiesLinks   `json:"_links"`
	Meta    map[string]any    `json:"meta"`
}

func normalizeStudiesResponse(body []byte) (*normalizedStudiesResponse, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}

	resultsRaw, ok := envelope["results"]
	if !ok {
		return nil, fmt.Errorf("studies payload missing results array")
	}
	trimmedResults := bytes.TrimSpace(resultsRaw)
	if len(trimmedResults) == 0 || trimmedResults[0] != '[' {
		return nil, fmt.Errorf("studies payload has non-array results field")
	}

	var raw apiStudiesResponse
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}

	results := make([]normalizedStudy, 0, len(raw.Results))
	for _, study := range raw.Results {
		placesAvailable := study.TotalAvailablePlaces - study.PlacesTaken
		if placesAvailable < 0 {
			placesAvailable = 0
		}

		results = append(results, normalizedStudy{
			ID:          study.ID,
			Name:        study.Name,
			StudyType:   study.StudyType,
			DateCreated: study.DateCreated,
			PublishedAt: study.PublishedAt,

			TotalAvailablePlaces: study.TotalAvailablePlaces,
			PlacesTaken:          study.PlacesTaken,
			PlacesAvailable:      placesAvailable,

			Reward:               study.StudyReward,
			AverageRewardPerHour: study.StudyAverageRewardPerHour,

			MaxSubmissionsPerParticipant: study.SubmissionsConfig.MaxSubmissionsPerParticipant,

			Researcher: normalizedResearcher{
				ID:      study.Researcher.ID,
				Name:    study.Researcher.Name,
				Country: study.Researcher.Country,
			},

			Description:                    study.Description,
			EstimatedCompletionTime:        study.EstimatedCompletionTime,
			DeviceCompatibility:            study.DeviceCompatibility,
			PeripheralRequirements:         study.PeripheralRequirements,
			MaximumAllowedTime:             study.MaximumAllowedTime,
			AverageCompletionTimeInSeconds: study.AverageCompletionTimeInSeconds,

			IsConfidential:      study.IsConfidential,
			IsOngoingStudy:      study.IsOngoingStudy,
			SubmissionStartedAt: study.SubmissionStartedAt,
			PIIEnabled:          study.PII.Enabled,

			StudyLabels:           study.StudyLabels,
			AIInferredStudyLabels: study.AIInferredStudyLabels,

			PreviousSubmissionCount: study.PreviousSubmissionCount,
		})
	}

	normalized := normalizedStudiesResponse{
		Results: results,
		Links:   raw.Links,
		Meta: map[string]any{
			"count": len(results),
		},
	}

	return &normalized, nil
}

package main

import (
	"net/http"
)

func normalizeURLOrAPIError(raw string, normalize func(string) (string, bool), message string) (string, error) {
	normalizedURL, ok := normalize(raw)
	if !ok {
		return "", badRequest(message, nil)
	}
	return normalizedURL, nil
}

func requireNonEmptyJSONBody(body []byte) error {
	if len(body) > 0 {
		return nil
	}
	return badRequest("body cannot be empty", nil)
}

func (s *Service) processReceiveStudiesRefresh(payload StudiesRefreshUpdate) (map[string]any, error) {
	if payload.URL != "" {
		normalizedURL, err := normalizeURLOrAPIError(
			payload.URL,
			normalizeStudiesCollectionURL,
			"url must target internal studies endpoint",
		)
		if err != nil {
			return nil, err
		}
		payload.URL = normalizedURL
	}

	if err := s.markStudiesRefresh(payload); err != nil {
		logWarn("studies.refresh.persist_failed", "error", err)
		return nil, internalServerError("failed to persist studies refresh", err)
	}

	logInfo("studies.refresh.received", "source", payload.Source, "status_code", payload.StatusCode, "url", payload.URL, "observed_at", payload.ObservedAt)
	return map[string]any{"success": true}, nil
}

func (s *Service) processReceiveStudiesResponse(payload interceptedStudiesResponsePayload) (map[string]any, error) {
	normalizedURL, err := normalizeURLOrAPIError(
		payload.URL,
		normalizeStudiesCollectionURL,
		"url must target internal studies endpoint",
	)
	if err != nil {
		return nil, err
	}
	payload.URL = normalizedURL

	if err := requireNonEmptyJSONBody(payload.Body); err != nil {
		return nil, err
	}

	if payload.StatusCode != 0 && payload.StatusCode != http.StatusOK {
		if err := s.markStudiesRefresh(StudiesRefreshUpdate{
			ObservedAt: payload.ObservedAt,
			Source:     "extension.intercepted_response",
			URL:        payload.URL,
			StatusCode: payload.StatusCode,
		}); err != nil {
			return nil, internalServerError("failed to persist studies refresh status", err)
		}
		return map[string]any{"success": true}, nil
	}

	normalized, availability, err := s.ingestStudiesPayload(payload.Body, payload.ObservedAt, "extension.intercepted_response", payload.URL, http.StatusOK)
	if err != nil {
		logWarn("studies.response.ingest_failed", "source", "extension.intercepted_response", "url", payload.URL, "error", err)
		return nil, badRequest("failed to ingest studies response", err)
	}

	response := map[string]any{"success": true, "meta": map[string]any{"count": len(normalized.Results)}}
	if availability != nil {
		response["changes"] = availability
	}

	logInfo("studies.response.ingested", "source", "extension.intercepted_response", "count", len(normalized.Results), "url", payload.URL)
	return response, nil
}

func (s *Service) processReceiveSubmissionResponse(payload interceptedSubmissionResponsePayload) (map[string]any, error) {
	if s.submissionsStore == nil {
		return nil, serviceUnavailable("submissions store not configured", nil)
	}

	normalizedURL, err := normalizeURLOrAPIError(
		payload.URL,
		normalizeSubmissionURL,
		"url must target internal submissions endpoint",
	)
	if err != nil {
		return nil, err
	}
	payload.URL = normalizedURL

	if err := requireNonEmptyJSONBody(payload.Body); err != nil {
		return nil, err
	}

	observedAt := utcNowOr(payload.ObservedAt)
	update, err := s.ingestSubmissionPayload(payload.Body, observedAt)
	if err != nil {
		logWarn("submission.response.ingest_failed", "source", "extension.intercepted_submission_response", "url", payload.URL, "error", err)
		return nil, badRequest("failed to ingest submission response", err)
	}

	logInfo(
		"submission.response.ingested",
		"source", "extension.intercepted_submission_response",
		"url", payload.URL,
		"submission_id", update.SubmissionID,
		"study_id", update.StudyID,
		"status", update.Status,
		"phase", update.Phase,
	)
	return map[string]any{
		"success":    true,
		"submission": update,
	}, nil
}

func (s *Service) processReceiveParticipantSubmissionsResponse(payload interceptedParticipantSubmissionsResponsePayload) (map[string]any, error) {
	if s.submissionsStore == nil {
		return nil, serviceUnavailable("submissions store not configured", nil)
	}

	normalizedURL, err := normalizeURLOrAPIError(
		payload.URL,
		normalizeParticipantSubmissionsURL,
		"url must target participant submissions endpoint",
	)
	if err != nil {
		return nil, err
	}
	payload.URL = normalizedURL

	if err := requireNonEmptyJSONBody(payload.Body); err != nil {
		return nil, err
	}
	if payload.StatusCode != 0 && payload.StatusCode != http.StatusOK {
		return map[string]any{"success": true, "ignored": true, "status_code": payload.StatusCode}, nil
	}

	total, upserted, err := s.ingestParticipantSubmissionsPayload(
		payload.Body,
		utcNowOr(payload.ObservedAt),
	)
	if err != nil {
		logWarn("participant.submissions.ingest_failed", "source", "extension.intercepted_participant_submissions_response", "url", payload.URL, "error", err)
		return nil, badRequest("failed to ingest participant submissions response", err)
	}

	logInfo(
		"participant.submissions.ingested",
		"source", "extension.intercepted_participant_submissions_response",
		"url", payload.URL,
		"total", total,
		"upserted", upserted,
	)
	return map[string]any{
		"success": true,
		"meta": map[string]any{
			"total":    total,
			"upserted": upserted,
		},
	}, nil
}

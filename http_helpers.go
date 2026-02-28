package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string, detail error) {
	payload := map[string]any{"error": message}
	if detail != nil {
		payload["detail"] = detail.Error()
	}
	writeJSON(w, status, payload)
}

func setExtensionCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func parseIntQuery(r *http.Request, key string, fallback, min, max int) (int, error) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback, nil
	}

	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if parsed < min {
		parsed = min
	}
	if parsed > max {
		parsed = max
	}
	return parsed, nil
}

func utcNowOr(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t.UTC()
}

func maskToken(token string) string {
	if len(token) <= 12 {
		return "***"
	}
	return token[:8] + "..." + token[len(token)-4:]
}

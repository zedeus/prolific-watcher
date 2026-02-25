package main

import "time"

// StoredToken is the token payload accepted from the browser extension.
type StoredToken struct {
	AccessToken string    `json:"access_token"`
	TokenType   string    `json:"token_type,omitempty"`
	Key         string    `json:"key,omitempty"`
	Origin      string    `json:"origin,omitempty"`
	BrowserInfo string    `json:"browser_info,omitempty"`
	ReceivedAt  time.Time `json:"received_at"`
}

type CapturedHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type StudiesHeadersCapture struct {
	URL        string           `json:"url"`
	Method     string           `json:"method"`
	Headers    []CapturedHeader `json:"headers"`
	CapturedAt time.Time        `json:"captured_at"`
}

type StudiesRefreshState struct {
	LastStudiesRefreshAt     time.Time `json:"last_studies_refresh_at"`
	LastStudiesRefreshSource string    `json:"last_studies_refresh_source,omitempty"`
	LastStudiesRefreshURL    string    `json:"last_studies_refresh_url,omitempty"`
	LastStudiesRefreshStatus int       `json:"last_studies_refresh_status,omitempty"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type StudiesRefreshUpdate struct {
	ObservedAt           time.Time             `json:"observed_at"`
	Source               string                `json:"source"`
	URL                  string                `json:"url"`
	StatusCode           int                   `json:"status_code"`
	DelayedRefreshPolicy *DelayedRefreshPolicy `json:"delayed_refresh_policy,omitempty"`
}

type DelayedRefreshPolicy struct {
	MinimumDelaySeconds int `json:"minimum_delay_seconds"`
	AverageDelaySeconds int `json:"average_delay_seconds"`
	SpreadSeconds       int `json:"spread_seconds,omitempty"`
	CycleSeconds        int `json:"cycle_seconds,omitempty"`
}

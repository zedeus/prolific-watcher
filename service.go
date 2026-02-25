package main

import (
	"math/rand"
	"net/http"
	"sync"
	"time"
)

type Service struct {
	tokenStore   *TokenStore
	headersStore *StudiesHeaderStore
	studiesStore *StudiesStore
	stateStore   *ServiceStateStore
	stream       *EventStream

	autoRefreshMu     sync.Mutex
	autoRefreshTimers []*time.Timer
	autoRefreshRand   *rand.Rand
	autoRefreshGen    uint64

	refreshGuardMu           sync.Mutex
	upstreamRefreshInFlight  bool
	lastUpstreamRefreshStart time.Time
}

func NewService(
	tokenStore *TokenStore,
	headersStore *StudiesHeaderStore,
	studiesStore *StudiesStore,
	stateStore *ServiceStateStore,
) *Service {
	return &Service{
		tokenStore:      tokenStore,
		headersStore:    headersStore,
		studiesStore:    studiesStore,
		stateStore:      stateStore,
		stream:          NewEventStream(),
		autoRefreshRand: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/", s.handleHome)
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/token", s.handleToken)
	mux.HandleFunc("/studies-headers", s.handleStudiesHeaders)
	s.registerExtensionRoute(mux, "/receive-token", http.MethodPost, s.handleReceiveToken)
	s.registerExtensionRoute(mux, "/clear-token", http.MethodPost, s.handleClearToken)
	s.registerExtensionRoute(mux, "/receive-studies-headers", http.MethodPost, s.handleReceiveStudiesHeaders)
	s.registerExtensionRoute(mux, "/receive-studies-refresh", http.MethodPost, s.handleReceiveStudiesRefresh)
	s.registerExtensionRoute(mux, "/receive-studies-response", http.MethodPost, s.handleReceiveStudiesResponse)
	s.registerExtensionRoute(mux, "/schedule-delayed-refresh", http.MethodPost, s.handleScheduleDelayedRefresh)
	s.registerExtensionRoute(mux, "/studies-refresh", http.MethodGet, s.handleStudiesRefresh)
	s.registerExtensionRoute(mux, "/studies-live", http.MethodGet, s.handleStudiesLive)
	s.registerExtensionRoute(mux, "/studies/refresh", http.MethodPost, s.handleStudiesForceRefresh)
	s.registerExtensionRoute(mux, "/events/stream", http.MethodGet, s.handleEventsStream)
	s.registerExtensionRoute(mux, "/study-events", http.MethodGet, s.handleStudyEvents)
	s.registerExtensionRoute(mux, "/studies", http.MethodGet, s.handleStudies)
}

func (s *Service) registerExtensionRoute(mux *http.ServeMux, path, method string, handler http.HandlerFunc) {
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		setExtensionCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != method {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
			return
		}
		handler(w, r)
	})
}

package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type Service struct {
	studiesStore     *StudiesStore
	submissionsStore *SubmissionsStore
	stateStore       *ServiceStateStore

	wsClientsMu  sync.Mutex
	wsClientsSet map[*wsConnClient]struct{}

	extensionDebugStateMu   sync.Mutex
	extensionDebugState     json.RawMessage
	extensionDebugStateAt   time.Time
}

func NewService(
	studiesStore *StudiesStore,
	submissionsStore *SubmissionsStore,
	stateStore *ServiceStateStore,
) *Service {
	return &Service{
		studiesStore:     studiesStore,
		submissionsStore: submissionsStore,
		stateStore:       stateStore,
		wsClientsSet:     make(map[*wsConnClient]struct{}),
	}
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/", s.handleHome)
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/status", s.handleStatus)
	s.registerExtensionRoute(mux, "/studies-refresh", http.MethodGet, s.handleStudiesRefresh)
	s.registerExtensionRoute(mux, "/ws", http.MethodGet, s.handleExtensionWebSocket)
	s.registerExtensionRoute(mux, "/study-events", http.MethodGet, s.handleStudyEvents)
	s.registerExtensionRoute(mux, "/studies", http.MethodGet, s.handleStudies)
	s.registerExtensionRoute(mux, "/submissions", http.MethodGet, s.handleSubmissions)
	s.registerExtensionRoute(mux, "/debug/extension-state", http.MethodGet, s.handleDebugExtensionState)
	s.registerExtensionRoute(mux, "/debug/open-popup-tab", http.MethodPost, s.handleDebugOpenPopupTab)
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

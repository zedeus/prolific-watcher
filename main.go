package main

import (
	"net/http"
	"os"
)

func main() {
	db, err := openSQLite(sqliteDBPath)
	if err != nil {
		logError("service.start_failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	tokenStore := NewTokenStore(db)
	headersStore := NewStudiesHeaderStore(db)
	studiesStore := NewStudiesStore(db)
	submissionsStore := NewSubmissionsStore(db)
	stateStore := NewServiceStateStore(db)

	service := NewService(tokenStore, headersStore, studiesStore, submissionsStore, stateStore)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	logInfo("service.start", "listen_addr", listenAddr, "sqlite_db", sqliteDBPath)
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
		logError("service.exit", "error", err)
		os.Exit(1)
	}
}

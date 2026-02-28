package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

func openSQLite(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// SQLite supports one writer at a time. Keeping a single shared connection
	// avoids intra-process write contention that can surface as SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)

	if err := execStatements(db,
		`PRAGMA journal_mode=WAL;`,
		`PRAGMA foreign_keys=ON;`,
		`PRAGMA busy_timeout=15000;`,
	); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("configure sqlite pragmas: %w", err)
	}

	if err := applyMigrations(db); err != nil {
		_ = db.Close()
		return nil, err
	}

	return db, nil
}

func applyMigrations(db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS token_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			access_token TEXT NOT NULL,
			token_type TEXT NOT NULL,
			storage_key TEXT,
			origin TEXT,
			browser_info TEXT,
			received_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS studies_headers_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			url TEXT NOT NULL,
			method TEXT NOT NULL,
			headers_json TEXT NOT NULL,
			captured_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS studies_latest (
			study_id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS studies_history (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			study_id TEXT NOT NULL,
			observed_at TEXT NOT NULL,
			payload_json TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS studies_active_snapshot (
			study_id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS study_availability_events (
			row_id INTEGER PRIMARY KEY AUTOINCREMENT,
			study_id TEXT NOT NULL,
			study_name TEXT NOT NULL,
			event_type TEXT NOT NULL CHECK (event_type IN ('available', 'unavailable')),
			observed_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS service_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			last_studies_refresh_at TEXT,
			last_studies_refresh_source TEXT,
			last_studies_refresh_url TEXT,
			last_studies_refresh_status INTEGER,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS submissions (
			submission_id TEXT PRIMARY KEY,
			study_id TEXT NOT NULL,
			study_name TEXT NOT NULL,
			participant_id TEXT,
			status TEXT NOT NULL,
			phase TEXT NOT NULL CHECK (phase IN ('submitting', 'submitted')),
			payload_json TEXT NOT NULL,
			observed_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE INDEX IF NOT EXISTS idx_studies_history_study_id ON studies_history(study_id);`,
		`CREATE INDEX IF NOT EXISTS idx_studies_history_observed_at ON studies_history(observed_at);`,
		`CREATE INDEX IF NOT EXISTS idx_study_availability_events_study_id ON study_availability_events(study_id);`,
		`CREATE INDEX IF NOT EXISTS idx_study_availability_events_observed_at ON study_availability_events(observed_at);`,
		`CREATE INDEX IF NOT EXISTS idx_submissions_phase ON submissions(phase);`,
		`CREATE INDEX IF NOT EXISTS idx_submissions_observed_at ON submissions(observed_at);`,
	}

	if err := execStatements(db, statements...); err != nil {
		return fmt.Errorf("apply migration: %w", err)
	}

	return nil
}

func execStatements(db *sql.DB, statements ...string) error {
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

package main

const (
	listenAddr   = ":8080"
	sqliteDBPath = "prolific_watcher.db"

	internalStudiesURL                 = "https://internal-api.prolific.com/api/v1/participant/studies/"
	internalStudiesHost                = "internal-api.prolific.com"
	internalStudiesPath                = "/api/v1/participant/studies/"
	internalParticipantSubmissionsPath = "/api/v1/participant/submissions/"
	frontendOrigin                     = "https://app.prolific.com"
	frontendReferer                    = "https://app.prolific.com/"

	internalClientVersion = "1ff599f2"
)

package main

import (
	"net/http"
)

type apiError struct {
	status  int
	message string
	detail  error
}

func (e *apiError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func badRequest(message string, detail error) *apiError {
	return &apiError{status: http.StatusBadRequest, message: message, detail: detail}
}

func serviceUnavailable(message string, detail error) *apiError {
	return &apiError{status: http.StatusServiceUnavailable, message: message, detail: detail}
}

func internalServerError(message string, detail error) *apiError {
	return &apiError{status: http.StatusInternalServerError, message: message, detail: detail}
}

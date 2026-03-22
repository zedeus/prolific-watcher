package main

type apiError struct {
	message string
}

func (e *apiError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func badRequest(message string, _ error) *apiError {
	return &apiError{message: message}
}

func serviceUnavailable(message string, _ error) *apiError {
	return &apiError{message: message}
}

func internalServerError(message string, _ error) *apiError {
	return &apiError{message: message}
}

package main

import (
	"net/url"
	"strings"
)

func normalizeStudiesCollectionURL(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}

	if !strings.EqualFold(u.Scheme, "https") {
		return "", false
	}
	if !strings.EqualFold(u.Host, internalStudiesHost) {
		return "", false
	}

	path := strings.TrimRight(u.Path, "/")
	if path != strings.TrimRight(internalStudiesPath, "/") {
		return "", false
	}

	u.Path = internalStudiesPath
	u.RawPath = ""
	return u.String(), true
}

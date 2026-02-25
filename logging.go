package main

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

func logInfo(event string, kv ...any) {
	logWithLevel("info", event, kv...)
}

func logWarn(event string, kv ...any) {
	logWithLevel("warn", event, kv...)
}

func logError(event string, kv ...any) {
	logWithLevel("error", event, kv...)
}

func logWithLevel(level, event string, kv ...any) {
	var b strings.Builder
	b.WriteString("level=")
	b.WriteString(level)
	b.WriteString(" event=")
	b.WriteString(event)

	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		b.WriteString(" ")
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(formatLogValue(kv[i+1]))
	}

	if len(kv)%2 == 1 {
		b.WriteString(" extra=")
		b.WriteString(formatLogValue(kv[len(kv)-1]))
	}

	log.Print(b.String())
}

func formatLogValue(v any) string {
	switch t := v.(type) {
	case time.Time:
		if t.IsZero() {
			return "0"
		}
		return t.UTC().Format(time.RFC3339Nano)
	case error:
		if t == nil {
			return `""`
		}
		return strconv.Quote(t.Error())
	}

	s := fmt.Sprintf("%v", v)
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, " \t\r\n\"=") {
		return strconv.Quote(s)
	}
	return s
}

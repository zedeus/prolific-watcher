package main

import (
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"time"

	azuretls "github.com/Noooste/azuretls-client"
)

const (
	delayedRefreshSource                   = "service.delayed_after_extension"
	defaultDelayedRefreshCycleSeconds      = 120
	defaultDelayedRefreshMinimumSeconds    = 20
	defaultDelayedRefreshAverageSeconds    = 30
	defaultDelayedRefreshSpreadSeconds     = 0
	minAllowedDelayedRefreshMinimumSeconds = 1
	minAllowedDelayedRefreshAverageSeconds = 5
	maxAllowedDelayedRefreshMinimumSeconds = 60
	maxAllowedDelayedRefreshAverageSeconds = 60
	maxAllowedDelayedRefreshSpreadSeconds  = 60
	defaultUpstreamRefreshMinGap           = 5 * time.Second
)

func shouldScheduleDelayedRefresh(source string, statusCode int) bool {
	return statusCode == http.StatusOK && strings.HasPrefix(source, "extension.")
}

func normalizeDelayedRefreshPolicy(raw *DelayedRefreshPolicy) DelayedRefreshPolicy {
	cfg := DelayedRefreshPolicy{
		MinimumDelaySeconds: defaultDelayedRefreshMinimumSeconds,
		AverageDelaySeconds: defaultDelayedRefreshAverageSeconds,
		SpreadSeconds:       defaultDelayedRefreshSpreadSeconds,
		CycleSeconds:        defaultDelayedRefreshCycleSeconds,
	}
	if raw != nil {
		if raw.MinimumDelaySeconds > 0 {
			cfg.MinimumDelaySeconds = raw.MinimumDelaySeconds
		}
		if raw.AverageDelaySeconds > 0 {
			cfg.AverageDelaySeconds = raw.AverageDelaySeconds
		}
		if raw.CycleSeconds > 0 {
			cfg.CycleSeconds = raw.CycleSeconds
		}
		if raw.SpreadSeconds > 0 {
			cfg.SpreadSeconds = raw.SpreadSeconds
		}
	}

	if cfg.CycleSeconds < 2 {
		cfg.CycleSeconds = defaultDelayedRefreshCycleSeconds
	}
	if cfg.AverageDelaySeconds < minAllowedDelayedRefreshAverageSeconds {
		cfg.AverageDelaySeconds = minAllowedDelayedRefreshAverageSeconds
	}
	if cfg.AverageDelaySeconds > maxAllowedDelayedRefreshAverageSeconds {
		cfg.AverageDelaySeconds = maxAllowedDelayedRefreshAverageSeconds
	}

	calculatedCycleSeconds := calculatedCycleSecondsFromAverage(cfg.CycleSeconds, cfg.AverageDelaySeconds)

	maxMinimum := calculatedCycleSeconds / 2
	if maxMinimum < minAllowedDelayedRefreshMinimumSeconds {
		maxMinimum = minAllowedDelayedRefreshMinimumSeconds
	}
	if maxMinimum > maxAllowedDelayedRefreshMinimumSeconds {
		maxMinimum = maxAllowedDelayedRefreshMinimumSeconds
	}
	if cfg.MinimumDelaySeconds < minAllowedDelayedRefreshMinimumSeconds {
		cfg.MinimumDelaySeconds = minAllowedDelayedRefreshMinimumSeconds
	}
	if cfg.MinimumDelaySeconds > maxMinimum {
		cfg.MinimumDelaySeconds = maxMinimum
	}

	if cfg.SpreadSeconds < 0 {
		cfg.SpreadSeconds = 0
	}
	maxSpread := calculatedCycleSeconds / 2
	if maxSpread > maxAllowedDelayedRefreshSpreadSeconds {
		maxSpread = maxAllowedDelayedRefreshSpreadSeconds
	}
	if cfg.SpreadSeconds > maxSpread {
		cfg.SpreadSeconds = maxSpread
	}

	return cfg
}

func calculatedCycleSecondsFromAverage(cycleSeconds, averageDelaySeconds int) int {
	if cycleSeconds < 1 {
		cycleSeconds = defaultDelayedRefreshCycleSeconds
	}
	if averageDelaySeconds < 1 {
		averageDelaySeconds = defaultDelayedRefreshAverageSeconds
	}

	countByAverage := (cycleSeconds / averageDelaySeconds) - 1
	if countByAverage < 0 {
		countByAverage = 0
	}
	segments := countByAverage + 1
	if segments < 1 {
		segments = 1
	}

	calculated := cycleSeconds / segments
	if calculated < 1 {
		calculated = 1
	}
	return calculated
}

func planDelayedRefreshCount(cfg DelayedRefreshPolicy) int {
	maxByMinimum := (cfg.CycleSeconds / cfg.MinimumDelaySeconds) - 1
	maxByAverage := (cfg.CycleSeconds / cfg.AverageDelaySeconds) - 1

	count := maxByMinimum
	if maxByAverage < count {
		count = maxByAverage
	}

	if count < 0 {
		return 0
	}
	return count
}

type randomFloatSource interface {
	Float64() float64
}

type defaultRandomFloatSource struct{}

func (defaultRandomFloatSource) Float64() float64 {
	return rand.Float64()
}

func planDelayedRefreshSchedule(cfg DelayedRefreshPolicy, rnd randomFloatSource) []time.Duration {
	count := planDelayedRefreshCount(cfg)
	if count <= 0 {
		return nil
	}
	if rnd == nil {
		rnd = defaultRandomFloatSource{}
	}

	cycleSeconds := float64(cfg.CycleSeconds)
	minGapSeconds := float64(cfg.MinimumDelaySeconds)
	spreadSeconds := float64(cfg.SpreadSeconds)
	segments := float64(count + 1)

	centers := make([]float64, count)
	for i := 0; i < count; i++ {
		centers[i] = (cycleSeconds * float64(i+1)) / segments
	}

	lows := make([]float64, count)
	highs := make([]float64, count)
	for i := 0; i < count; i++ {
		low := centers[i] - spreadSeconds
		high := centers[i] + spreadSeconds

		minByBoundary := float64(i+1) * minGapSeconds
		maxByBoundary := cycleSeconds - float64(count-i)*minGapSeconds
		if low < minByBoundary {
			low = minByBoundary
		}
		if high > maxByBoundary {
			high = maxByBoundary
		}

		lows[i] = low
		highs[i] = high
	}

	for i := 1; i < count; i++ {
		minAllowed := lows[i-1] + minGapSeconds
		if lows[i] < minAllowed {
			lows[i] = minAllowed
		}
	}

	for i := count - 2; i >= 0; i-- {
		maxAllowed := highs[i+1] - minGapSeconds
		if highs[i] > maxAllowed {
			highs[i] = maxAllowed
		}
	}

	for i := 0; i < count; i++ {
		if lows[i] > highs[i] {
			delays := make([]time.Duration, 0, count)
			for _, center := range centers {
				delays = append(delays, time.Duration(center*float64(time.Second)))
			}
			return delays
		}
	}

	chosen := make([]float64, count)
	for i := 0; i < count; i++ {
		low := lows[i]
		if i > 0 {
			minAllowed := chosen[i-1] + minGapSeconds
			if low < minAllowed {
				low = minAllowed
			}
		}
		high := highs[i]
		if low > high {
			low = high
		}

		if high <= low {
			chosen[i] = low
			continue
		}

		// Pick a whole-second schedule point inside the feasible window so spread
		// produces visibly different cadence in logs/UI.
		lowInt := int(math.Ceil(low))
		highInt := int(math.Floor(high))
		if lowInt > highInt {
			chosen[i] = low
			continue
		}
		if i > 0 {
			prevFloor := int(math.Floor(chosen[i-1]))
			minAllowedInt := prevFloor + cfg.MinimumDelaySeconds
			if lowInt < minAllowedInt {
				lowInt = minAllowedInt
			}
			if lowInt > highInt {
				chosen[i] = float64(highInt)
				continue
			}
		}

		span := highInt - lowInt + 1
		pick := lowInt
		if span > 1 {
			offset := int(math.Floor(rnd.Float64() * float64(span)))
			if offset < 0 {
				offset = 0
			}
			if offset >= span {
				offset = span - 1
			}
			pick = lowInt + offset
		}

		chosen[i] = float64(pick)
	}

	delays := make([]time.Duration, 0, count)
	for _, seconds := range chosen {
		delays = append(delays, time.Duration(seconds*float64(time.Second)))
	}
	return delays
}

func (s *Service) scheduleDelayedServiceRefresh(triggerSource string, policy *DelayedRefreshPolicy) {
	cfg := normalizeDelayedRefreshPolicy(policy)
	now := time.Now().UTC()

	s.autoRefreshMu.Lock()
	s.autoRefreshGen++
	currentGen := s.autoRefreshGen

	for _, timer := range s.autoRefreshTimers {
		if timer != nil {
			timer.Stop()
		}
	}

	delays := planDelayedRefreshSchedule(cfg, s.autoRefreshRand)
	s.autoRefreshTimers = make([]*time.Timer, 0, len(delays))
	for idx, delay := range delays {
		runIndex := idx + 1
		runTotal := len(delays)
		timer := time.AfterFunc(delay, func() {
			if !s.isCurrentAutoRefreshGeneration(currentGen) {
				return
			}
			if err := s.runDelayedServiceRefresh(triggerSource, cfg, runIndex, runTotal); err != nil {
				logWarn(
					"refresh.delayed.failed",
					"trigger_source", triggerSource,
					"run_index", runIndex,
					"run_total", runTotal,
					"error", err,
				)
			}
		})
		s.autoRefreshTimers = append(s.autoRefreshTimers, timer)
	}
	s.autoRefreshMu.Unlock()

	fireTimes := make([]string, 0, len(delays))
	for _, delay := range delays {
		fireTimes = append(fireTimes, now.Add(delay).Format(time.RFC3339Nano))
	}

	logInfo(
		"refresh.delayed.schedule",
		"source", delayedRefreshSource,
		"trigger_source", triggerSource,
		"count", len(delays),
		"minimum_delay_seconds", cfg.MinimumDelaySeconds,
		"average_delay_seconds", cfg.AverageDelaySeconds,
		"spread_seconds", cfg.SpreadSeconds,
		"cycle_seconds", cfg.CycleSeconds,
		"fire_at", strings.Join(fireTimes, ","),
	)
}

func (s *Service) cancelDelayedServiceRefresh(reason string) {
	s.autoRefreshMu.Lock()
	s.autoRefreshGen++
	stopped := len(s.autoRefreshTimers)
	for _, timer := range s.autoRefreshTimers {
		if timer != nil {
			timer.Stop()
		}
	}
	s.autoRefreshTimers = nil
	s.autoRefreshMu.Unlock()

	logInfo("refresh.delayed.cleared", "reason", reason, "stopped", stopped)
}

func (s *Service) canScheduleDelayedRefresh() (bool, error) {
	if s.tokenStore == nil {
		return false, nil
	}
	token, err := s.tokenStore.Get()
	if err != nil {
		return false, fmt.Errorf("load token state: %w", err)
	}
	return token != nil, nil
}

func (s *Service) isCurrentAutoRefreshGeneration(generation uint64) bool {
	s.autoRefreshMu.Lock()
	defer s.autoRefreshMu.Unlock()
	return s.autoRefreshGen == generation
}

func (s *Service) resolveStudiesRefreshInputs() (*StoredToken, *StudiesHeadersCapture, string, error) {
	token, err := s.tokenStore.Get()
	if err != nil {
		return nil, nil, "", fmt.Errorf("load token state: %w", err)
	}
	if token == nil {
		return nil, nil, "", fmt.Errorf("not authenticated: extension token sync required")
	}

	capture, err := s.headersStore.Get()
	if err != nil {
		return nil, nil, "", fmt.Errorf("load studies headers state: %w", err)
	}

	targetURL := internalStudiesURL
	if capture != nil {
		if normalizedURL, ok := normalizeStudiesCollectionURL(capture.URL); ok {
			targetURL = normalizedURL
		}
	}

	return token, capture, targetURL, nil
}

func (s *Service) runDelayedServiceRefresh(triggerSource string, policy DelayedRefreshPolicy, runIndex, runTotal int) error {
	minGap := time.Duration(policy.MinimumDelaySeconds) * time.Second
	acquired, retryAfter := s.acquireUpstreamRefreshSlot(minGap)
	if !acquired {
		logInfo(
			"refresh.delayed.skipped_guard",
			"trigger_source", triggerSource,
			"run_index", runIndex,
			"run_total", runTotal,
			"retry_after", retryAfter,
		)
		return nil
	}
	defer s.releaseUpstreamRefreshSlot()

	token, capture, targetURL, err := s.resolveStudiesRefreshInputs()
	if err != nil {
		return err
	}

	session := azuretls.NewSession()
	defer session.Close()

	resp, err := session.Get(targetURL, buildStudiesHeaders(token, capture), 30*time.Second)
	if err != nil {
		return fmt.Errorf("request to prolific failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		if err := s.markStudiesRefresh(time.Now().UTC(), delayedRefreshSource, targetURL, resp.StatusCode); err != nil {
			logWarn("refresh.delayed.persist_status_failed", "error", err)
		}
		return fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	observedAt := time.Now().UTC()
	normalizedBody, _, err := s.ingestStudiesPayload(resp.Body, observedAt, delayedRefreshSource, targetURL, resp.StatusCode)
	if err != nil {
		return fmt.Errorf("ingest delayed studies response: %w", err)
	}

	logInfo(
		"refresh.delayed.completed",
		"trigger_source", triggerSource,
		"run_index", runIndex,
		"run_total", runTotal,
		"count", len(normalizedBody.Results),
		"target", targetURL,
		"observed_at", observedAt,
	)
	return nil
}

func (s *Service) acquireUpstreamRefreshSlot(minGap time.Duration) (bool, time.Duration) {
	s.refreshGuardMu.Lock()
	defer s.refreshGuardMu.Unlock()

	if minGap < defaultUpstreamRefreshMinGap {
		minGap = defaultUpstreamRefreshMinGap
	}

	if s.upstreamRefreshInFlight {
		return false, time.Second
	}

	now := time.Now().UTC()
	if !s.lastUpstreamRefreshStart.IsZero() {
		since := now.Sub(s.lastUpstreamRefreshStart)
		if since < minGap {
			retryAfter := minGap - since
			if retryAfter < time.Second {
				retryAfter = time.Second
			}
			return false, retryAfter
		}
	}

	s.upstreamRefreshInFlight = true
	s.lastUpstreamRefreshStart = now
	return true, 0
}

func (s *Service) releaseUpstreamRefreshSlot() {
	s.refreshGuardMu.Lock()
	s.upstreamRefreshInFlight = false
	s.refreshGuardMu.Unlock()
}

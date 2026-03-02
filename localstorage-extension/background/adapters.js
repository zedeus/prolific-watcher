(() => {
  const root = globalThis.ProlificWatcherModules = globalThis.ProlificWatcherModules || {};

  function createPriorityAdapters(options) {
    const {
      nowIso,
      extractStudiesResults,
      normalizeStudyIDList
    } = options;

    function extractPrioritySnapshotEventFromStudiesRefreshMessage(parsed, extractObservedAtFn) {
      const observedAt = typeof extractObservedAtFn === "function"
        ? extractObservedAtFn(parsed)
        : nowIso();
      const data = parsed && typeof parsed.data === "object" && parsed.data
        ? parsed.data
        : {};
      const source = typeof data.source === "string" ? data.source.trim() : "";
      const studies = Array.isArray(data.newly_available_studies)
        ? data.newly_available_studies
        : [];
      const removedStudyIDs = normalizeStudyIDList(data.became_unavailable_study_ids);
      const triggerParts = [
        "service.ws.studies_refresh_event",
        source ? `source=${source}` : "",
        observedAt ? `observed_at=${observedAt}` : ""
      ].filter(Boolean);
      return {
        mode: "delta",
        trigger: triggerParts.join(" "),
        observedAt,
        studies,
        removedStudyIDs
      };
    }

    function toFullSnapshotEvent(parsed, context) {
      const studies = extractStudiesResults(parsed);
      if (!studies) {
        return null;
      }
      return {
        mode: "full",
        trigger: context && context.normalizedURL
          ? String(context.normalizedURL)
          : "studies.response.capture",
        observedAt: context && context.observedAt ? context.observedAt : nowIso(),
        studies,
        removedStudyIDs: []
      };
    }

    return Object.freeze({
      extractPrioritySnapshotEventFromStudiesRefreshMessage,
      toFullSnapshotEvent
    });
  }

  root.adapters = Object.freeze({
    createPriorityAdapters
  });
})();

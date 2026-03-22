import { GO_SERVER_URL } from './constants.js';

export async function getServerHealth() {
  const resp = await fetch(`${GO_SERVER_URL}/healthz`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`healthz returned ${resp.status}`);
  return resp.json();
}

export async function getServerStatus() {
  const resp = await fetch(`${GO_SERVER_URL}/status`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`status returned ${resp.status}`);
  return resp.json();
}

export async function getServerStudies(limit = 200) {
  const resp = await fetch(`${GO_SERVER_URL}/studies?limit=${limit}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`studies returned ${resp.status}`);
  return resp.json();
}

/**
 * Get extension debug state from server.
 * @param {boolean} raw - If true, return the full response including metadata.
 *                        If false (default), return just the inner state dict.
 */
export async function getDebugExtensionState(raw = false) {
  const resp = await fetch(`${GO_SERVER_URL}/debug/extension-state`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`debug/extension-state returned ${resp.status}`);
  const data = await resp.json();
  if (raw) return data;
  if (data.has_state) return data.state || {};
  return {};
}

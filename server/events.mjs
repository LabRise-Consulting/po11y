// Pure translation from a pushed n8n event to the execution row shape the rest
// of the stack already speaks. Kept free of I/O so the ingest endpoint is a
// thin shell around it and every payload flavour is testable from a fixture.
//
// A pushed row is NOT authoritative: poll-fill re-reads the same execution from
// the API and the upsert lets the later, richer row win. That asymmetry is
// deliberate — push is for latency, poll is for truth.
//
// PUSH AVAILABILITY. n8n's log-streaming destinations are an enterprise
// feature, so on a Community instance this parser has nothing to receive:
// `/rest/settings` reports the enterprise flags false, `/metrics` exposes no
// eventbus series, and the destination REST routes answer 404 rather than 401
// — that router is not mounted at all. Poll-fill is therefore the operative
// path on any unlicensed instance, and push is a latency optimisation for
// those that do have it. Verify against your own instance before relying on
// it. The parser is exercised by synthetic cases only.

export const INGEST_KINDS = ['log-streaming'];

/**
 * Normalize a pushed timestamp to the ISO-8601 shape every stored stamp
 * already uses. A numeric epoch-ms `ts` stored as-is becomes a SQLite
 * INTEGER, which sorts BELOW every TEXT started_at/stopped_at — the windowed
 * SQL every expectation and alert runs never matches it, and pruneExecutions
 * (COALESCE(...) < cutoffIso, a string comparison) deletes it on the very
 * next poll tick because an integer always compares less than that string. A
 * string ts is trusted and returned unchanged if Date.parse accepts it — an
 * already-ISO stamp must not be reformatted, since a stamp with a different
 * (but valid) rendering is not the bug this is fixing. Anything else is not a
 * timestamp we can use.
 */
function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return ts;
  return null;
}

const STATUS_BY_EVENT = {
  'n8n.workflow.started': 'running',
  'n8n.workflow.success': 'success',
  'n8n.workflow.failed': 'error',
  'n8n.workflow.crashed': 'crashed',
};

/**
 * @param {object} body - one decoded event
 * @returns {object[]} zero or one execution row in n8n API shape
 */
export function parseEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const status = STATUS_BY_EVENT[body.eventName];
  if (!status) return [];

  const p = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const id = p.executionId ?? p.execution_id;
  if (id == null || id === '') return [];

  const ts = normalizeTs(body.ts ?? body.timestamp ?? null);
  const started = status === 'running';
  return [{
    id: String(id),
    workflowId: p.workflowId == null ? null : String(p.workflowId),
    workflowName: p.workflowName ?? null,
    status,
    startedAt: started ? ts : null,
    stoppedAt: started ? null : ts,
    createdAt: null,
    mode: p.isManual ? 'manual' : 'trigger',
  }];
}

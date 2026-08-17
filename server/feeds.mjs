// Feed documents, built from stored rows by the same pure functions the
// poll uses. Compatibility with the dashboard is by construction: this
// module chooses the inputs, it never reshapes the outputs.
//
// The ai-map is the exception that needs code rather than a pass-through.
// buildAiMap owns its publish policy and returns NO map on 'skip-fresh' /
// 'keep-annotated' — the poll's answer is "leave the file alone", and the
// store's equivalent is nextAiMap(). Assigning `ai.map` unconditionally would
// blank the feed one cycle after the freshness window closes.
import { recentExecutions, allWorkflows } from './db.mjs';
import { fetchStatus, buildAll, feedDocuments } from './n8n.mjs';

/** The last-good rule: a fresh build wins, otherwise keep what was published. */
export const nextAiMap = (prev, built) => (built ?? prev ?? null);

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ stamp: string, now?: number, prevAiMap?: object|null,
 *   ai?: {forced?: boolean, aiConfigured?: boolean, model?: string, llm?: (function|null)},
 *   limit?: number }} opts
 */
export async function buildFeeds(db, { stamp, now = Date.parse(stamp), prevAiMap = null, ai = {}, limit = 100 }) {
  const workflows = allWorkflows(db);
  const executions = recentExecutions(db, limit);
  const names = new Map(workflows.map((w) => [String(w.id), w.name]).filter(([, n]) => n));

  const built = await buildAll(workflows, prevAiMap, { now, ...ai });
  const docs = feedDocuments(built, stamp);

  // fetchStatus with `executions` supplied makes no request at all, so the
  // null fetchFn is unreachable — and would throw loudly if that ever changed.
  const { status, warning } = await fetchStatus(null, '', '', { executions, names, limit });

  // CAUTION: on 'republish' buildAiMap returns the caller's prevAiMap object
  // mutated. Stamp the returned map, never prev.
  const aiMap = built.ai?.map ?? null;
  if (aiMap) aiMap.generated_at = stamp;

  return {
    feeds: { ...docs, 'status.json': { generated_at: stamp, ...status } },
    aiMap,
    degraded: built.ai?.degraded ?? null,
    // Which branch buildAiMap took. republish/keep-annotated/skip-fresh return
    // without calling the LLM, so the caller cannot read a null `degraded` as
    // an all-clear without knowing this.
    aiAction: built.ai?.action ?? null,
    aiWarnings: built.ai?.summary?.warnings ?? [],
    warning,
    executions,
    workflows,
    names,
  };
}

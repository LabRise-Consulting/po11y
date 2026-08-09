// Tool and resource registry. Ordering is deliberate: operations first, then
// content — Po11y is a monitoring tool that also shows some workflow results,
// and tools/list ordering is what an agent scans first.

import { readFileSync } from 'node:fs';
import {
  incidentsTool, workflowTool, failureTool, executionsTool, graphTool, promqlTool, sqlTool,
} from './tools/ops.mjs';
import { datasetsTool, rowsTool, rowTool } from './tools/content.mjs';
import { FEED_NAMES } from './sources.mjs';

/**
 * The five feeds, exposed so an agent can pull one whole without a tool call.
 * Names come from FEED_NAMES in sources.mjs (the single home — makeFeeds
 * probes the same list); this pairing adds the agent-facing descriptions.
 * nginx.conf's exact locations and scope regexes and deploy/k8s's embedded
 * nginx copy each repeat the names in a language that cannot import this
 * module — a registry test pins all of them to this list so adding a feed
 * cannot silently miss a layer.
 */
const FEED_DESCRIPTIONS = {
  'status.json': 'Containers (Mode A) or execution summary (Mode B)',
  'notifications.json': 'Notification and alert feed, newest first',
  'map.json': 'Workflow map as mermaid source',
  'ai-map.json': 'Architecture map: structured nodes and edges',
  'forms.json': 'Active form triggers (the dashboard action buttons)',
};
export const FEEDS = FEED_NAMES.map((n) => {
  if (!FEED_DESCRIPTIONS[n]) throw new Error(`registry: feed ${n} has no description`);
  return [n, FEED_DESCRIPTIONS[n]];
});

/**
 * @param {object} sources - from detectSources()
 * @param {string} configPath - config.json, read once at boot
 */
export function buildRegistry(sources, configPath = process.env.CONFIG_PATH || '/app/config.json') {
  let config = { tabs: [] };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    // JSON.parse succeeds (and returns null, an array, a string, ...) for
    // plenty of inputs that are not the tabs-bearing object this server
    // expects; only a genuine object survives past the fallback. content.mjs
    // guards defensively too, but the fallback belongs here, at the one
    // place config.json is actually read.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch { /* no tabs configured */ }

  const tools = [
    incidentsTool(sources),
    workflowTool(sources),
    failureTool(sources),
    executionsTool(sources),
    graphTool(sources),
    promqlTool(sources),
    sqlTool(sources),
    datasetsTool(sources, config),
    rowsTool(sources, config),
    rowTool(sources, config),
  ];

  const resources = FEEDS.map(([file, description]) => ({
    uri: `po11y://feeds/${file}`,
    name: file,
    description,
    mimeType: 'application/json',
    read: async () => JSON.stringify(sources.feeds.readSafe(file), null, 2),
  }));

  return { tools, resources };
}

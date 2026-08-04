// Tool and resource registry. Ordering is deliberate: operations first, then
// content — Po11y is a monitoring tool that also shows some workflow results,
// and tools/list ordering is what an agent scans first.

import { readFileSync } from 'node:fs';
import {
  incidentsTool, workflowTool, failureTool, executionsTool, graphTool, promqlTool, sqlTool,
} from './tools/ops.mjs';
import { datasetsTool, rowsTool, rowTool } from './tools/content.mjs';

/** The five feeds, exposed so an agent can pull one whole without a tool call. */
const FEEDS = [
  ['status.json', 'Containers (Mode A) or execution summary (Mode B)'],
  ['notifications.json', 'Notification and alert feed, newest first'],
  ['map.json', 'Workflow map as mermaid source'],
  ['ai-map.json', 'Architecture map: structured nodes and edges'],
  ['forms.json', 'Active form triggers (the dashboard action buttons)'],
];

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

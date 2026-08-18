// owned by: core agent
// Inspect, refresh, and delete the workspace metadata cache.

import { clear, isFresh, metaPath, readCached, warm, TTL_MS } from "../cache.ts";
import { record, simpleReceipt } from "../out.ts";
import { defineCommand } from "../registry.ts";

function age(fetchedAt: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(fetchedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "unknown";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

defineCommand({
  name: "cache",
  group: "meta",
  summary: "show the workspace metadata cache status",
  examples: ["lin cache"],
  run() {
    const meta = readCached();
    if (!meta) {
      record({ cache: "empty", ttl: `${TTL_MS / 3_600_000}h` });
      return;
    }

    record({
      workspace: meta.workspace.urlKey,
      organization: meta.workspace.name,
      fetchedAt: meta.fetchedAt,
      age: age(meta.fetchedAt),
      fresh: isFresh(meta),
      teams: meta.teams.length,
      users: meta.users.length,
      projects: meta.projects.length,
      workspaceLabels: meta.workspaceLabels.length,
      templates: meta.templates.length,
      path: metaPath(meta.workspace.urlKey),
    });
  },
});

defineCommand({
  name: "cache warm",
  group: "meta",
  summary: "refetch every vocabulary page: teams, states, labels, users, projects, and templates",
  examples: ["lin cache warm"],
  async run() {
    const meta = await warm();
    record({
      warmed: meta.workspace.urlKey,
      teams: meta.teams.length,
      users: meta.users.length,
      projects: meta.projects.length,
      workspaceLabels: meta.workspaceLabels.length,
      templates: meta.templates.length,
      path: metaPath(meta.workspace.urlKey),
    });
  },
});

defineCommand({
  name: "cache clear",
  group: "meta",
  summary: "delete every cached workspace",
  examples: ["lin cache clear"],
  run() {
    simpleReceipt("cleared", String(clear().length));
  },
});

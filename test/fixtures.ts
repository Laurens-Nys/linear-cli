// Synthetic fixtures with real Linear response structure.
// Workspace `acme`, teams ENG and DES, users casey and alex, issues ENG-40..57.
// Nothing here comes from a live workspace.

export const WARM_DATA = {
  viewer: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Casey Jordan",
    displayName: "casey",
    email: "casey@acme.test",
    organization: { urlKey: "acme", name: "Acme" },
  },
  teams: {
    nodes: [
      {
        id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        key: "ENG",
        name: "Engineering",
        states: {
          nodes: [
            { id: "st-triage", name: "Triage", type: "triage", position: 0, color: "#1abc9c" },
            { id: "st-backlog", name: "Backlog", type: "backlog", position: 1, color: "#6c6c6c" },
            { id: "st-todo", name: "Todo", type: "unstarted", position: 2, color: "#a8a8a8" },
            { id: "st-doing", name: "In Progress", type: "started", position: 3, color: "#e0af68" },
            { id: "st-review", name: "In Review", type: "started", position: 4, color: "#bb9af7" },
            { id: "st-done", name: "Done", type: "completed", position: 5, color: "#9ece6a" },
            { id: "st-canceled", name: "Canceled", type: "canceled", position: 6, color: "#f7768e" },
          ],
        },
        labels: {
          nodes: [
            { id: "lb-bug", name: "Bug", color: "#eb5757", parent: null },
            { id: "lb-p0", name: "P0", color: "#f2994a", parent: { name: "Priority" } },
            { id: "lb-p1", name: "P1", color: "#f2c94c", parent: { name: "Priority" } },
          ],
        },
        templates: { nodes: [{ id: "tpl-bug", name: "Bug report", type: "issue" }] },
      },
      {
        id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        key: "DES",
        name: "Design",
        states: {
          nodes: [
            { id: "ds-todo", name: "Todo", type: "unstarted", position: 0, color: "#a8a8a8" },
            { id: "ds-done", name: "Done", type: "completed", position: 1, color: "#9ece6a" },
          ],
        },
        // A second team-scoped "Bug" makes an unqualified lookup ambiguous.
        labels: { nodes: [{ id: "lb-des-bug", name: "Bug", color: "#eb5757", parent: null }] },
        templates: { nodes: [] },
      },
    ],
  },
  users: {
    nodes: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Casey Jordan",
        displayName: "casey",
        email: "casey@acme.test",
        active: true,
        isMe: true,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Alex Rivera",
        displayName: "alex",
        email: "alex@acme.test",
        active: true,
        isMe: false,
      },
    ],
  },
  projects: {
    nodes: [
      {
        id: "cccccccc-3333-4333-8333-cccccccccccc",
        slugId: "onboarding-1a2b3c",
        name: "Onboarding",
        status: { name: "In Progress" },
      },
      {
        id: "dddddddd-4444-4444-8444-dddddddddddd",
        slugId: "billing-4d5e6f",
        name: "Billing",
        status: { name: "Planned" },
      },
    ],
  },
  organization: {
    labels: {
      nodes: [
        { id: "lb-secops", name: "SecOps", color: "#27ae60", parent: null, team: null },
        // Team-scoped labels also appear here; workspaceLabels keeps only team: null.
        { id: "lb-bug", name: "Bug", color: "#eb5757", parent: null, team: { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" } },
      ],
    },
    templates: { nodes: [{ id: "tpl-rfc", name: "RFC", type: "document" }] },
  },
};

/** WARM_DATA plus an OPS team, for the refresh-on-miss path. */
export const WARM_DATA_WITH_OPS = {
  ...WARM_DATA,
  teams: {
    nodes: [
      ...WARM_DATA.teams.nodes,
      {
        id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
        key: "OPS",
        name: "Operations",
        states: { nodes: [{ id: "op-todo", name: "Todo", type: "unstarted", position: 0, color: "#a8a8a8" }] },
        labels: { nodes: [] },
        templates: { nodes: [] },
      },
    ],
  },
};

export const ISSUE_ROWS = [
  {
    id: "ENG-42",
    title: "Fix login redirect loop",
    state: "In Progress",
    assignee: "casey",
    priority: 2,
    updated: "2026-07-30T09:15:00.000Z",
  },
  {
    id: "ENG-41",
    title: "Rotate webhook secrets, again",
    state: "Todo",
    assignee: "alex",
    priority: 3,
    updated: "2026-07-29T18:02:00.000Z",
  },
  {
    id: "ENG-40",
    title: 'Handle "quoted" titles',
    state: "Todo",
    assignee: null,
    priority: 0,
    updated: "2026-07-28T11:44:00.000Z",
  },
];

export const RATE_HEADERS = {
  "x-ratelimit-requests-limit": "2500",
  "x-ratelimit-requests-remaining": "2487",
  "x-ratelimit-requests-reset": "1785312000",
  "x-ratelimit-complexity-limit": "3000000",
  "x-ratelimit-complexity-remaining": "2996000",
  "x-ratelimit-complexity-reset": "1785312000",
  "x-complexity": "42",
};

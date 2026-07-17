/** Shared wire limits. Keep client schemas, collectors, ETL, MCP, and graph transport aligned. */
export const MAX_TRANSPORT_BYTES = 1024 * 1024;
export const MAX_FACTORY_REASONING_CHARS = 4000;
export const MAX_DECISION_SEARCH_RESULTS = 5;
export const PROJECTION_WRITE_CHUNK = {
  agents: 25,
  tasks: 25,
  knowledge: 50,
  events: 2,
  decisions: 5,
} as const;

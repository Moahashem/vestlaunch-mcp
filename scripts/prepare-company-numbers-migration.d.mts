export function prepareMigration(exported: { agent_key: string; fingerprint: string; agent: Record<string, unknown> }): {
  agent_key: string; agent_id: string; expected_fingerprint: string; previous_version: number;
  apply_after: string; patch: { system: string; tools: unknown[] };
};

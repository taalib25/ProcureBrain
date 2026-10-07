import type { Pool } from "pg";

export interface ConnectorState {
  paused?: boolean;
  cursor?: string;
  pageToken?: string;
  bootstrapHistoryId?: string;
  bootstrapped?: boolean;
  contactsHash?: string;
  accountEmail?: string;
  lastSyncAt?: string;
  lastError?: string | null;
  imported?: number;
  skipped?: number;
}
/** Checkpoints and pause state survive restarts in PostgreSQL mode. No provider credentials here. */
export class ConnectorRepository {
  private busy = new Set<string>();
  private memory = new Map<string, ConnectorState>();
  constructor(private pool?: Pool) {}
  async exclusive<T>(org: string, id: string, action: () => Promise<T>): Promise<T | undefined> {
    const key = `${org}/${id}`;
    if (this.busy.has(key)) return undefined;
    this.busy.add(key);
    const client = this.pool ? await this.pool.connect().catch(error => { this.busy.delete(key); throw error; }) : undefined;
    let locked = false;
    try {
      if (client) {
        locked = (await client.query("select pg_try_advisory_lock(hashtext($1),hashtext($2)) as locked", [org, id])).rows[0].locked;
        if (!locked) return undefined;
      }
      return await action();
    } finally {
      try { if (client && locked) await client.query("select pg_advisory_unlock(hashtext($1),hashtext($2))", [org, id]); }
      finally { client?.release(); this.busy.delete(key); }
    }
  }
  async get(org: string, id: string): Promise<ConnectorState> {
    if (this.pool) return (await this.pool.query("select state from connector_state where organization_id=$1 and connector_id=$2", [org, id])).rows[0]?.state ?? {};
    return structuredClone(this.memory.get(`${org}/${id}`) ?? {});
  }
  async patch(org: string, id: string, patch: ConnectorState) {
    if (this.pool) {
      const result = await this.pool.query(`insert into connector_state(organization_id,connector_id,state) values($1,$2,$3)
        on conflict(organization_id,connector_id) do update set state=connector_state.state || excluded.state,updated_at=now() returning state`, [org, id, patch]);
      return result.rows[0].state as ConnectorState;
    }
    const state = { ...await this.get(org, id), ...patch }; this.memory.set(`${org}/${id}`, state); return structuredClone(state);
  }
}

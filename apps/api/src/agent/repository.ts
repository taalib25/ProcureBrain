import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type WorkStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "NEEDS_REVIEW" | "AWAITING_CONFIGURATION" | "ACCEPTED" | "FAILED";
export interface Work {
  id: string; organizationId: string; kind: "message" | "email"; dedupeKey: string;
  status: WorkStatus; payload: Record<string, unknown>; attempts: number;
  availableAt: string; leaseUntil: string | null; leaseToken: string | null; createdAt: string; updatedAt: string;
}
export class WorkRepository {
  private records = new Map<string, Work>();
  constructor(private pool?: Pool) {}
  async list(org: string) {
    if (this.pool) return (await this.pool.query('SELECT * FROM agent_work WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200', [org])).rows.map(decode);
    return [...this.records.values()].filter(w => w.organizationId === org).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,200).map(w => structuredClone(w));
  }
  async hasActiveMessage(org:string,id:string) {
    if(this.pool) return !!(await this.pool.query("SELECT 1 FROM agent_work WHERE organization_id=$1 AND kind='message' AND dedupe_key=$2 AND status IN ('QUEUED','PROCESSING')",[org,id])).rowCount;
    return [...this.records.values()].some(work=>work.organizationId===org&&work.kind==='message'&&work.dedupeKey===id&&['QUEUED','PROCESSING'].includes(work.status));
  }
  async enqueue(org: string, kind: Work["kind"], key: string, payload: Work["payload"]) {
    const now = new Date().toISOString();
    if (this.pool) {
      const result = await this.pool.query(`INSERT INTO agent_work(id,organization_id,kind,dedupe_key,status,payload) VALUES($1,$2,$3,$4,'QUEUED',$5)
        ON CONFLICT(organization_id,kind,dedupe_key) DO UPDATE SET status=CASE WHEN agent_work.status IN ('FAILED','NEEDS_REVIEW') AND agent_work.kind='message' THEN 'QUEUED' ELSE agent_work.status END,
        attempts=CASE WHEN agent_work.status IN ('FAILED','NEEDS_REVIEW') AND agent_work.kind='message' THEN 0 ELSE agent_work.attempts END,
        available_at=CASE WHEN agent_work.status IN ('FAILED','NEEDS_REVIEW') AND agent_work.kind='message' THEN now() ELSE agent_work.available_at END RETURNING *`, [randomUUID(),org,kind,key,payload]);
      return decode(result.rows[0]);
    }
    const existing = [...this.records.values()].find(w=>w.organizationId===org && w.kind===kind && w.dedupeKey===key);
    if (existing) {
      if(kind==='message' && ['FAILED','NEEDS_REVIEW'].includes(existing.status)) Object.assign(existing,{status:'QUEUED',attempts:0,availableAt:now});
      return structuredClone(existing);
    }
    const work:Work={id:randomUUID(),organizationId:org,kind,dedupeKey:key,status:'QUEUED',payload,attempts:0,availableAt:now,leaseUntil:null,leaseToken:null,createdAt:now,updatedAt:now};
    this.records.set(work.id,work); return structuredClone(work);
  }
  async claim(kind: Work['kind'], org: string) {
    const token = randomUUID(); const now = Date.now();
    if(this.pool) {
      const result=await this.pool.query(`UPDATE agent_work SET status='PROCESSING',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now()
        WHERE id=(SELECT id FROM agent_work WHERE kind=$1 AND organization_id=$2 AND attempts<3 AND ((status='QUEUED' AND available_at<=now()) OR (status='PROCESSING' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[kind,org,token]);
      return result.rows[0]?decode(result.rows[0]):null;
    }
    const work=[...this.records.values()].find(w=>w.kind===kind&&w.organizationId===org&&w.attempts<3&&((w.status==='QUEUED'&&Date.parse(w.availableAt)<=now)||(w.status==='PROCESSING'&&Date.parse(w.leaseUntil??'')<now)));
    if(!work)return null;
    Object.assign(work,{status:'PROCESSING',attempts:work.attempts+1,leaseToken:token,leaseUntil:new Date(now+120000).toISOString()});return structuredClone(work);
  }
  async heartbeat(work: Work) {
    if(this.pool) await this.pool.query("UPDATE agent_work SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2 AND status='PROCESSING'",[work.id,work.leaseToken]);
    else {const stored=this.records.get(work.id);if(stored?.leaseToken===work.leaseToken&&stored.status==='PROCESSING')stored.leaseUntil=new Date(Date.now()+120000).toISOString();}
  }
  async finish(work: Work, status: WorkStatus, payload: Work['payload']=work.payload, delay=0) {
    if(this.pool) await this.pool.query(`UPDATE agent_work SET status=$3,payload=$4,available_at=now()+($5::double precision*interval '1 millisecond'),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,[work.id,work.leaseToken,status,payload,delay]);
    else {const stored=this.records.get(work.id);if(stored?.leaseToken===work.leaseToken)Object.assign(stored,{status,payload,availableAt:new Date(Date.now()+delay).toISOString(),leaseToken:null,leaseUntil:null,updatedAt:new Date().toISOString()});}
  }
  async savePayload(work: Work, payload: Work['payload']) {
    if(this.pool) { const result=await this.pool.query("UPDATE agent_work SET payload=$3 WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' RETURNING id",[work.id,work.leaseToken,payload]); if(!result.rowCount)throw new Error('Work lease lost'); }
    else {const stored=this.records.get(work.id);if(!stored||stored.leaseToken!==work.leaseToken||stored.status!=='PROCESSING')throw new Error('Work lease lost');stored.payload=payload;}
    work.payload=payload;
  }
  async retryEmail(id:string,org:string) {
    if(this.pool) {const result=await this.pool.query("UPDATE agent_work SET status='QUEUED',attempts=0,available_at=now() WHERE id=$1 AND organization_id=$2 AND kind='email' AND status='FAILED' RETURNING *",[id,org]);return result.rows[0]?decode(result.rows[0]):null;}
    const work=this.records.get(id);if(!work||work.organizationId!==org||work.kind!=='email'||work.status!=='FAILED')return null;
    Object.assign(work,{status:'QUEUED',attempts:0,availableAt:new Date().toISOString()});return structuredClone(work);
  }
  async releaseConfiguredEmails(org:string) {
    if(this.pool) await this.pool.query("UPDATE agent_work SET status='QUEUED',attempts=0 WHERE organization_id=$1 AND kind='email' AND status='AWAITING_CONFIGURATION'",[org]);
    else for(const w of this.records.values())if(w.organizationId===org&&w.kind==='email'&&w.status==='AWAITING_CONFIGURATION'){w.status='QUEUED';w.attempts=0;}
  }
  async expireExhausted(org:string) {
    if(this.pool) await this.pool.query("UPDATE agent_work SET status='FAILED',lease_token=NULL,lease_until=NULL WHERE organization_id=$1 AND status='PROCESSING' AND attempts>=3 AND lease_until<now()",[org]);
    else for(const w of this.records.values())if(w.organizationId===org&&w.status==='PROCESSING'&&w.attempts>=3&&Date.parse(w.leaseUntil??'')<Date.now())w.status='FAILED';
  }
}
function decode(row: Record<string, any>):Work {
  return {id:row.id,organizationId:row.organization_id,kind:row.kind,dedupeKey:row.dedupe_key,status:row.status,payload:row.payload,attempts:row.attempts,availableAt:new Date(row.available_at).toISOString(),leaseUntil:row.lease_until?new Date(row.lease_until).toISOString():null,leaseToken:row.lease_token,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
}

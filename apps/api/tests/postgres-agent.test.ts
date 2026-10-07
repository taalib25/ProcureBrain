import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { WorkRepository } from '../src/agent/repository';

const connectionString=process.env.PROCUREBRAIN_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('agent queue against real PostgreSQL',()=>{
  const schema=`pb_agent_test_${randomUUID().replaceAll('-','')}`;
  let admin:Pool;let pool:Pool;let repository:WorkRepository;
  beforeAll(async()=>{admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`,max:4});await pool.query(await readFile(new URL('../migrations/0006_agent_runtime.sql',import.meta.url),'utf8'));repository=new WorkRepository(pool);});
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
  it('deduplicates concurrent enqueue requests',async()=>{
    const work=await Promise.all(Array.from({length:8},()=>repository.enqueue('org-1','message','same-source',{})));expect(new Set(work.map(row=>row.id)).size).toBe(1);expect(await repository.list('org-1')).toHaveLength(1);
  });
  it('only one concurrent worker claims each job',async()=>{
    await repository.enqueue('org-claims','message','one',{});const claims=await Promise.all(Array.from({length:8},()=>repository.claim('message','org-claims')));expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('reclaims expired leases and rejects writes from the previous owner',async()=>{
    await repository.enqueue('org-leases','message','one',{});const first=(await repository.claim('message','org-leases'))!;await pool.query("UPDATE agent_work SET lease_until=now()-interval '1 second' WHERE id=$1",[first.id]);const replacement=(await repository.claim('message','org-leases'))!;await repository.finish(first,'COMPLETED');expect((await repository.list('org-leases'))[0]?.status).toBe('PROCESSING');await repository.finish(replacement,'COMPLETED');expect((await repository.list('org-leases'))[0]?.status).toBe('COMPLETED');
  });
  it('reads pending work from a new connection after the worker pool closes',async()=>{
    await repository.enqueue('org-restart','email','pending-alert',{subject:'Pending alert'});await pool.end();pool=new Pool({connectionString,options:`-c search_path=${schema}`,max:4});repository=new WorkRepository(pool);expect((await repository.list('org-restart'))[0]).toMatchObject({status:'QUEUED',payload:{subject:'Pending alert'}});
  });
});

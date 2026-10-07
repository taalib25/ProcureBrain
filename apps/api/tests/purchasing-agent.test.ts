import { ZodError } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupplierCommitmentSchema } from '../../../packages/ai/src/schema';
import { createPracticeWorkspace, evaluatePracticeCase, loadPracticePack } from '../src/evaluation/purchasing';
import { PurchasingAgent } from '../src/agent/runtime';
import { WorkRepository } from '../src/agent/repository';

const pack=await loadPracticePack();
const sample=pack.cases[0]!;
const gold=sample.mockedExtraction;
afterEach(()=>vi.useRealTimers());
const prepare=async(adapter={extract:async()=>gold})=>createPracticeWorkspace(pack,adapter);
async function queue(workspace:Awaited<ReturnType<typeof prepare>>,input=sample.input) {
  const response=await workspace.post('/messages',input);expect(response.status).toBe(201);
  const {message}=await response.json() as {message:{id:string}};
  expect((await workspace.post(`/messages/${message.id}/queue`)).status).toBe(202);
  return message.id;
}

describe('dataset-derived purchasing scenarios (mocked extraction, not AI accuracy)',()=>{
  it.each(pack.cases.map(row=>[row.id,row.title,row] as const))('%s %s',async(_id,_title,row)=>{
    const result=await evaluatePracticeCase(pack,row);
    expect(result.checks.filter(check=>!check.passed),JSON.stringify(result.actual)).toEqual([]);
  });
  it('keeps labels, evidence and source provenance auditable',()=>{
    expect(new Set(pack.cases.map(row=>row.id)).size).toBe(34);
    expect(new Set(pack.orders.map(row=>row.poNumber)).size).toBe(pack.orders.length);
    for(const row of pack.cases) {
      expect(row.origin.originalLabelsCopied).toBe(false);
      const parsed=SupplierCommitmentSchema.safeParse(row.mockedExtraction);
      if(['PC-28','PC-29'].includes(row.id))expect(parsed.success).toBe(false);
      else {expect(parsed.success).toBe(true);if(parsed.success)for(const quote of parsed.data.evidence)expect(row.input.text).toContain(quote);}
      if(row.manualSelection)expect(pack.orders.map(order=>order.poNumber)).toContain(row.manualSelection);
    }
    expect(pack.orders.every(order=>order.sourceDataset&&order.sourcePoId)).toBe(true);
  });
});

describe('owner decisions, idempotency and intake',()=>{
  it('applies an approved date once and retains source evidence',async()=>{
    const workspace=await prepare();const id=await queue(workspace);await workspace.agent.runOnce();
    const proposal=workspace.store.listProposals(workspace.org)[0]!;
    const before=workspace.store.timeline(proposal.entityId).length;
    expect(workspace.store.state(proposal.entityId)?.eta).toBe('2026-11-10');
    expect((await workspace.post(`/proposals/${proposal.id}/approve`)).status).toBe(201);
    expect(workspace.store.state(proposal.entityId)?.eta).toBe('2026-11-14');
    expect((await workspace.post(`/proposals/${proposal.id}/approve`)).status).toBe(200);
    expect(workspace.store.timeline(proposal.entityId)).toHaveLength(before+1);
    expect(workspace.store.source(id)?.content).toBe(sample.input.text);
  });
  it('applies an owner edit instead of the extracted date',async()=>{
    const workspace=await prepare();await queue(workspace);await workspace.agent.runOnce();const proposal=workspace.store.listProposals(workspace.org)[0]!;
    expect((await workspace.post(`/proposals/${proposal.id}/approve-with-edit`,{eta:'2026-11-17'})).status).toBe(201);
    expect(workspace.store.state(proposal.entityId)?.eta).toBe('2026-11-17');
  });
  it('rejects a draft without changing the order',async()=>{
    const workspace=await prepare();await queue(workspace);await workspace.agent.runOnce();const proposal=workspace.store.listProposals(workspace.org)[0]!;const before=workspace.store.state(proposal.entityId);
    expect((await workspace.post(`/proposals/${proposal.id}/reject`,{reason:'Supplier superseded this promise'})).status).toBe(200);
    expect((await workspace.post(`/proposals/${proposal.id}/approve`)).status).toBe(409);
    expect(workspace.store.state(proposal.entityId)).toEqual(before);
  });
  it('blocks a stale approval after newer order evidence',async()=>{
    const workspace=await prepare();await queue(workspace);await workspace.agent.runOnce();const proposal=workspace.store.listProposals(workspace.org)[0]!;
    workspace.store.importCsv('po,event_type,occurred_at,eta\nPO-PRACTICE-001,ETA_CONFIRMED,2026-10-07T00:00:00Z,2026-11-18','newer-evidence','supplier_updates',workspace.org);
    expect((await workspace.post(`/proposals/${proposal.id}/approve`)).status).toBe(409);
    expect(workspace.store.state(proposal.entityId)?.eta).toBe('2026-11-18');
    expect(workspace.store.getProposal(proposal.id,workspace.org)?.status).toBe('STALE');
  });
  it('approves a revised total quantity while preserving the delivery date',async()=>{
    const row=pack.cases.find(row=>row.id==='PC-05')!;const workspace=await prepare({extract:async()=>row.mockedExtraction});await queue(workspace,row.input);await workspace.agent.runOnce();const proposal=workspace.store.listProposals(workspace.org)[0]!;
    expect((await workspace.post(`/proposals/${proposal.id}/approve`)).status).toBe(201);
    expect(workspace.store.state(proposal.entityId)).toMatchObject({eta:'2026-11-15',orderedQuantity:11,confirmedQuantity:7});
  });
  it('deduplicates both intake and repeated queued work',async()=>{
    const extract=vi.fn(async()=>gold);const workspace=await prepare({extract});const id=await queue(workspace);
    const duplicate=await workspace.post('/messages',sample.input);expect(duplicate.status).toBe(200);expect((await duplicate.json() as any).message.id).toBe(id);
    await workspace.post(`/messages/${id}/queue`);await workspace.agent.runOnce();await workspace.post(`/messages/${id}/queue`);await workspace.agent.runOnce();
    expect(extract).toHaveBeenCalledTimes(1);expect(workspace.store.listProposals(workspace.org)).toHaveLength(1);
    expect((await workspace.repository.list(workspace.org)).filter(work=>work.kind==='email')).toHaveLength(1);
  });
  it('rejects changed content under the same external message identity',async()=>{
    const workspace=await prepare();const id=await queue(workspace);
    expect((await workspace.post('/messages',{...sample.input,text:'Different evidence under the same message ID'})).status).toBe(409);
    expect(workspace.store.getMessage(id,workspace.org)?.text).toBe(sample.input.text);
  });
  it('prevents relinking while the job is queued or after a proposal is prepared',async()=>{
    const workspace=await prepare();const id=await queue(workspace);
    expect((await workspace.post(`/messages/${id}/link-purchase-order`,{entityId:workspace.entityId('PO-PRACTICE-002')})).status).toBe(409);
    await workspace.agent.runOnce();expect((await workspace.post(`/messages/${id}/link-purchase-order`,{entityId:workspace.entityId('PO-PRACTICE-002')})).status).toBe(409);
  });
  it('restarts matching after the owner selects a PO and prepares one new alert',async()=>{
    const workspace=await prepare();const id=await queue(workspace,{...sample.input,text:'Our delivery moved to 2026-11-14.',sender:'forwarder@example.test'});await workspace.agent.runOnce();
    expect((await workspace.repository.list(workspace.org)).find(work=>work.kind==='message')?.status).toBe('NEEDS_REVIEW');
    expect((await workspace.post(`/messages/${id}/link-purchase-order`,{entityId:workspace.entityId('PO-PRACTICE-001')})).status).toBe(200);
    await workspace.post(`/messages/${id}/queue`);await workspace.agent.runOnce();
    expect(workspace.store.listProposals(workspace.org)).toHaveLength(1);expect((await workspace.repository.list(workspace.org)).filter(work=>work.kind==='email')).toHaveLength(2);
  });
  it('retries a transient extraction failure rather than reusing a failed response',async()=>{
    vi.useFakeTimers();const extract=vi.fn().mockRejectedValueOnce(new Error('Provider timeout')).mockResolvedValue(gold);const workspace=await prepare({extract});await queue(workspace);await workspace.agent.runOnce();
    expect((await workspace.repository.list(workspace.org)).find(work=>work.kind==='message')).toMatchObject({status:'QUEUED',attempts:1});
    vi.advanceTimersByTime(15001);await workspace.agent.runOnce();expect(extract).toHaveBeenCalledTimes(2);
    expect(workspace.store.listProposals(workspace.org)).toHaveLength(1);
  });
  it('bounds persistent model failures to three attempts',async()=>{
    vi.useFakeTimers();const extract=vi.fn(async()=>{throw new Error('Provider unavailable');});const workspace=await prepare({extract});await queue(workspace);await workspace.agent.runOnce();vi.advanceTimersByTime(15001);await workspace.agent.runOnce();vi.advanceTimersByTime(30001);await workspace.agent.runOnce();vi.advanceTimersByTime(60000);await workspace.agent.runOnce();
    expect(extract).toHaveBeenCalledTimes(3);expect((await workspace.repository.list(workspace.org)).find(work=>work.kind==='message')).toMatchObject({status:'FAILED',attempts:3});expect(workspace.store.listProposals(workspace.org)).toHaveLength(0);expect((await workspace.repository.list(workspace.org)).filter(work=>work.kind==='email')).toMatchObject([{status:'AWAITING_CONFIGURATION',payload:{subject:expect.stringContaining('needs your help')}}]);
  });
  it('alerts on schema errors thrown inside a provider adapter without retrying transport',async()=>{
    const extract=vi.fn(async()=>{throw new ZodError([{code:'custom',path:['eta'],message:'Invalid calendar date'}]);});const workspace=await prepare({extract});await queue(workspace);await workspace.agent.runOnce();expect(extract).toHaveBeenCalledTimes(1);expect(workspace.store.listProposals(workspace.org)).toHaveLength(0);expect((await workspace.repository.list(workspace.org)).find(work=>work.kind==='message')?.status).toBe('NEEDS_REVIEW');
  });
  it('keeps the agent organization scoped without pretending headers are authentication',async()=>{
    const workspace=await prepare();const id=await queue(workspace);
    const headers={'x-organization-id':'org-other','content-type':'application/json'};
    expect((await workspace.app.request('/api/agent',{headers})).status).toBe(403);
    expect((await workspace.app.request(`/api/messages/${id}`,{headers})).status).toBe(404);
    expect((await workspace.app.request(`/api/messages/${id}/queue`,{method:'POST',headers,body:'{}'})).status).toBe(403);
  });
});

const emailEnvironment={PROCUREBRAIN_EMAIL_ENABLED:'true',RESEND_API_KEY:'test-placeholder',PROCUREBRAIN_EMAIL_FROM:'ProcureBrain <sender@example.test>',PROCUREBRAIN_EMAIL_TO:'owner@example.test',PROCUREBRAIN_WEB_URL:'http://localhost:5173'};
async function emailAgent(fetcher:typeof fetch,env:NodeJS.ProcessEnv=emailEnvironment) {
  const repository=new WorkRepository();const agent=new PurchasingAgent(repository,env,{fetch:fetcher});agent.bind(async()=>({status:'NO_CHANGE',subject:'',text:''}));
  const work=await repository.enqueue('org-dev','email','test-alert',{subject:'Review a supplier change',text:'Old 2026-11-10 → new 2026-11-14. No change until approval.',proposalId:'proposal-1'});
  return {repository,agent,work};
}
describe('email adapter with a fake provider (no email is sent)',()=>{
  it('stays in preview mode when delivery is disabled',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response());const {agent,repository}=await emailAgent(fetcher,{...emailEnvironment,PROCUREBRAIN_EMAIL_ENABLED:'false'});await agent.runOnce();
    expect(fetcher).not.toHaveBeenCalled();expect((await repository.list('org-dev'))[0]?.status).toBe('AWAITING_CONFIGURATION');
  });
  it('requires all sender settings and a valid review URL',async()=>{
    for(const env of [{...emailEnvironment,RESEND_API_KEY:''},{...emailEnvironment,PROCUREBRAIN_WEB_URL:'javascript:alert(1)'}]){const fetcher=vi.fn<typeof fetch>(async()=>new Response());const {agent}=await emailAgent(fetcher,env);await agent.runOnce();expect(fetcher).not.toHaveBeenCalled();expect(agent.configuration().emailMode).toBe('preview');}
  });
  it('records provider acceptance, not inbox delivery',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({id:'provider-123'}));const {agent,repository}=await emailAgent(fetcher);await agent.runOnce();
    expect((await repository.list('org-dev'))[0]).toMatchObject({status:'ACCEPTED',payload:{providerId:'provider-123'}});
    const payload=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);expect(payload.to).toEqual(['owner@example.test']);expect(payload.text).toContain('/#reviews?proposal=proposal-1');
  });
  it('retries with the same idempotency key, recipient and frozen body',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(Response.json({id:'provider-123'}));const env={...emailEnvironment};const {agent,repository}=await emailAgent(fetcher,env);await agent.runOnce();env.PROCUREBRAIN_EMAIL_TO='another@example.test';vi.advanceTimersByTime(15001);await agent.runOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe(fetcher.mock.calls[1]![1].headers['Idempotency-Key']);expect((await repository.list('org-dev'))[0]?.status).toBe('ACCEPTED');
  });
  it('fails after three send attempts and permits an explicit retry',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>(async()=>new Response('',{status:503}));const {agent,repository,work}=await emailAgent(fetcher);await agent.runOnce();vi.advanceTimersByTime(15001);await agent.runOnce();vi.advanceTimersByTime(30001);await agent.runOnce();expect((await repository.list('org-dev'))[0]?.status).toBe('FAILED');expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await repository.retryEmail(work.id,'org-other')).toBeNull();expect(await repository.retryEmail(work.id,'org-dev')).toMatchObject({status:'QUEUED',attempts:0});
  });
  it('blocks uncertain sends after the idempotency window',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>(async()=>new Response('',{status:503}));const {agent,repository}=await emailAgent(fetcher);await agent.runOnce();vi.advanceTimersByTime(24*3600000);await agent.runOnce();expect(fetcher).toHaveBeenCalledTimes(1);expect((await repository.list('org-dev'))[0]).toMatchObject({status:'FAILED',payload:{error:expect.stringContaining('idempotency window')}});
  });
  it('sends existing preview alerts only after configuration is enabled',async()=>{
    const env={...emailEnvironment,PROCUREBRAIN_EMAIL_ENABLED:'false'};const fetcher=vi.fn<typeof fetch>(async()=>Response.json({id:'provider-123'}));const {agent,repository}=await emailAgent(fetcher,env);await agent.runOnce();expect(fetcher).not.toHaveBeenCalled();env.PROCUREBRAIN_EMAIL_ENABLED='true';await agent.runOnce();expect(fetcher).toHaveBeenCalledTimes(1);expect((await repository.list('org-dev'))[0]).toMatchObject({status:'ACCEPTED',attempts:1});
  });
});

describe('work leases and recovery in memory',()=>{
  it('leases exclusively and fences off the previous owner after expiry',async()=>{
    vi.useFakeTimers();const repository=new WorkRepository();await repository.enqueue('org-dev','message','one',{});const first=(await repository.claim('message','org-dev'))!;expect(await repository.claim('message','org-dev')).toBeNull();vi.advanceTimersByTime(120001);const second=(await repository.claim('message','org-dev'))!;expect(second.leaseToken).not.toBe(first.leaseToken);
    await repository.finish(first,'COMPLETED');expect((await repository.list('org-dev'))[0]?.status).toBe('PROCESSING');await repository.finish(second,'COMPLETED');expect((await repository.list('org-dev'))[0]?.status).toBe('COMPLETED');
  });
  it('heartbeats extend a lease and three expired claims become failed',async()=>{
    vi.useFakeTimers();const repository=new WorkRepository();await repository.enqueue('org-dev','message','one',{});const first=(await repository.claim('message','org-dev'))!;vi.advanceTimersByTime(60000);await repository.heartbeat(first);vi.advanceTimersByTime(60001);expect(await repository.claim('message','org-dev')).toBeNull();vi.advanceTimersByTime(60000);await repository.claim('message','org-dev');vi.advanceTimersByTime(120001);await repository.claim('message','org-dev');vi.advanceTimersByTime(120001);await repository.expireExhausted('org-dev');expect((await repository.list('org-dev'))[0]?.status).toBe('FAILED');
  });
  it('resumes an unfinished job in a replacement worker sharing its repository',async()=>{
    const repository=new WorkRepository();const first=new PurchasingAgent(repository,{});await first.enqueue('message-1','org-dev');await first.close();const second=new PurchasingAgent(repository,{});const processor=vi.fn(async()=>({status:'NO_CHANGE',subject:'',text:''}));second.bind(processor);await second.runOnce();expect(processor).toHaveBeenCalledTimes(1);expect((await repository.list('org-dev'))[0]?.status).toBe('COMPLETED');
    // Sharing this object is not proof that memory survives a real process restart.
  });
  it('coalesces concurrent cycles within one worker',async()=>{
    const repository=new WorkRepository();const agent=new PurchasingAgent(repository,{});const processor=vi.fn(async()=>({status:'NO_CHANGE',subject:'',text:''}));agent.bind(processor);await agent.enqueue('message-1','org-dev');await Promise.all([agent.runOnce(),agent.runOnce(),agent.runOnce()]);expect(processor).toHaveBeenCalledTimes(1);
  });
});

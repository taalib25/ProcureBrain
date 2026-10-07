import { readFile } from 'node:fs/promises';
import type { ExtractionAdapter } from '../../../../packages/ai/src/adapter';
import type { ConfiguredAIProvider } from '../../../../packages/ai/src/configured-provider';
import { createApp } from '../app';
import { MemoryStore } from '../store';
import { WorkRepository } from '../agent/repository';
import { PurchasingAgent } from '../agent/runtime';

export interface PracticeOrder {
  poNumber:string; supplierName:string; quantity:number; eta:string|null; orderDate:string;
  product:string; sourceDataset:string; sourcePoId:string;
}
export interface PracticeCase {
  id:string; title:string; group:string; priority:string; businessImpact:string;
  origin:{kind:string;basedOn:string;originalLabelsCopied:boolean};
  input:{channel:'supplier_email';sender:string;subject:string;text:string;sentAt:string;receivedAt:string;externalMessageId:string};
  manualSelection:string|null; mockedExtraction:unknown; expectedModelCalls:number;
  expected:{outcome:'proposal'|'review'|'none';targetPo:string|null;eta:string|null;quantity:number|null;reviewState:string|null;reason:string};
}
export interface PracticePack {
  version:string;limitations:string[];orders:PracticeOrder[];
  suppliers:Array<{supplierCode:string;name:string;primaryEmail:string;emailDomain:string}>;
  cases:PracticeCase[];
}
export async function loadPracticePack():Promise<PracticePack> {
  return JSON.parse(await readFile(new URL('../../../../data/scenarios/purchasing-agent/cases.json',import.meta.url),'utf8'));
}
export async function createPracticeWorkspace(pack:PracticePack, adapter:ExtractionAdapter, configuredProvider?:ConfiguredAIProvider) {
  const store=new MemoryStore();
  const org='org-practice-eval';
  const repository=new WorkRepository();
  // No real recipient, credentials or notification connection enters an evaluation workspace.
  const agent=new PurchasingAgent(repository,{PROCUREBRAIN_AGENT_ORG:org,PROCUREBRAIN_EMAIL_ENABLED:'false'}, {fetch:async()=>{throw new Error('Outbound email is forbidden during scenario evaluation');}});
  const app=createApp(store,{agent,extractionAdapter:adapter,configuredProvider,storageMode:'memory'});
  const post=async(path:string,body:unknown={})=>app.request(`/api${path}`,{method:'POST',headers:{'content-type':'application/json','x-organization-id':org},body:JSON.stringify(body)});
  const get=async(path:string)=>app.request(`/api${path}`,{headers:{'x-organization-id':org}});
  for(const supplier of pack.suppliers)store.createSupplier(supplier,org);
  const imported=store.importRows(pack.orders.map((order,index)=>({row:index+1,values:{po_number:order.poNumber,supplier_name:order.supplierName,order_date:order.orderDate,quantity:String(order.quantity),...(order.eta?{eta:order.eta}:{})}})),'practice-baseline','purchase_orders',org);
  if(imported.rejected.length||imported.unresolved.length)throw new Error('Practice baseline did not import cleanly');
  const entityId=(po:string)=>store.purchaseOrderReferences(org).find(reference=>reference.poNumber===po)?.entityId;
  return {store,org,repository,agent,app,post,get,entityId};
}
export interface ScenarioResult {
  id:string;title:string;group:string;passed:boolean; checks:Array<{name:string;passed:boolean;expected:unknown;actual:unknown}>;
  actual:{outcome:string;modelCalls:number;proposalCount:number;emailCount:number;jobStatus:string|undefined;eta:string|null;quantity:number|null;reviewState:string|null;selectedPo:string|null;messageStatus:string;extracted:unknown;providerUsage:unknown};
}
/** Gold-backed adapter mode tests the workflow, not model accuracy. Live mode uses the same isolated workspace. */
export async function evaluatePracticeCase(pack:PracticePack,scenario:PracticeCase,realAdapter?:ExtractionAdapter,provider?:ConfiguredAIProvider):Promise<ScenarioResult> {
  let calls=0;
  const workspace=await createPracticeWorkspace(pack,{extract:async(text,context)=>{calls++;return realAdapter?realAdapter.extract(text,context):structuredClone(scenario.mockedExtraction);}},provider);
  const before=workspace.store.purchaseOrders(workspace.org);
  const saved=await workspace.post('/messages',scenario.input);
  if(saved.status!==201)throw new Error(`Capture failed for ${scenario.id} (${saved.status})`);
  const {message}=await saved.json() as {message:{id:string}};
  if(scenario.manualSelection){const id=workspace.entityId(scenario.manualSelection);const linked=await workspace.post(`/messages/${message.id}/link-purchase-order`,{entityId:id});if(linked.status!==200)throw new Error('Practice manual matching failed');}
  await workspace.post(`/messages/${message.id}/queue`);
  await workspace.agent.runOnce();
  const work=await workspace.repository.list(workspace.org);
  const job=work.find(item=>item.kind==='message');
  const emails=work.filter(item=>item.kind==='email');
  const proposals=workspace.store.listProposals(workspace.org);
  const detail=await (await workspace.get(`/messages/${message.id}`)).json() as {message:{processingStatus:string};candidates:Array<{entityId:string;isSelected:boolean}>;proposal:unknown};
  const selectedId=detail.candidates.find(item=>item.isSelected)?.entityId;
  const selectedPo=workspace.store.purchaseOrderReferences(workspace.org).find(reference=>reference.entityId===selectedId)?.poNumber??null;
  const proposal=proposals[0];
  const outcome=job?.status==='NEEDS_REVIEW'?'review':proposal?'proposal':job?.status==='COMPLETED'?'none':'failed';
  const actual={outcome,modelCalls:calls,proposalCount:proposals.length,emailCount:emails.length,jobStatus:job?.status,eta:proposal?.payload.eta??null,quantity:proposal?.payload.quantity??null,reviewState:proposal?.reviewState??null,selectedPo,messageStatus:detail.message.processingStatus,extracted:detail.proposal,providerUsage:calls>0?provider?.extractionAdapter?.lastResponse?.usage??null:null};
  const checks:ScenarioResult['checks']=[];
  const check=(name:string,expected:unknown,value:unknown)=>checks.push({name,expected,actual:value,passed:JSON.stringify(expected)===JSON.stringify(value)});
  check('Business outcome',scenario.expected.outcome,actual.outcome);
  check('Order facts stay unchanged before approval',before,workspace.store.purchaseOrders(workspace.org));
  check('Expected model call count',scenario.expectedModelCalls,calls);
  check('Exactly one alert for an actionable update',scenario.expected.outcome==='none'?0:1,emails.length);
  check('Email stays in preview mode',true,emails.every(email=>email.status==='AWAITING_CONFIGURATION'));
  if(scenario.expected.outcome==='proposal') {
    check('Exactly one draft',1,proposals.length);check('Correct purchase order',scenario.expected.targetPo,selectedPo);
    check('Proposed date',scenario.expected.eta,actual.eta);check('Proposed quantity',scenario.expected.quantity,actual.quantity);
    check('Review state',scenario.expected.reviewState,actual.reviewState);
    const expectedEvidence=(detail.proposal as {commitment?:{evidence?:string[]}})?.commitment?.evidence??[];
    check('Evidence quotes are from the message',true,expectedEvidence.length>0&&expectedEvidence.every(quote=>scenario.input.text.includes(quote)));
  } else check('No approvable draft',0,proposals.length);
  await workspace.agent.close();
  return {id:scenario.id,title:scenario.title,group:scenario.group,passed:checks.every(check=>check.passed),checks,actual};
}

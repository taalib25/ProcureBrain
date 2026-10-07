import { WorkRepository, type Work } from './repository';

export interface MessageOutcome { status: string; subject: string; text: string; proposalId?: string }
/** A bounded orchestration loop. It can prepare proposals and alerts; it has no approval tool. */
export class PurchasingAgent {
  private processor?: (id:string,org:string)=>Promise<MessageOutcome>;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped=false;
  readonly organizationId: string;
  constructor(readonly repository:WorkRepository, private env:NodeJS.ProcessEnv, private dependencies: { fetch?: typeof globalThis.fetch } = {}) {
    this.organizationId=env.PROCUREBRAIN_AGENT_ORG??'org-dev';
  }
  bind(processor:NonNullable<PurchasingAgent['processor']>) {this.processor=processor;}
  configuration() {
    const missing=['RESEND_API_KEY','PROCUREBRAIN_EMAIL_FROM','PROCUREBRAIN_EMAIL_TO','PROCUREBRAIN_WEB_URL'].filter(key=>!this.env[key]?.trim());
    let validUrl=false;
    try {const url=new URL(this.env.PROCUREBRAIN_WEB_URL??'');validUrl=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{}
    if(!missing.includes('PROCUREBRAIN_WEB_URL')&&!validUrl)missing.push('PROCUREBRAIN_WEB_URL (valid base URL required)');
    return {enabled:!!this.processor,notificationChannel:'email',emailMode:this.env.PROCUREBRAIN_EMAIL_ENABLED==='true'&&missing.length===0?'live':'preview',missing,deliveryEnabled:this.env.PROCUREBRAIN_EMAIL_ENABLED==='true',organizationId:this.organizationId};
  }
  async enqueue(id:string,org:string) {
    if(org!==this.organizationId)throw new Error('The local purchasing agent is configured for a different workspace');
    return this.repository.enqueue(org,'message',id,{messageId:id});
  }
  start() {
    this.stopped=false;
    const run=()=>{if(this.active||this.stopped)return;void this.runOnce().catch(()=>console.error('Purchasing agent cycle failed; queued work will be retried.'));};
    this.timer=setInterval(run,2000);this.timer.unref();run();
  }
  /** Runs one bounded cycle; also used by isolated scenario evaluations without starting a server. */
  async runOnce() {
    if (this.active) return this.active;
    this.active = this.tick().finally(() => { this.active = undefined; });
    return this.active;
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.active;}
  private async withLease(work:Work,fn:()=>Promise<void>) {
    const heartbeat=setInterval(()=>{void this.repository.heartbeat(work).catch(()=>console.error('Agent lease renewal failed.'));},30000);
    try{await fn();}finally{clearInterval(heartbeat);}
  }
  private async tick() {
    await this.repository.expireExhausted(this.organizationId);
    const job=await this.repository.claim('message',this.organizationId);
    if(job&&this.processor)await this.withLease(job,async()=>{
      try {
        const outcome=await this.processor!(String(job.payload.messageId),job.organizationId);
        if(outcome.status==='FAILED')throw new Error('Message analysis failed. Check the AI provider configuration or retry from the inbox.');
        // Persist alert BEFORE completing work: a crash can safely recreate the same alert intent.
        if(outcome.status!=='NO_CHANGE')await this.repository.enqueue(job.organizationId,'email',`${job.id}/${outcome.proposalId??outcome.status}`,{messageId:job.payload.messageId,...outcome});
        await this.repository.finish(job,outcome.status==='REVIEW_REQUIRED'?'NEEDS_REVIEW':'COMPLETED',{...job.payload,...outcome,error:undefined});
      }catch {
        if(job.attempts>=3)await this.repository.enqueue(job.organizationId,'email',`${job.id}/analysis-failed`,{messageId:job.payload.messageId,subject:'ProcureBrain: supplier message could not be checked',text:'We could not check this supplier message after three tries. Open Messages to read the saved update and try again. If this continues, ask the person who set up the app for help. The order has not changed.'});
        await this.repository.finish(job,job.attempts<3?'QUEUED':'FAILED',{...job.payload,error:'We could not check this message. Open Messages to try again.'},job.attempts*15000);
      }
    });
    const configured=this.configuration();
    if(configured.emailMode==='live')await this.repository.releaseConfiguredEmails(this.organizationId);
    const email=await this.repository.claim('email',this.organizationId);
    if(!email)return;
    await this.withLease(email,async()=>{
      if(configured.emailMode!=='live'){await this.repository.finish(email,'AWAITING_CONFIGURATION');return;}
      // Resend retains keys for 24 hours. Do not automatically resend uncertain old requests.
      if(typeof email.payload.firstSendAt==='string' && Date.now()-Date.parse(email.payload.firstSendAt)>23*3600000){
        await this.repository.finish(email,'FAILED',{...email.payload,error:'The send may have succeeded. Check the provider receipt before any manual resend; the idempotency window has expired.'});return;
      }
      try {
        if(!email.payload.delivery)await this.repository.savePayload(email,{...email.payload,firstSendAt:new Date().toISOString(),delivery:{from:this.env.PROCUREBRAIN_EMAIL_FROM,to:[this.env.PROCUREBRAIN_EMAIL_TO],subject:email.payload.subject,text:`${email.payload.text}\n\nOpen the message or change: ${this.reviewUrl(typeof email.payload.proposalId==='string'?email.payload.proposalId:undefined)}`}});
        const response=await (this.dependencies.fetch ?? globalThis.fetch)('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${this.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`procurebrain/${email.id}`},body:JSON.stringify(email.payload.delivery)});
        if(!response.ok)throw new Error(`Email provider returned HTTP ${response.status}`);
        const result=await response.json() as {id?:string};if(!result.id)throw new Error('No email provider receipt');
        await this.repository.finish(email,'ACCEPTED',{...email.payload,providerId:result.id,error:undefined});
      }catch(error){await this.repository.finish(email,email.attempts<3?'QUEUED':'FAILED',{...email.payload,error:error instanceof Error?error.message:'Email request failed'},email.attempts*15000);}
    });
  }
  reviewUrl(proposalId?:string) {
    const base=(this.env.PROCUREBRAIN_WEB_URL??'http://localhost:5173').replace(/\/$/,'');
    return proposalId?`${base}/#reviews?proposal=${encodeURIComponent(proposalId)}`:`${base}/#messages`;
  }
}

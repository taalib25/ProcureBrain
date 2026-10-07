import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { createConfiguredAIProvider } from '../../../packages/ai/src/configured-provider';
import { loadPracticePack, evaluatePracticeCase } from '../src/evaluation/purchasing';

const root=resolve(import.meta.dirname,'../../..');
const args=process.argv.slice(2);
const live=args.includes('--live-ai');
const pack=await loadPracticePack();
const selectedId=args.find(arg=>arg.startsWith('--case='))?.slice(7);
const limitArg=args.find(arg=>arg.startsWith('--limit='))?.slice(8);
const limit=limitArg?Number(limitArg):live?5:pack.cases.length;
if(!Number.isInteger(limit)||limit<1||limit>pack.cases.length)throw new Error(`Limit must be 1–${pack.cases.length}`);
let scenarios=pack.cases.filter(scenario=>!selectedId||scenario.id===selectedId).slice(0,limit);
if(!scenarios.length)throw new Error('No matching practice case');
// Boundary fixture cases deliberately supply invalid model outputs. They are not language accuracy examples.
if(live)scenarios=scenarios.filter(scenario=>!['PC-28','PC-29'].includes(scenario.id));
if(!scenarios.length)throw new Error('Selected cases inject invalid model outputs and are only runnable in offline mode.');
if(live)config({path:resolve(root,'.env'),quiet:true});
const provider=live?createConfiguredAIProvider():undefined;
if(live&&!provider?.extractionAdapter)throw new Error(provider?.configurationError??'No live AI adapter configured');
const results=[];
for(const scenario of scenarios){const result=await evaluatePracticeCase(pack,scenario,provider?.extractionAdapter,provider);results.push(result);console.log(`${result.passed?'PASS':'FAIL'} ${result.id} ${result.title}`);for(const check of result.checks.filter(check=>!check.passed))console.log(`  ${check.name}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`);}
const sourceFiles=['apps/api/src/app.ts','apps/api/src/store.ts','apps/api/src/agent/runtime.ts','apps/api/src/agent/repository.ts','apps/api/src/evaluation/purchasing.ts','packages/ai/src/adapter.ts'];
const codeHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')])));
const report={codeHashes,generatedAt:new Date().toISOString(),mode:live?'live-ai-isolated-preview':'offline-gold-adapter',packVersion:pack.version,packSha256:createHash('sha256').update(JSON.stringify(pack)).digest('hex'),provider:provider?.provider??null,model:provider?.model??null,promptVersion:process.env.AI_PROMPT_VERSION??'supplier-v2',schemaVersion:process.env.AI_SCHEMA_VERSION??'commitment-v1',cases:results.length,passed:results.filter(row=>row.passed).length,failed:results.filter(row=>!row.passed).length,limitations:pack.limitations,results};
const directory=resolve(root,'.tmp/evaluations/purchasing-agent');await mkdir(directory,{recursive:true});
const file=resolve(directory,`${live?'live':'offline'}-${new Date().toISOString().replaceAll(':','-')}.json`);
await writeFile(file,JSON.stringify(report,null,2)+'\n');
await writeFile(resolve(directory,`${live?'live':'offline'}-latest.json`),JSON.stringify(report,null,2)+'\n');
console.log(`\n${report.passed}/${report.cases} cases passed. Saved ${file}`);
if(!live)console.log('These are workflow checks with supplied model outputs, NOT an AI accuracy score. No real emails or model calls were made.');
else console.log('Authored practice scenarios, not an unseen or representative accuracy benchmark. Notifications stayed in preview mode.');
if(report.failed)process.exitCode=1;

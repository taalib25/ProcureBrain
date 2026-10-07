import { useState } from 'react';
import packSource from '../../../../data/scenarios/purchasing-agent/cases.json?raw';
import baselineCsv from '../../../../data/scenarios/purchasing-agent/purchase-orders.csv?raw';
import { api, dateLabel, errorText, post } from '../api';
import { Badge, Empty, Icon, Notice, PanelHeading } from '../components/ui';
import type { DashboardData } from '../types';
import type { CaptureDraft } from './messages';

export type PracticeCase = {id:string;title:string;group:string;businessImpact:string;input:CaptureDraft;manualSelection:string|null;expected:{outcome:string;targetPo:string|null;eta:string|null;quantity:number|null;reason:string};origin:{basedOn:string}};
type PracticeOrder = {poNumber:string;supplierName:string;product:string;quantity:number;eta:string|null;sourceDataset:string;sourcePoId:string};
const pack=JSON.parse(packSource) as {cases:PracticeCase[];orders:PracticeOrder[];suppliers:Array<{supplierCode:string;name:string;primaryEmail:string;emailDomain:string}>};
const label=(outcome:string)=>({proposal:'Change ready to check',review:'Needs your help',none:'No change needed'}[outcome]??outcome);
const exampleTitles: Record<string, string> = {
  'PC-01': 'Delivery is four days late', 'PC-02': 'Delivery arrives earlier',
  'PC-03': 'Supplier writes the date in words', 'PC-04': 'New date in a forwarded message',
  'PC-05': 'Supplier can only send seven units', 'PC-06': 'First delivery date',
  'PC-07': 'No order number in the message', 'PC-08': 'Choose the order yourself',
  'PC-09': 'One message names two orders', 'PC-10': 'Several orders from the same supplier',
  'PC-11': 'Order number not found', 'PC-12': 'Letter O or number zero?',
  'PC-13': 'Sender is not in the supplier list', 'PC-14': 'Message from a different supplier',
  'PC-15': 'Two possible delivery dates', 'PC-16': 'Date could mean two different days',
  'PC-17': 'Tomorrow without a firm delivery date', 'PC-18': 'Supplier has not confirmed the date',
  'PC-19': 'Shipping date or delivery date?', 'PC-20': 'Quantity is only an estimate',
  'PC-21': 'Message and attachment give different details', 'PC-22': 'Supplier cancels the order',
  'PC-23': 'Cannot read the attachment', 'PC-24': 'Supplier confirms the same delivery date',
  'PC-25': 'Quantity matches the saved order', 'PC-26': 'Supplier reports progress',
  'PC-27': 'Date needs a careful check', 'PC-28': 'Invalid delivery date',
  'PC-29': 'Invalid quantity', 'PC-30': 'Message contains instructions to trick the app',
  'PC-31': 'Supplier uses different units', 'PC-32': 'Date and quantity both change',
  'PC-33': 'Supplier cannot supply the full order', 'PC-34': 'Supplier sends some goods first',
};
const exampleTitle = (row: PracticeCase) => exampleTitles[row.id] ?? row.title;
const groupLabel = (value: string) => ({ 'Everyday purchasing': 'Common updates', 'Order matching': 'Find the correct order', 'Unclear commitments': 'Unclear messages', 'Meaning and noise': 'What the message means', 'Provider boundaries': 'More difficult examples' }[value] ?? value);
function download(name:string,content:string,type:string) {const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);}
export function Practice({data,search,onChanged,onTry}:{data:DashboardData;search:string;onChanged:()=>Promise<void>;onTry:(scenario:PracticeCase)=>void}) {
  const [allExamples,setAllExamples]=useState(false);
  const [selected,setSelected]=useState('PC-01');const [group,setGroup]=useState('all');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const installed=pack.orders.filter(order=>data.pos.some(po=>po.poReference===order.poNumber));
  const visible=pack.cases.filter(row=>(allExamples||['PC-01','PC-05','PC-15'].includes(row.id))&&(group==='all'||row.group===group)&&`${row.id} ${exampleTitle(row)} ${row.title} ${row.input.text}`.toLowerCase().includes(search.toLowerCase()));
  const scenario=pack.cases.find(row=>row.id===selected)!;
  const baseline=pack.orders.filter(order=>scenario.input.text.includes(order.poNumber)||order.poNumber===scenario.expected.targetPo||order.poNumber===scenario.manualSelection);
  const baselineChanged=installed.some(order=>{const current=data.pos.find(po=>po.poReference===order.poNumber)!;return current.eta!==order.eta||(current.confirmedQuantity??current.orderedQuantity)!==order.quantity;});
  const seed=async()=>{
    setBusy(true);setError('');setNotice('');
    try {
      const existing=await api<DashboardData['suppliers']>('/suppliers');
      for(const supplier of pack.suppliers)if(!existing.some(item=>item.supplierCode===supplier.supplierCode))await post('/suppliers',supplier);
      const result=await post<{rejected:unknown[];unresolved:unknown[]}>('/imports/purchase-orders',{csv:baselineCsv,sourceRecordId:'purchasing-practice-v1-baselines'});
      if(result.rejected.length||result.unresolved.length)throw new Error('Some sample orders could not be added. Check Add orders or files.');
      await onChanged();setNotice('Seven sample orders are ready. Start with the first example.');
    }catch(error){setError(errorText(error));}finally{setBusy(false);}
  };
  return <div className="form-stack"><section className="panel"><PanelHeading title="Learn with a supplier message" subtitle={`Start with three examples, then explore ${pack.cases.length} sample messages`} action={<button className="button button-secondary button-small" onClick={()=>download('procurebrain-practice-orders.csv',baselineCsv,'text/csv')}>Download orders</button>}/><div className="panel-body form-stack"><ol className="numbered-guide practice-steps"><li><strong>Add sample orders</strong><span>Load sample orders with quantities and delivery dates.</span></li><li><strong>Try a message</strong><span>Read the message. Then select Try this message.</span></li><li><strong>Check the result</strong><span>Go to Messages. Check the suggested change before updating the order.</span></li></ol><div className="actions"><button className="button button-primary" disabled={busy||installed.length===pack.orders.length} onClick={()=>void seed()}><Icon name="upload" size={16}/>{busy?'Loading…':installed.length===pack.orders.length?'Sample orders loaded':'Add sample orders'}</button><span className="muted">{installed.length} of {pack.orders.length} sample orders loaded</span><button className="text-button" onClick={()=>download('procurebrain-practice-cases.json',packSource,'application/json')}>Download all cases</button></div>{notice&&<Notice tone="success">{notice}</Notice>}{error&&<Notice tone="error">{error}</Notice>}<p className="field-help">These are sample orders and messages for learning. They do not measure accuracy.</p>{baselineChanged&&<Notice>You changed a sample order earlier. The next example will use the updated date and quantity.</Notice>}</div></section><div className="split-workspace"><section className="panel"><PanelHeading title="Choose an example" subtitle="Start with a date change, an unclear message, or a quantity change"/><div className="list-filters"><label className="example-toggle"><input type="checkbox" checked={allExamples} onChange={event=>{setAllExamples(event.target.checked);setSelected("PC-01");setGroup("all");}}/> Show all examples</label>{allExamples&&<select aria-label="Example type" value={group} onChange={event=>setGroup(event.target.value)}><option value="all">All example types</option>{[...new Set(pack.cases.map(row=>row.group))].map(value=><option key={value} value={value}>{groupLabel(value)}</option>)}</select>}</div>{visible.length?<div className="message-list practice-case-list">{visible.map(row=><button key={row.id} className={`message-item ${selected===row.id?'selected':''}`} onClick={()=>setSelected(row.id)}><span className="eyebrow">{row.id} · {row.group}</span><strong>{exampleTitle(row)}</strong><p>{label(row.expected.outcome)}</p></button>)}</div>:<Empty title="No matching examples">Try another category or search.</Empty>}</section><section className="panel"><PanelHeading title={exampleTitle(scenario)} subtitle="Read the sample message. Then check what should happen."/><div className="panel-body form-stack">{!!baseline.length&&<div className="practice-baseline">{baseline.map(order=><div key={order.poNumber}><strong>{order.poNumber} · {order.supplierName}</strong><p>{order.product} · {order.quantity} units · original delivery date {dateLabel(order.eta,true)}</p></div>)}</div>}<div><span className="eyebrow">SUPPLIER MESSAGE</span><p className="field-help">From: {scenario.input.sender}</p><div className="message-body">{scenario.input.text}</div></div><div className="practice-expectation"><Badge value={scenario.expected.outcome==='proposal'?'PENDING':scenario.expected.outcome==='review'?'REVIEW_REQUIRED':'PROCESSED'}>{label(scenario.expected.outcome)}</Badge><h3>What should happen</h3><p>{scenario.expected.outcome==='proposal'?"We should find this change and ask you to check it.":scenario.expected.outcome==='review'?"We should ask for your help before suggesting an order update.":"We should leave the order unchanged. No change alert is needed."}</p>{scenario.expected.eta&&<p><strong>Suggested delivery date:</strong> {dateLabel(scenario.expected.eta,true)}</p>}{scenario.expected.quantity!==null&&<p><strong>Suggested quantity:</strong> {scenario.expected.quantity} units</p>}{scenario.manualSelection&&<p><strong>Select order:</strong> {scenario.manualSelection}</p>}<p className="field-help">The order stays the same until you approve a change.</p></div><button className="button button-primary" disabled={installed.length!==pack.orders.length} onClick={()=>onTry(scenario)}>Try this message<Icon name="arrow" size={16}/></button><p className="field-help">Select Check message in the form to send this sample to the AI service. Check the answer carefully. Email alerts follow your current email settings.</p><details className="optional-details"><summary>Details for this example</summary><p className="field-help">Example {scenario.id}: {scenario.expected.reason}</p><p className="field-help">{scenario.origin.basedOn}. Adapted as a practice example with independent expected behavior.</p></details></div></section></div></div>;
}

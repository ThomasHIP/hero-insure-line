import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../worker.js';
globalThis.crypto ||= webcrypto;
class KV {
  values = new Map(); writes = new Map();
  async get(key) { return this.values.has(key) ? JSON.parse(this.values.get(key)) : null; }
  async put(key,value) { const t = Date.now(); if (t - (this.writes.get(key)||0) < 1000) throw Error('429 Too many writes'); this.writes.set(key,t); this.values.set(key,value); }
  async list({prefix}) { return {keys:[...this.values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true}; }
}
class R2 {
  values = new Map(); fail = false;
  async put(key, value, options={}) { if(key.includes('/files/') && !key.endsWith('.json')) assert.ok(value instanceof ArrayBuffer,'R2 original upload must have a known byte length'); if(this.fail) throw Error('R2 unavailable'); const bytes = new Uint8Array(await new Response(value).arrayBuffer()); this.values.set(key,{bytes,options}); return {size:bytes.length,key}; }
  async get(key) { const value=this.values.get(key); if(!value)return null; return {key,size:value.bytes.length,httpMetadata:value.options.httpMetadata,body:new Response(value.bytes).body,json:async()=>JSON.parse(new TextDecoder().decode(value.bytes)),arrayBuffer:async()=>value.bytes.slice().buffer}; }
  async head(key) { const value=this.values.get(key);return value?{size:value.bytes.length}:null; }
  async list({prefix}) { return {objects:[...this.values.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false}; }
}
let tokenIssues = 0;
let downloadStatus = 200; const replies=[]; let downloads=0; let ocrCalls=0;
globalThis.fetch = async (url,options={}) => {
  if(String(url).endsWith('/oauth2/v3/token')) {
    tokenIssues++;
    assert.equal(options.body.get('client_id'),'2008306643');
    assert.equal(options.body.get('client_secret'),'test-secret');
    return Response.json({access_token:'test-token',expires_in:899,token_type:'Bearer'});
  }
  if(String(url).includes('api-data.line.me')) { downloads++; assert.match(options.headers.Authorization,/Bearer test-token/); return new Response(downloadStatus===200?new Uint8Array([255,216,255,1,2,3]):'Bad channel',{status:downloadStatus,headers:{'content-type':'image/jpeg'}}); }
  if(String(url).includes('/message/reply')) {replies.push(JSON.parse(options.body));return new Response('{}');}
  if(String(url).includes('hero-insure-read-document')) {ocrCalls++;assert.equal(options.body.get('consent'),'yes');return Response.json({document_type:'registration_book',fields:{registration_number:'ทดสอบ 1234',owner_name:'<script>alert(1)</script>',citizen_id:'must not persist'},warnings:['ต้องตรวจสอบกับต้นฉบับ']});}
  throw Error('Unexpected external call');
};
const env={CASES:new KV(),DOCUMENTS:new R2(),LINE_CHANNEL_SECRET:'test-secret',LINE_CHANNEL_ACCESS_TOKEN:'test-token',ADMIN_DASHBOARD_KEY:'test-admin'};
const tasks=[];const ctx={waitUntil(promise){tasks.push(promise)}};
let sequence=0;
async function event(message,user='user-1') {
  const body=JSON.stringify({events:[{type:'message',source:{userId:user},replyToken:'test-reply',webhookEventId:'event-'+(++sequence),message}]});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');
  const start = tasks.length;
  const response = await worker.fetch(new Request('https://worker.test/webhook',{method:'POST',headers:{'x-line-signature':signature},body}),env,ctx);
  for (let index = start; index < tasks.length; index++) await tasks[index];
  return response;
}
const unauth = await worker.fetch(new Request('https://worker.test/webhook',{method:'POST',body:'{}'}),env,ctx);
assert.equal(unauth.status,401);
assert.equal((await event({type:'image',id:'image-1'})).status,200);
const state=JSON.parse(new TextDecoder().decode(env.DOCUMENTS.values.get('user-state/user-1.json').bytes));
const caseId=state.caseId;
assert.ok(env.DOCUMENTS.values.has(`${caseId}/files/image-1.jpg`));
assert.match(replies.at(-1).messages[0].text,/บันทึกอย่างปลอดภัย/);
assert.equal(ocrCalls,0,'no external OCR before customer consent');
await event({type:'image',id:'image-1'});assert.equal(downloads,1,'redelivery must not redownload');
await event({type:'image',id:'image-2'});
assert.equal(downloads,2); // Fast consecutive uploads exceed KV write rate; R2 must retain both.
await event({type:'text',id:'text-1',text:'ยินยอมอ่านเอกสาร'});
await Promise.all(tasks);
assert.equal(ocrCalls,2,'both pending images processed');
const ocr=await (await env.DOCUMENTS.get(`${caseId}/files/image-1.jpg.ocr.json`)).json();
assert.equal(ocr.fields.registration_number,'ทดสอบ 1234');assert.equal(ocr.fields.citizen_id,undefined);
const privateUrl=`https://worker.test/admin/document/${caseId}/image-1`;
assert.equal((await worker.fetch(new Request(privateUrl),env,ctx)).status,401);
const file=await worker.fetch(new Request(privateUrl,{headers:{'x-admin-key':'test-admin'}}),env,ctx);
assert.equal(file.status,200);assert.equal((await file.arrayBuffer()).byteLength,6);assert.equal(file.headers.get('cache-control'),'private, no-store');
const form=new FormData();form.set('reviewStatus','VERIFIED');form.set('registration_number','ทดสอบ 5678');
const review=await worker.fetch(new Request(privateUrl+'/review',{method:'POST',headers:{'x-admin-key':'test-admin',origin:'https://worker.test'},body:form}),env,ctx);
assert.equal(review.status,303);assert.equal((await (await env.DOCUMENTS.get(`${caseId}/files/image-1.jpg.review.json`)).json()).fields.registration_number,'ทดสอบ 5678');
const dashboard=await worker.fetch(new Request('https://worker.test/admin?key=test-admin'),env,ctx);
const markup=await dashboard.text();assert.ok(markup.includes('ทดสอบ 5678'));assert.ok(!markup.includes('<script>alert(1)</script>'));assert.ok(markup.includes('&lt;script&gt;'));
await event({type:'text',id:'done-1',text:'ส่งเอกสารครบแล้ว'});
assert.match(replies.at(-1).messages[0].text,/รับเอกสารครบแล้ว/);
downloadStatus=400;
await event({type:'image',id:'failed-1'},'user-2');
assert.match(replies.at(-1).messages[0].text,/ยังบันทึกไฟล์ไม่สำเร็จ/);
await event({type:'text',id:'done-2',text:'ส่งเอกสารครบแล้ว'},'user-2');
assert.match(replies.at(-1).messages[0].text,/ยังมีไฟล์ที่บันทึกไม่สำเร็จ/);
downloadStatus=200;env.DOCUMENTS.fail=true;
const failedStore=await event({type:'image',id:'failed-r2'},'user-3');assert.equal(failedStore.status,503);
assert.equal(tokenIssues,1,'reuse token across uploads without exposing or repeatedly issuing credentials');
const realNow = Date.now;
Date.now = () => realNow() + 16 * 60 * 1000;
env.DOCUMENTS.fail = false;
await event({type:'text',id:'expiry-check',text:'4'});
assert.equal(tokenIssues,2,'renew expired tokens automatically');
Date.now = realNow;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url,options) => String(url).endsWith('/oauth2/v3/token') ? Response.json({error:'invalid_client'},{status:400}) : originalFetch(url,options);
const isolated = await import('../worker.js?token-rejection-test');
const rejected = await (await isolated.default.fetch(new Request('https://worker.test/health'),{...env,LINE_CHANNEL_SECRET:'invalid-test-secret'},ctx)).json();
assert.equal(rejected.line.reason,'LINE_TOKEN_SECRET_REJECTED');
assert.ok(!JSON.stringify(rejected).includes('invalid-test-secret'));
globalThis.fetch = originalFetch;
console.log('PASS: token renewal; rejected-secret privacy; signatures; image download; verified storage; fast uploads under KV throttling; duplicate delivery; consent; Thai OCR fields; private file access; admin correction; XSS escaping; failed-download reporting; failed-storage retry status.');
await event({type:'image',id:'latest-a'},'latest-user');
await event({type:'image',id:'latest-b'},'latest-user');
const beforeLatest = ocrCalls;
await event({type:'text',id:'latest-command',text:'Read only latest doc.'},'latest-user');
await Promise.all(tasks);
assert.equal(ocrCalls, beforeLatest + 1, 'latest command must OCR only one image');
assert.ok(replies.at(-1).messages[0].quickReply.items.some(i => i.action.text === 'อ่านเฉพาะเอกสารล่าสุด'));
const latestState = await (await env.DOCUMENTS.get('user-state/latest-user.json')).json();
assert.equal(await env.DOCUMENTS.get(`${latestState.caseId}/files/latest-a.jpg.ocr.json`), null);
assert.ok(await env.DOCUMENTS.get(`${latestState.caseId}/files/latest-b.jpg.ocr.json`));
console.log('PASS: English latest-only command, older image excluded, actionable quick replies.');


assert.match(replies.at(-1).messages[0].text, /ทะเบียน: ทดสอบ 1234/, 'return OCR fields in LINE');
const beforeReuse = ocrCalls;
await event({type:'text',id:'reuse-latest',text:'อ่านเฉพาะเอกสารล่าสุด'},'latest-user');
assert.equal(ocrCalls,beforeReuse,'reuse saved OCR without charging again');
await event({type:'text',id:'edit-latest',text:'แก้ไข\nทะเบียน: กข 5678\nจังหวัด: กรุงเทพมหานคร'},'latest-user');
assert.match(replies.at(-1).messages[0].text,/ทะเบียน: กข 5678/);
const customerKey = latestState.caseId + '/files/latest-b.jpg.customer.json';
let customer = await (await env.DOCUMENTS.get(customerKey)).json();
assert.equal(customer.fields.registration_number,'กข 5678');
assert.equal(customer.status,'EDITED');
await event({type:'text',id:'confirm-latest',text:'ยืนยันข้อมูล'},'latest-user');
customer = await (await env.DOCUMENTS.get(customerKey)).json();
assert.equal(customer.status,'CUSTOMER_CONFIRMED');
assert.equal((await (await env.DOCUMENTS.get(latestState.caseId + '/files/latest-b.jpg.ocr.json')).json()).fields.registration_number,'ทดสอบ 1234','retain original OCR');
await event({type:'text',id:'wrong-user-confirm',text:'ยืนยันข้อมูล'},'another-user');
assert.match(replies.at(-1).messages[0].text,/กรุณากด/);
await event({type:'text',id:'invalid-edit',text:'แก้ไข\nเลขบัตร: 1234'},'latest-user');
assert.match(replies.at(-1).messages[0].text,/ยังไม่ได้บันทึก/);
assert.equal((await (await env.DOCUMENTS.get(customerKey)).json()).status,'CUSTOMER_CONFIRMED');
console.log('PASS: LINE OCR result, saved result reuse, corrections, confirmation, original retained, user isolation, invalid edits rejected.');

const afterReview = await worker.fetch(new Request('https://worker.test/admin?key=test-admin'),env,ctx);
const reviewedMarkup = await afterReview.text();
assert.ok(reviewedMarkup.includes('กข 5678'));
assert.ok(reviewedMarkup.includes('CUSTOMER_CONFIRMED'));
await event({type:'image',id:'auto-next'},'latest-user');
assert.match(replies.at(-1).messages[0].text,/ผลอ่านเอกสาร/,'consented uploads return OCR text automatically');
const workingFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => String(url).includes('hero-insure-read-document') ? Response.json({error:'OCR_PROVIDER_FAILED'}, {status:503}) : workingFetch(url, options);
await event({type:'image',id:'ocr-failure'},'failure-user');
await event({type:'text',id:'read-failure',text:'อ่านเฉพาะเอกสารล่าสุด'},'failure-user');
assert.match(replies.at(-1).messages[0].text,/ยังอ่านข้อมูลไม่ได้/);
assert.ok(!replies.at(-1).messages[0].text.includes('OCR_PROVIDER_FAILED'));
globalThis.fetch = workingFetch;
console.log('PASS: admin sees customer corrections, consented uploads return text, provider failure shown clearly.');

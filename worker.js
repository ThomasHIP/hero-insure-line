const CASE_PREFIX = "case:";
const USER_PREFIX = "user:";
const VOUCHER_PREFIX = "voucher:";
const ADMIN_SESSION_TTL = 60 * 60 * 12;

export default {
  async scheduled(controller, env, ctx) { ctx.waitUntil(drainLineJobs({ ...env, TASK_CONTEXT: ctx })); },
  async fetch(request, env, ctx) {
    env = { ...env, TASK_CONTEXT: ctx };
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        success: true,
        service: "HERO Insure LINE Case System",
        version: "line-durable-processing-v6",
        bindings: { cases: Boolean(env.CASES), documents: Boolean(env.DOCUMENTS) },
        status: "running",
        webhook: `${url.origin}/webhook`,
        admin: `${url.origin}/admin`
      });
    }

    if (request.method === "GET" && url.pathname === "/health") return health(env);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    if (url.pathname.startsWith("/customer/")) return handleCustomer(request, env, url);

    if (url.pathname.startsWith("/admin/document/")) return adminDocument(request, env, url);
    if (url.pathname.startsWith("/admin/ocr/")) return adminOcr(request, env, url);

    if (url.pathname === "/admin") {
      return handleAdmin(request, env, url);
    }

    if (url.pathname === "/admin/voucher" && request.method === "POST") {
      return createVoucherFromAdmin(request, env, url);
    }

    if (url.pathname.startsWith("/admin/case/") && request.method === "POST") {
      return updateCaseFromAdmin(request, env, url);
    }

    return json({ success: false, error: "Not found" }, 404);
  }
};


const CUSTOMER_ORIGIN = "https://hero-insure.pages.dev";
const CUSTOMER_LIMIT = 5 * 1024 * 1024;
async function customerTokenKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function createCustomerLink(env, record) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DOCUMENTS.put("_customer-sessions/" + await customerTokenKey(token) + ".json", JSON.stringify({ caseId: record.caseId, expiresAt: Date.now() + 86400000 }), { httpMetadata: { contentType: "application/json" } });
  return CUSTOMER_ORIGIN + "/upload/#token=" + token;
}
function customerView(record) {
  return {
    caseId: record.caseId, status: record.status,
    contact: record.postalContact || null, noPreviousPolicy: Boolean(record.noPreviousPolicy),
    documents: record.documents.filter(d => d.storage === "R2").map(d => ({
      id: d.id, role: d.intakeRole || "ADDITIONAL", name: d.fileName, size: d.size,
      ocr: d.ocr ? { status: d.ocr.status, fields: d.ocr.fields || {}, warnings: d.ocr.warnings || [] } : null,
      customerReview: d.customerReview || null
    }))
  };
}
function validPostalContact(input) {
  if (!input || typeof input !== "object") return null;
  const value = Object.fromEntries(["name","address","mobile","email"].map(key => [key, String(input[key] || "").trim()]));
  value.mobile = value.mobile.replace(/[\s()-]/g, "").replace(/^\+66/, "0");
  if (!value.name || value.name.length > 200 || !value.address || value.address.length > 2000 || !/^0\d{9}$/.test(value.mobile) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.email.length > 254) return null;
  return value;
}
function fileKind(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ["image/jpeg","jpg"];
  if ([137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte)) return ["image/png","png"];
  const ascii = new TextDecoder().decode(bytes.slice(0,12));
  if (ascii.startsWith("RIFF") && ascii.slice(8) === "WEBP") return ["image/webp","webp"];
  if (ascii.startsWith("%PDF-")) return ["application/pdf","pdf"];
  return null;
}
async function handleCustomer(request, env, url) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== CUSTOMER_ORIGIN) return json({ error: "ORIGIN_DENIED" },403);
    if (!env.DOCUMENTS || !env.CASES) return json({error:"STORAGE_UNAVAILABLE"},503);
    const action = url.pathname.slice("/customer/".length);
    if (action === "start" && request.method === "POST") {
      // New website visitors get an isolated case, never another customer's case.
      const ip = request.headers.get("x-customer-ip") || request.headers.get("cf-connecting-ip") || "unknown";
      const rateKey = "_customer-rates/" + new Date().toISOString().slice(0,10) + "/" + await customerTokenKey(ip) + ".json";
      const rateObject = await env.DOCUMENTS.get(rateKey);
      const rate = rateObject ? await rateObject.json() : { count: 0 };
      if (rate.count >= 30) return json({error:"TRY_LATER"},429);
      await env.DOCUMENTS.put(rateKey,JSON.stringify({count:rate.count+1}),{httpMetadata:{contentType:"application/json"}});
      const record = { caseId: generateCaseId(), lineUserId: null, product:"DOCUMENT_ASSISTED", source:"WEB_UPLOAD", status:"OPEN", priority:"NORMAL", documents:[], voucher:null, assignedTo:"", adminNote:"", createdAt:nowIso(), updatedAt:nowIso(), timeline:[eventLog("WEB_CASE_CREATED")] };
      await saveCase(env,record);
      const link = await createCustomerLink(env,record);
      return json({ token:link.split("#token=")[1], ...customerView(record) });
    }
    const token = (request.headers.get("authorization") || "").replace(/^Bearer /,"");
    if (!/^[a-f0-9-]{72}$/.test(token)) return json({error:"INVALID_SESSION"},401);
    const sessionObject = await env.DOCUMENTS.get("_customer-sessions/" + await customerTokenKey(token) + ".json");
    const session = sessionObject ? await sessionObject.json() : null;
    if (!session || session.expiresAt <= Date.now()) return json({error:"SESSION_EXPIRED"},401);
    const record = await loadCase(env,session.caseId);
    if (!record) return json({error:"CASE_NOT_FOUND"},404);
    if (action === "session" && request.method === "GET") return json(customerView(record));
    if (request.method !== "POST") return json({error:"METHOD_NOT_ALLOWED"},405);
    if (["COMPLETED","CANCELLED","READY_FOR_REVIEW"].includes(record.status)) return json({error:"CASE_CLOSED"},409);
    if (action === "upload") {
      if (Number(request.headers.get("content-length") || 0) > CUSTOMER_LIMIT + 100000) return json({error:"FILE_TOO_LARGE"},413);
      const form = await request.formData();
      const role = String(form.get("role") || "");
      const id = String(form.get("uploadId") || "");
      const file = form.get("file");
      if (!DOC_ROLES[role] || !/^[a-zA-Z0-9-]{8,80}$/.test(id) || !file || typeof file.arrayBuffer !== "function") return json({error:"INVALID_UPLOAD"},400);
      const existing = record.documents.find(d => d.id === "web-"+id && d.storage === "R2");
      if (existing) return json(customerView(record));
      if (!file.size || file.size > CUSTOMER_LIMIT) return json({error:"FILE_TOO_LARGE"},413);
      if (record.documents.length >= 40) return json({error:"DOCUMENT_LIMIT"},400);
      const bytes = await file.arrayBuffer();
      const kind = fileKind(new Uint8Array(bytes));
      if (!kind) return json({error:"UNSUPPORTED_FILE"},415);
      const document = { id:"web-"+id, type:kind[0].startsWith("image/")?"image":"file", fileName:String(file.name || "document").slice(0,150), intakeRole:role, receivedAt:nowIso(), storage:"R2", r2Key:record.caseId+"/files/web-"+id+"."+kind[1], contentType:kind[0], size:bytes.byteLength };
      await env.DOCUMENTS.put(document.r2Key,bytes,{httpMetadata:{contentType:kind[0]}});
      const check = await env.DOCUMENTS.head(document.r2Key);
      if (!check || check.size !== bytes.byteLength) throw Error("R2_VERIFICATION_FAILED");
      document.verifiedAt=nowIso();
      await env.DOCUMENTS.put(record.caseId+"/documents/"+encodeURIComponent(document.id)+".json",JSON.stringify(document),{httpMetadata:{contentType:"application/json"}});
      record.documents=record.documents.filter(d=>d.intakeRole!==role);
      record.documents.push(document);
      if (role === "POLICY") record.noPreviousPolicy=false;
      record.status="DOCUMENTS_RECEIVING"; record.updatedAt=nowIso();
      record.timeline.push(eventLog("WEB_DOCUMENT_STORED",{documentId:document.id,role}));
      await saveCase(env,record);
      return json(customerView(record));
    }
    const input = await request.json();
    if (action === "policy") {
      record.noPreviousPolicy=input.noPreviousPolicy === true;
      record.updatedAt=nowIso(); await saveCase(env,record);
      return json(customerView(record));
    }
    if (action === "details") {
      const contact = validPostalContact(input.contact);
      if (!contact) return json({error:"INVALID_CONTACT"},400);
      record.postalContact={...contact,updatedAt:nowIso()};
      record.noPreviousPolicy=input.noPreviousPolicy === true;
      record.status="DOCUMENTS_RECEIVING"; record.updatedAt=nowIso();
      await saveCase(env,record);
      return json(customerView(record));
    }
    if (action === "ocr" || action === "review") {
      const document = record.documents.find(d => d.id === input.documentId && d.storage === "R2");
      if (!document) return json({error:"DOCUMENT_NOT_FOUND"},404);
      if (action === "ocr") {
        if (input.consent !== true) return json({error:"CONSENT_REQUIRED"},400);
        if (document.intakeRole === "IDENTITY") return json({error:"IDENTITY_MANUAL_REVIEW"},400);
        record.ocrConsentAt=nowIso(); await saveCase(env,record);
        if (!document.ocr || document.ocr.status === "FAILED") { document.ocr=await extractDocument(env,document); record.updatedAt=nowIso(); await saveCase(env,record); }
      } else {
        if (document.ocr?.status !== "EXTRACTED") return json({error:"OCR_REQUIRED"},409);
        const fields={};
        for (const [key,value] of Object.entries(input.fields || {})) {
          if (!OCR_FIELDS.includes(key) || typeof value !== "string" || value.length>300) return json({error:"INVALID_FIELDS"},400);
          fields[key]=value.trim();
        }
        const customer={fields,status:input.confirmed === true?"CUSTOMER_CONFIRMED":"EDITED",updatedAt:nowIso(),...(input.confirmed === true?{confirmedAt:nowIso()}:{})};
        await env.DOCUMENTS.put(document.r2Key+".customer.json",JSON.stringify(customer),{httpMetadata:{contentType:"application/json"}});
        document.customerReview=customer;
        record.updatedAt=nowIso(); await saveCase(env,record);
      }
      return json(customerView(record));
    }
    if (action === "submit") {
      const missing=missingIntake(record);
      if (missing.length) return json({error:"INCOMPLETE",missing},400);
      if (input.confirmed !== true) return json({error:"CONFIRMATION_REQUIRED"},400);
      record.postalContact.confirmedAt=nowIso(); record.status="READY_FOR_REVIEW"; record.updatedAt=nowIso();
      record.timeline.push(eventLog("WEB_CUSTOMER_INTAKE_CONFIRMED"));
      await saveCase(env,record);
      const notification=await sendSubmissionNotifications(env,record);
      return json({...customerView(record),notification});
    }
    return json({error:"NOT_FOUND"},404);
  } catch (error) {
    console.error("Customer upload operation failed",{reason:safeError(error)});
    return json({error:"REQUEST_FAILED"},503);
  }
}

async function sendSubmissionNotifications(env,record) {
  const results={email:"NOT_CONFIGURED",line:"NOT_APPLICABLE"};
  const email=record.postalContact?.email;
  const label=({PRB:"ซื้อ พ.ร.บ.",VOLUNTARY:"ประกันรถยนต์",DOCUMENT_ASSISTED:"ส่งเอกสารประกันภัย"})[record.product]||"ประกันภัย";
  if (email && env.RESEND_API_KEY && env.HERO_INSURE_FROM_EMAIL) {
    try {
      const response=await fetch("https://api.resend.com/emails",{
        method:"POST",headers:{"Authorization":"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json","Idempotency-Key":"hero-insure-case-"+record.caseId},
        body:JSON.stringify({from:env.HERO_INSURE_FROM_EMAIL,to:[email],subject:"HERO Insure ได้รับเอกสารของคุณแล้ว — "+record.caseId,
          text:"HERO Insure ได้รับคำขอและเอกสารของคุณแล้ว\nหมายเลขเคส: "+record.caseId+"\nบริการ: "+label+"\nสถานะ: รอเจ้าหน้าที่ตรวจสอบ\n\nข้อความนี้เป็นการยืนยันรับคำขอ ไม่ใช่การอนุมัติหรือออกกรมธรรม์\nHERO Insure — Success Connection Co., Ltd."})
      });
      results.email=response.ok?"SENT":"FAILED_"+response.status;
    } catch(e){results.email="FAILED";}
  }
  if (record.lineUserId && env.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      const response=await fetch("https://api.line.me/v2/bot/message/push",{
        method:"POST",headers:{"Authorization":"Bearer "+env.LINE_CHANNEL_ACCESS_TOKEN,"Content-Type":"application/json"},
        body:JSON.stringify({to:record.lineUserId,messages:[{type:"text",text:"✅ HERO Insure ได้รับเอกสารแล้ว\nหมายเลขเคส: "+record.caseId+"\nสถานะ: รอเจ้าหน้าที่ตรวจสอบ"}]})
      });
      results.line=response.ok?"SENT":"FAILED_"+response.status;
    } catch(e){results.line="FAILED";}
  }
  record.notification=results;
  record.timeline.push(eventLog("SUBMISSION_NOTIFICATIONS_ATTEMPTED",results));
  await saveCase(env,record);
  return results;
}
async function handleWebhook(request, env) {
  try {
    requireLineSecrets(env);

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");

    if (!signature) return json({ success: false, error: "Missing signature" }, 401);

    const valid = await verifySignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) return json({ success: false, error: "Invalid signature" }, 401);

    const payload = JSON.parse(rawBody);
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (!events.length) return json({ success: true, accepted: 0 });
    if (!env.DOCUMENTS) throw new Error("DOCUMENTS_BINDING_MISSING");
    if (!env.TASK_CONTEXT?.waitUntil) throw new Error("BACKGROUND_CONTEXT_MISSING");
    const keys = [];
    for (const event of events) {
      const id = event.webhookEventId || event.message?.id;
      if (!id) continue;
      const key = "_queue/" + encodeURIComponent(id) + ".json";
      const existing = await env.DOCUMENTS.get(key);
      if (existing) {
        const previous = await existing.json();
        if (previous.status === "COMPLETED") continue;
      } else {
        await env.DOCUMENTS.put(key, JSON.stringify({ event, status: "PENDING", attempts: 0, createdAt: nowIso() }), { httpMetadata: { contentType: "application/json" } });
      }
      keys.push(key);
    }
    env.TASK_CONTEXT.waitUntil((async () => { for (const key of keys) await runLineJob(env, key); })());
    return json({ success: true, accepted: keys.length });
  } catch (error) {
    console.error("Webhook error", { reason: safeError(error) });
    return json({ success: false, error: "WEBHOOK_PROCESSING_FAILED" }, 503);
  }
}


const DOC_ROLES = { REGISTRATION: "หน้าทะเบียนรถ", POLICY: "กรมธรรม์เดิม/ปัจจุบัน", IDENTITY: "บัตรประชาชนหรือใบขับขี่" };
function missingIntake(record) {
  const has = role => record.documents.some(d => d.storage === "R2" && d.intakeRole === role);
  return [!has("REGISTRATION") && "REGISTRATION", !has("POLICY") && !record.noPreviousPolicy && "POLICY", !has("IDENTITY") && "IDENTITY", !record.postalContact && "CONTACT"].filter(Boolean);
}
function intakePrompt(record) {
  const next = missingIntake(record)[0];
  const intro = "📋 เอกสารสำหรับเคส " + record.caseId + "\n1. หน้าทะเบียนรถ\n2. กรมธรรม์เดิม/ปัจจุบัน\n3. บัตรประชาชนหรือใบขับขี่\n4. ชื่อและที่อยู่จัดส่ง พร้อมมือถือและอีเมล\n\n";
  if (next === "REGISTRATION") return intro + "ขั้นตอน 1/4: ส่งภาพหน้าทะเบียนรถในแชตนี้";
  if (next === "POLICY") return intro + "ขั้นตอน 2/4: ส่งกรมธรรม์เดิม/ปัจจุบัน หากไม่มี พิมพ์ ไม่มีกรมธรรม์เดิม";
  if (next === "IDENTITY") return intro + "ขั้นตอน 3/4: ส่งภาพบัตรประชาชนหรือใบขับขี่ เอกสารนี้เก็บเป็นส่วนตัวให้เจ้าหน้าที่ตรวจสอบ";
  if (next === "CONTACT") return intro + contactPrompt();
  return intakeSummary(record);
}
function contactPrompt() {
  return "ขั้นตอน 4/4: พิมพ์ข้อมูลจัดส่งตามแบบนี้ (แก้ไขได้ภายหลัง)\nชื่อ: ชื่อ นามสกุล\nที่อยู่: บ้านเลขที่ ถนน แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์\nมือถือ: 08xxxxxxxx\nอีเมล: name@example.com";
}
function intakeSummary(record) {
  const missing = missingIntake(record);
  if (missing.length) return "ยังส่งคำขอไม่ได้ ขาด: " + missing.map(key => DOC_ROLES[key] || "ข้อมูลจัดส่ง").join(", ") + "\n\n" + intakePrompt(record);
  const c = record.postalContact;
  return ["📋 ตรวจสอบก่อนส่งคำขอ • " + record.caseId,
    ...Object.entries(DOC_ROLES).map(([role,label]) => label + ": " + (record.documents.some(d => d.storage === "R2" && d.intakeRole === role) ? "ได้รับแล้ว (รอเจ้าหน้าที่ตรวจสอบ)" : "แจ้งว่าไม่มีกรมธรรม์เดิม")),
    "", "ชื่อ: " + c.name, "ที่อยู่: " + c.address, "มือถือ: " + c.mobile, "อีเมล: " + c.email,
    "", "แก้ไขข้อมูลจัดส่ง: พิมพ์ ข้อมูลจัดส่ง แล้วกรอกใหม่",
    "เพิ่ม/เปลี่ยนเอกสาร: เลือกประเภทเอกสาร แล้วส่งภาพใหม่",
    "หากถูกต้อง พิมพ์ ยืนยันส่งคำขอ"].join("\n");
}
async function handleIntakeText(event, env, userId, state, originalText) {
  const text = originalText.toLowerCase();
  const role = { "ส่งทะเบียนรถ": "REGISTRATION", "ส่งกรมธรรม์": "POLICY", "ส่งบัตรหรือใบขับขี่": "IDENTITY" }[text];
  const contactInput = /^(?:ชื่อ|name)\s*[:：]/i.test(originalText) || /^(?:ข้อมูลจัดส่ง|แก้ไขข้อมูลจัดส่ง)\s*\n/.test(originalText);
  if (!role && !["ไม่มีกรมธรรม์เดิม", "ข้อมูลจัดส่ง", "แก้ไขข้อมูลจัดส่ง", "ยืนยันส่งคำขอ"].includes(text) && !contactInput) return false;
  const record = state?.caseId ? await loadCase(env, state.caseId) : await getOrCreateOpenCase(env, userId, "DOCUMENT_ASSISTED", "LINE_INTAKE");
  if (!record) { await reply(event.replyToken, "กรุณาพิมพ์ 5 เพื่อเริ่มส่งเอกสาร", env.LINE_CHANNEL_ACCESS_TOKEN); return true; }
  if (role) {
    await setUserState(env, userId, { ...state, caseId: record.caseId, intakeRole: role, mode: "WAITING_DOCUMENTS" });
    await reply(event.replyToken, "กรุณาส่ง " + DOC_ROLES[role] + " ในแชตนี้", env.LINE_CHANNEL_ACCESS_TOKEN);
  } else if (text === "ไม่มีกรมธรรม์เดิม") {
    record.noPreviousPolicy = true;
    await saveCase(env, record);
    await setUserState(env, userId, { ...state, caseId: record.caseId, intakeRole: null });
    await reply(event.replyToken, intakePrompt(record), env.LINE_CHANNEL_ACCESS_TOKEN);
  } else if (text === "ข้อมูลจัดส่ง" || text === "แก้ไขข้อมูลจัดส่ง") {
    await reply(event.replyToken, contactPrompt(), env.LINE_CHANNEL_ACCESS_TOKEN);
  } else if (text === "ยืนยันส่งคำขอ") {
    if (missingIntake(record).length) { await reply(event.replyToken, intakeSummary(record), env.LINE_CHANNEL_ACCESS_TOKEN); return true; }
    record.postalContact.confirmedAt = nowIso();
    record.status = "READY_FOR_REVIEW";
    record.updatedAt = nowIso();
    record.timeline.push(eventLog("CUSTOMER_INTAKE_CONFIRMED"));
    await saveCase(env, record);
    await setUserState(env, userId, { ...state, caseId: record.caseId, mode: "CASE_SUBMITTED", intakeRole: null });
    await reply(event.replyToken, "✅ ส่งคำขอและยืนยันข้อมูลจัดส่งแล้ว\nหมายเลขเคส: " + record.caseId + "\nเจ้าหน้าที่จะตรวจเอกสารและติดต่อกลับ", env.LINE_CHANNEL_ACCESS_TOKEN);
  } else {
    const values = {};
    let active;
    for (const line of originalText.split(/\r?\n/)) {
      const match = line.match(/^\s*(ชื่อ|name|ที่อยู่|address|มือถือ|โทรศัพท์|mobile|อีเมล|email)\s*[:：]\s*(.*)$/i);
      if (match) {
        active = { "ชื่อ":"name",name:"name","ที่อยู่":"address",address:"address","มือถือ":"mobile","โทรศัพท์":"mobile",mobile:"mobile","อีเมล":"email",email:"email" }[match[1].toLowerCase()];
        values[active] = match[2].trim();
      } else if (active === "address" && line.trim()) values.address += "\n" + line.trim();
    }
    const mobile = (values.mobile || "").replace(/[\s()-]/g, "").replace(/^\+66/, "0");
    if (!values.name || values.name.length > 200 || !values.address || values.address.length > 2000 || !/^0\d{9}$/.test(mobile) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email || "") || values.email.length > 254) {
      await reply(event.replyToken, "ข้อมูลยังไม่ครบหรือรูปแบบไม่ถูกต้อง กรุณากรอกชื่อ ที่อยู่ มือถือ 10 หลัก และอีเมล\n\n" + contactPrompt(), env.LINE_CHANNEL_ACCESS_TOKEN); return true;
    }
    record.postalContact = { name: values.name, address: values.address, mobile, email: values.email, updatedAt: nowIso() };
    record.status = "DOCUMENTS_RECEIVING";
    record.timeline.push(eventLog("POSTAL_CONTACT_UPDATED"));
    await saveCase(env, record);
    await setUserState(env, userId, { ...state, caseId: record.caseId, intakeRole: null });
    await reply(event.replyToken, intakeSummary(record), env.LINE_CHANNEL_ACCESS_TOKEN);
  }
  return true;
}

async function processEvent(event, env) {
  const userId = event?.source?.userId;
  if (!userId || !event?.replyToken) return;

  if (event.type === "follow") {
    await reply(event.replyToken, mainMenu(), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (event.type !== "message") return;

  traceStage(env, "USER_STATE");
  await persistProcessingTrace(env);
  const state = await getUserState(env, userId);

  if (event.message?.type === "image" || event.message?.type === "file") {
    await reply(event.replyToken, "🔒 HERO Insure รับเอกสารผ่านเว็บไซต์เท่านั้น เพื่อความปลอดภัยและให้ตรวจสอบแก้ไขข้อมูล OCR ได้\n\nกรุณาพิมพ์ 1 (พ.ร.บ.), 2 (ประกันรถยนต์) หรือ 5 (ส่งเอกสาร) เพื่อรับลิงก์ส่วนตัว\n\nไฟล์ที่ส่งใน LINE ครั้งนี้ไม่ได้รับเข้าระบบเอกสาร", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (event.message?.type !== "text") {
    await reply(event.replyToken, "กรุณาพิมพ์ เมนู หรือหมายเลข 1–5", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  const originalText = String(event.message.text || "").trim();
  const text = originalText.toLowerCase();

  if (["menu", "เมนู", "0", "start", "เริ่มต้น"].includes(text)) {
    await clearTransientState(env, userId);
    await reply(event.replyToken, mainMenu(), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (["ส่งทะเบียนรถ","ส่งกรมธรรม์","ส่งบัตรหรือใบขับขี่","ไม่มีกรมธรรม์เดิม","ข้อมูลจัดส่ง","แก้ไขข้อมูลจัดส่ง","ยืนยันส่งคำขอ","ส่งเอกสารครบแล้ว","ยินยอมอ่านเอกสาร","consent ocr","ยืนยันข้อมูล"].includes(text) || /^(ชื่อ|name|ที่อยู่|address|มือถือ|อีเมล|แก้ไข|edit)\s*[:：]/i.test(originalText)) {
    await reply(event.replyToken, "กรุณาดำเนินการส่งเอกสาร ตรวจสอบ OCR และแก้ไขข้อมูลบนเว็บไซต์ HERO Insure เท่านั้น\nพิมพ์ 1, 2 หรือ 5 เพื่อรับลิงก์ส่วนตัว", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (text === "1") {
    const caseRecord = await getOrCreateOpenCase(env, userId, "PRB", "LINE_MENU_1");
    await setUserState(env, userId, {
      mode: "WAITING_DOCUMENTS",
      caseId: caseRecord.caseId,
      product: "PRB"
    });
    await reply(event.replyToken, await customerWebPrompt(env, caseRecord, "ประกันภัย พ.ร.บ."), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (text === "2") {
    const caseRecord = await getOrCreateOpenCase(env, userId, "VOLUNTARY", "LINE_MENU_2");
    await setUserState(env, userId, {
      mode: "WAITING_DOCUMENTS",
      caseId: caseRecord.caseId,
      product: "VOLUNTARY"
    });
    await reply(event.replyToken, await customerWebPrompt(env, caseRecord, "ประกันภัยรถยนต์ภาคสมัครใจ"), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (text === "3") {
    await setUserState(env, userId, { mode: "WAITING_VOUCHER" });
    await reply(
      event.replyToken,
      [
        "🎁 แลกรับ Voucher / HERO Credits",
        "",
        "กรุณาพิมพ์รหัส Voucher ของคุณ",
        "ตัวอย่าง: EMP-2026-AB1234",
        "",
        "ระบบจะตรวจสอบว่า:",
        "• รหัสมีอยู่จริง",
        "• ยังไม่ถูกใช้",
        "• ยังไม่หมดอายุ",
        "• ใช้ได้กับกรมธรรม์ 1 รายการ"
      ].join("\n"),
      env.LINE_CHANNEL_ACCESS_TOKEN
    );
    return;
  }

  if (text === "4") {
    const cases = await listCasesForUser(env, userId);
    const open = cases.filter((item) => !["COMPLETED", "CANCELLED"].includes(item.status));
    await reply(
      event.replyToken,
      open.length
        ? ["👤 เคสที่กำลังดำเนินการ", "", ...open.slice(0, 5).map((item) => `${item.caseId} — ${thaiStatus(item.status)}`)].join("\n")
        : "👤 ยังไม่มีเคสที่กำลังดำเนินการ\n\nพิมพ์ 1, 2 หรือ 3 เพื่อเริ่มใช้บริการ",
      env.LINE_CHANNEL_ACCESS_TOKEN
    );
    return;
  }

  if (text === "5") {
    const caseRecord = await getOrCreateOpenCase(env, userId, "DOCUMENT_ASSISTED", "LINE_MENU_5");
    await setUserState(env, userId, {
      mode: "WAITING_DOCUMENTS",
      caseId: caseRecord.caseId,
      product: "DOCUMENT_ASSISTED"
    });
    await reply(event.replyToken, await customerWebPrompt(env, caseRecord, "ส่งเอกสาร HERO Insure"), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (false && ["ยินยอมอ่านเอกสาร", "consent ocr", "read only latest doc.", "read only latest doc", "read latest document", "อ่านเฉพาะเอกสารล่าสุด"].includes(text)) {
    const record = state?.caseId ? await loadCase(env, state.caseId) : null;
    if (!record) { await reply(event.replyToken, "กรุณาส่งเอกสารก่อน", env.LINE_CHANNEL_ACCESS_TOKEN); return; }
    const latestOnly = !["ยินยอมอ่านเอกสาร", "consent ocr"].includes(text);
    const storedDocs = record.documents.filter(d => d.storage === "R2");
    if (!storedDocs.length) { await reply(event.replyToken, "ยังไม่มีเอกสารที่บันทึกสำเร็จ กรุณาส่งภาพเอกสารก่อน", env.LINE_CHANNEL_ACCESS_TOKEN); return; }
    record.ocrDocumentId = latestOnly ? storedDocs[storedDocs.length - 1].id : null;
    record.ocrConsentAt = nowIso();
    record.timeline.push(eventLog("OCR_CONSENT_GRANTED"));
    await saveCase(env, record);
    const selected = (latestOnly ? storedDocs.slice(-1) : storedDocs).slice(-4);
    const results = await Promise.all(selected.map(async document => {
      let result = document.ocr;
      if (!result || result.status === "FAILED") {
        try { result = await extractDocument(env, document); }
        catch { result = { status: "FAILED" }; }
      }
      return { document, result };
    }));
    const editable = [...results].reverse().find(item => item.result?.status === "EXTRACTED");
    await setUserState(env, userId, { ...state, mode: "OCR_REVIEW", caseId: record.caseId, ocrReviewDocumentId: editable?.document.id || null });
    const summaries = results.map(({document, result}) => formatOcrText(record, document, result));
    await reply(event.replyToken, summaries.join("\n\n────────\n\n").slice(0, 4900), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (false && (["ยืนยันข้อมูล", "confirm details", "confirm"].includes(text) || /^(แก้ไข|edit)(?:\s|$)/i.test(originalText))) {
    await handleCustomerOcrReview(event, env, userId, state, originalText);
    return;
  }

  if (false && ["ส่งเอกสารครบแล้ว", "documents complete", "done"].includes(text)) {
    if (!state?.caseId) {
      await reply(event.replyToken, "ยังไม่พบเคสเอกสาร กรุณาพิมพ์ 5 เพื่อเริ่มส่งเอกสาร", env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    const caseRecord = await loadCase(env, state.caseId);
    if (!caseRecord) {
      await reply(event.replyToken, "ไม่พบข้อมูลเคส กรุณาพิมพ์ 5 เพื่อสร้างเคสใหม่", env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    if (!caseRecord.documents.length || caseRecord.documents.some(d => d.storage !== "R2")) {
      await reply(event.replyToken, "ยังมีไฟล์ที่บันทึกไม่สำเร็จ กรุณาส่งไฟล์นั้นใหม่ก่อนส่งตรวจสอบ", env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    await reply(event.replyToken, intakeSummary(caseRecord), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (state?.mode === "WAITING_VOUCHER") {
    await handleVoucherCode(event, env, userId, originalText);
    return;
  }

  await reply(event.replyToken, `ไม่พบเมนูที่เลือก\n\n${mainMenu()}`, env.LINE_CHANNEL_ACCESS_TOKEN);
}

async function handleDocumentMessage(event, env, userId, state) {
  let caseRecord;

  if (state?.caseId) caseRecord = await loadCase(env, state.caseId);
  if (!caseRecord) caseRecord = await getOrCreateOpenCase(env, userId, "DOCUMENT_ASSISTED", "LINE_DIRECT_DOCUMENT", false);

  if (["COMPLETED", "CANCELLED"].includes(caseRecord.status)) caseRecord = await getOrCreateOpenCase(env, userId, "DOCUMENT_ASSISTED", "LINE_DIRECT_DOCUMENT", false);
  const previous = caseRecord.documents.find(d => d.id === event.message.id && d.storage === "R2");
  if (previous) return; // LINE redelivery must not duplicate an already stored document.
  const documentNumber = caseRecord.documents.length + 1;
  const document = {
    id: event.message.id,
    type: event.message.type,
    fileName: event.message.fileName || `line-document-${documentNumber}`,
    receivedAt: nowIso(),
    intakeRole: state?.intakeRole || missingIntake(caseRecord).find(role => role !== "CONTACT") || "ADDITIONAL",
    storage: "LINE_TEMPORARY",
    r2Key: null
  };

  if (!env.DOCUMENTS) {
    console.error("Document storage unavailable: DOCUMENTS R2 binding missing");
  } else if (!event.message.id) {
    console.error("Document storage unavailable: LINE message ID missing");
  } else {
    try {
      traceStage(env, "LINE_DOWNLOAD");
      await persistProcessingTrace(env);
      const response = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
        headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        const detail = await response.text();
        const reason = /channel/i.test(detail) ? "CHANNEL_MISMATCH"
          : /token|authentication|authorization/i.test(detail) ? "ACCESS_TOKEN_REJECTED"
          : /message|content|not found/i.test(detail) ? "MESSAGE_CONTENT_UNAVAILABLE"
          : "UNCLASSIFIED";
        traceStage(env, "DOWNLOAD_FAILED", { error: reason, downloadStatus: response.status });
        console.error("LINE document download failed", { status: response.status, reason });
      } else {
        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const extension = extensionFromContentType(contentType);
        const key = `${caseRecord.caseId}/files/${encodeURIComponent(event.message.id)}.${extension}`;
        const bytes = await readDocumentBytes(response);
        traceStage(env, "R2_PUT");
        await persistProcessingTrace(env);
        const stored = await env.DOCUMENTS.put(key, bytes, { httpMetadata: { contentType } });
        if (!stored) throw new Error("R2 put returned no object");
        document.storage = "R2";
        document.r2Key = key;
        document.contentType = contentType;
        const check = await env.DOCUMENTS.head(key);
        if (!check || check.size !== stored.size) throw new Error("R2_VERIFICATION_FAILED");
        document.size = check.size;
        document.verifiedAt = nowIso();
        traceStage(env, "R2_VERIFIED");
      }
    } catch (error) {
      traceStage(env, "STORAGE_FAILED", { error: safeError(error) });
      document.storage = "LINE_TEMPORARY"; document.r2Key = null;
      console.error("Document storage error", { reason: safeError(error) });
    }
  }

  traceStage(env, "SAVE_CASE", { stored: document.storage === "R2" });
  caseRecord.documents = caseRecord.documents.filter(d => d.id !== document.id);
  caseRecord.documents.push(document);
  if (document.storage === "R2") await env.DOCUMENTS.put(`${caseRecord.caseId}/documents/${encodeURIComponent(document.id)}.json`, JSON.stringify(document), { httpMetadata: { contentType: "application/json" } });
  if (document.storage === "R2" && document.intakeRole === "POLICY") caseRecord.noPreviousPolicy = false;
  caseRecord.status = "DOCUMENTS_RECEIVING";
  caseRecord.updatedAt = nowIso();
  caseRecord.timeline.push(eventLog(document.storage === "R2" ? "DOCUMENT_STORED" : "DOCUMENT_STORAGE_FAILED", { documentId: document.id, count: caseRecord.documents.length }));
  await saveCase(env, caseRecord);
  await setUserState(env, userId, { mode: "WAITING_DOCUMENTS", caseId: caseRecord.caseId, product: caseRecord.product });

  let customerOcrText = "";
  if (document.storage === "R2" && caseRecord.ocrConsentAt) {
    let result;
    try { result = await extractDocument(env, document); }
    catch { result = { status: "FAILED" }; }
    if (result.status === "EXTRACTED") await setUserState(env, userId, { mode: "OCR_REVIEW", caseId: caseRecord.caseId, product: caseRecord.product, ocrReviewDocumentId: document.id });
    customerOcrText = formatOcrText(caseRecord, document, result);
  }

  traceStage(env, "REPLY", { stored: document.storage === "R2" });
  await persistProcessingTrace(env);
  await reply(
    event.replyToken,
    [
      document.storage === "R2" ? "✅ รับเอกสารและบันทึกอย่างปลอดภัยแล้ว" : "⚠️ ได้รับข้อความเอกสาร แต่ยังบันทึกไฟล์ไม่สำเร็จ กรุณาติดต่อเจ้าหน้าที่",
      "",
      `หมายเลขเคส: ${caseRecord.caseId}`,
      `จำนวนเอกสาร: ${caseRecord.documents.length} รายการ`,
      "",
      caseRecord.ocrConsentAt ? "ระบบอ่านข้อมูลและรอเจ้าหน้าที่ตรวจสอบ" : "หากยินยอมส่งภาพให้ OpenAI อ่านข้อมูล พิมพ์: ยินยอมอ่านเอกสาร",
      "ส่งเอกสารเพิ่มเติมได้ต่อเนื่อง",
      "เมื่อครบแล้ว พิมพ์: ส่งเอกสารครบแล้ว",
      customerOcrText,
      document.storage === "R2" ? intakePrompt(caseRecord) : ""
    ].join("\n").slice(0, 4900),
    env.LINE_CHANNEL_ACCESS_TOKEN
  );
  traceStage(env, document.storage === "R2" ? "STORED_AND_ACKNOWLEDGED" : "FAILED_AND_ACKNOWLEDGED");
  if (document.storage !== "R2") throw new Error("DOCUMENT_STORAGE_RETRY_REQUIRED");
}

async function handleVoucherCode(event, env, userId, rawCode) {
  const code = normalizeVoucher(rawCode);
  const voucher = await loadVoucher(env, code);

  if (!voucher) {
    await reply(event.replyToken, `❌ ไม่พบรหัส Voucher: ${code}\n\nกรุณาตรวจสอบและพิมพ์ใหม่ หรือติดต่อเจ้าหน้าที่โดยพิมพ์ 5`, env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (voucher.status === "USED") {
    await reply(event.replyToken, `❌ Voucher ${code} ถูกใช้แล้ว`, env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
    voucher.status = "EXPIRED";
    await saveVoucher(env, voucher);
    await reply(event.replyToken, `❌ Voucher ${code} หมดอายุแล้ว`, env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (voucher.status === "RESERVED" && voucher.reservedBy !== userId) {
    await reply(event.replyToken, `⚠️ Voucher ${code} กำลังถูกใช้ในรายการอื่น กรุณาติดต่อเจ้าหน้าที่`, env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  const caseRecord = await getOrCreateOpenCase(env, userId, "VOUCHER_REDEMPTION", "LINE_MENU_3", false);
  voucher.status = "RESERVED";
  voucher.reservedBy = userId;
  voucher.caseId = caseRecord.caseId;
  voucher.reservedAt = nowIso();
  voucher.reservationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await saveVoucher(env, voucher);

  caseRecord.voucher = { code, value: voucher.value, campaign: voucher.campaign };
  caseRecord.status = "VOUCHER_RESERVED";
  caseRecord.updatedAt = nowIso();
  caseRecord.timeline.push(eventLog("VOUCHER_RESERVED", { code }));
  await saveCase(env, caseRecord);
  await setUserState(env, userId, { mode: "VOUCHER_RESERVED", caseId: caseRecord.caseId, voucherCode: code });

  await reply(
    event.replyToken,
    [
      "✅ Voucher ใช้งานได้",
      "",
      `รหัส: ${code}`,
      `มูลค่า: ${voucher.value || 200} บาท`,
      `หมายเลขเคส: ${caseRecord.caseId}`,
      "",
      "Voucher ถูกสำรองไว้ 24 ชั่วโมง และจะถูกเปลี่ยนเป็น USED หลังชำระเงินสำเร็จเท่านั้น",
      "",
      "พิมพ์ 1 สำหรับ พ.ร.บ.",
      "พิมพ์ 2 สำหรับประกันภัยภาคสมัครใจ"
    ].join("\n"),
    env.LINE_CHANNEL_ACCESS_TOKEN
  );
}

async function handleAdmin(request, env, url) {
  const key = url.searchParams.get("key") || request.headers.get("x-admin-key");
  if (!env.ADMIN_DASHBOARD_KEY || key !== env.ADMIN_DASHBOARD_KEY) {
    return html(adminLoginPage(url.origin), 401);
  }

  ensureKv(env);
  const cases = await listAllCases(env);
  const vouchers = await listAllVouchers(env);
  return html(adminDashboard(cases, vouchers, key, url.origin));
}

async function createVoucherFromAdmin(request, env, url) {
  const form = await request.formData();
  const key = url.searchParams.get("key") || String(form.get("key") || "");
  if (!env.ADMIN_DASHBOARD_KEY || key !== env.ADMIN_DASHBOARD_KEY) return json({ error: "Unauthorized" }, 401);

  const code = normalizeVoucher(String(form.get("code") || ""));
  if (!code) return json({ error: "Voucher code required" }, 400);

  const voucher = {
    code,
    value: Number(form.get("value") || 200),
    campaign: String(form.get("campaign") || "GENERAL"),
    status: "ISSUED",
    issuedAt: nowIso(),
    expiresAt: String(form.get("expiresAt") || "") || null,
    reservedBy: null,
    caseId: null
  };
  await saveVoucher(env, voucher);
  return Response.redirect(`${url.origin}/admin?key=${encodeURIComponent(key)}`, 303);
}

async function updateCaseFromAdmin(request, env, url) {
  const form = await request.formData();
  const key = url.searchParams.get("key") || String(form.get("key") || "");
  if (!env.ADMIN_DASHBOARD_KEY || key !== env.ADMIN_DASHBOARD_KEY) return json({ error: "Unauthorized" }, 401);

  const caseId = decodeURIComponent(url.pathname.split("/").pop());
  const caseRecord = await loadCase(env, caseId);
  if (!caseRecord) return json({ error: "Case not found" }, 404);

  caseRecord.status = String(form.get("status") || caseRecord.status);
  caseRecord.assignedTo = String(form.get("assignedTo") || "");
  caseRecord.adminNote = String(form.get("adminNote") || "");
  caseRecord.updatedAt = nowIso();
  caseRecord.timeline.push(eventLog("ADMIN_UPDATED", { status: caseRecord.status, assignedTo: caseRecord.assignedTo }));
  await saveCase(env, caseRecord);
  return Response.redirect(`${url.origin}/admin?key=${encodeURIComponent(key)}`, 303);
}

function adminDashboard(cases, vouchers, key, origin) {
  const priorityRank = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  cases.sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const rows = cases.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.caseId)}</strong><br><small>${escapeHtml(item.source)}</small></td>
      <td>${escapeHtml(item.product)}<br><small>${item.documents.length} document(s)</small></td>
      <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status)}</span><br><small>${escapeHtml(item.priority)}</small></td>
      <td>${item.voucher ? `${escapeHtml(item.voucher.code)}<br><small>฿${escapeHtml(String(item.voucher.value || 200))}</small>` : "—"}</td>
      <td>${escapeHtml(item.assignedTo || "Unassigned")}<br><small>${escapeHtml(formatDate(item.updatedAt))}</small></td>
      <td>
        <details>
          <summary>Open</summary>
          <form method="post" action="${origin}/admin/case/${encodeURIComponent(item.caseId)}?key=${encodeURIComponent(key)}">
            <input type="hidden" name="key" value="${escapeHtml(key)}">
            <label>Status<select name="status">${statusOptions(item.status)}</select></label>
            <label>Assigned to<input name="assignedTo" value="${escapeHtml(item.assignedTo || "")}"></label>
            <label>Note<textarea name="adminNote">${escapeHtml(item.adminNote || "")}</textarea></label>
            <button>Update case</button>
          </form>
          ${documentReviewHtml(item, key, origin)}
          <p><strong>LINE User:</strong> ${escapeHtml(maskUserId(item.lineUserId))}</p>
          <p><strong>Created:</strong> ${escapeHtml(formatDate(item.createdAt))}</p>
        </details>
      </td>
    </tr>`).join("");

  const voucherRows = vouchers.slice(0, 20).map((voucher) => `<tr><td>${escapeHtml(voucher.code)}</td><td>${escapeHtml(voucher.status)}</td><td>฿${escapeHtml(String(voucher.value || 200))}</td><td>${escapeHtml(voucher.campaign || "GENERAL")}</td><td>${escapeHtml(voucher.caseId || "—")}</td></tr>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HERO Insure Admin</title><style>
  :root{font-family:Inter,Arial,sans-serif;color:#14294b;background:#f5f7fb}body{margin:0}.top{background:#14294b;color:white;padding:20px 4vw}.wrap{padding:22px 4vw}.grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin-bottom:18px}.card{background:white;padding:16px;border-radius:12px;box-shadow:0 4px 18px #16315c12}.card b{font-size:26px}.panel{background:white;border-radius:14px;padding:18px;margin-top:18px;overflow:auto}table{width:100%;border-collapse:collapse;min-width:900px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e8edf5;vertical-align:top}.badge{padding:5px 8px;border-radius:999px;font-size:12px}.red{background:#ffe3e3;color:#a00000}.amber{background:#fff0c7;color:#7c5200}.green{background:#dcf6e8;color:#08733b}.blue{background:#e3edff;color:#17458f}form{display:grid;gap:8px;margin-top:10px}input,select,textarea,button{font:inherit;padding:9px;border:1px solid #ccd5e2;border-radius:7px}button{background:#ed1b5e;color:white;border:0;font-weight:700;cursor:pointer}.voucher-form{grid-template-columns:2fr 1fr 2fr 2fr auto;align-items:end}@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}.voucher-form{grid-template-columns:1fr}.wrap{padding:15px}.top{padding:16px}}</style></head><body>
  <div class="top"><h1>HERO Insure — Admin Queue</h1><div>LINE cases, documents, voucher reservations and staff actions</div></div>
  <div class="wrap">
    <div class="grid">
      <div class="card"><small>Open cases</small><br><b>${cases.filter(c => !["COMPLETED","CANCELLED"].includes(c.status)).length}</b></div>
      <div class="card"><small>Ready for review</small><br><b>${cases.filter(c => c.status === "READY_FOR_REVIEW").length}</b></div>
      <div class="card"><small>Documents received</small><br><b>${cases.reduce((sum,c) => sum + c.documents.length,0)}</b></div>
      <div class="card"><small>Reserved vouchers</small><br><b>${vouchers.filter(v => v.status === "RESERVED").length}</b></div>
    </div>
    <div class="panel"><h2>Case queue</h2><table><thead><tr><th>Case</th><th>Request</th><th>Status</th><th>Voucher</th><th>Owner / Updated</th><th>Action</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No cases yet. Test by sending 5 in LINE.</td></tr>`}</tbody></table></div>
    <div class="panel"><h2>Create test / campaign voucher</h2><form class="voucher-form" method="post" action="${origin}/admin/voucher?key=${encodeURIComponent(key)}"><input type="hidden" name="key" value="${escapeHtml(key)}"><label>Code<input required name="code" placeholder="EMP-2026-AB1234"></label><label>Value<input name="value" type="number" value="200"></label><label>Campaign<input name="campaign" value="GENERAL"></label><label>Expiry<input name="expiresAt" type="datetime-local"></label><button>Create voucher</button></form>
      <table><thead><tr><th>Code</th><th>Status</th><th>Value</th><th>Campaign</th><th>Case</th></tr></thead><tbody>${voucherRows || `<tr><td colspan="5">No vouchers yet.</td></tr>`}</tbody></table>
    </div>
  </div></body></html>`;
}

function adminLoginPage(origin) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;background:#14294b;display:grid;place-items:center;height:100vh;margin:0}.box{background:white;padding:28px;border-radius:15px;width:min(420px,82vw)}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:10px}button{background:#ed1b5e;color:white;border:0}</style></head><body><form class="box" method="get" action="${origin}/admin"><h2>HERO Insure Admin</h2><p>Enter the Cloudflare ADMIN_DASHBOARD_KEY.</p><input type="password" name="key" required><button>Open dashboard</button></form></body></html>`;
}

function mainMenu() {
  return [
    "HERO Insure 🛡️",
    "",
    "เลือกบริการ:",
    "",
    "1️⃣ ซื้อประกันภัย พ.ร.บ.",
    "2️⃣ ประกันภัยรถยนต์ภาคสมัครใจ",
    "3️⃣ แลกรับ Voucher / HERO Credits",
    "4️⃣ ตรวจสอบสถานะเคส",
    "5️⃣ ส่งเอกสารผ่านเว็บไซต์ HERO Insure",
    "",
    "พิมพ์ตัวเลข 1–5 ได้ทันที"
  ].join("\n");
}

async function customerWebPrompt(env, record, title) {
  const link = await createCustomerLink(env,record);
  return "🛡️ " + title + "\nหมายเลขเคส: " + record.caseId + "\n\nกดลิงก์เพื่ออัปโหลดเอกสารและตรวจสอบข้อมูลทีละขั้นตอน:\n" + link + "\n\n1. หน้าทะเบียนรถ\n2. กรมธรรม์เดิม/ปัจจุบัน\n3. บัตรประชาชน/ใบขับขี่\n4. ชื่อ ที่อยู่จัดส่ง มือถือ และอีเมล\n\nลิงก์ส่วนตัวใช้ได้ 24 ชั่วโมง กรุณาไม่ส่งต่อ เมื่อครบแล้วกดยืนยันส่งคำขอบนหน้าเว็บ";
}

function productDocumentPrompt(caseRecord, productName) { return "🛡️ " + productName + "\n\n" + intakePrompt(caseRecord); }

async function getOrCreateOpenCase(env, userId, product, source, persist = true) {
  ensureKv(env);
  const state = await getUserState(env, userId);
  if (state?.caseId) {
    const existing = await loadCase(env, state.caseId);
    if (existing && !["COMPLETED", "CANCELLED"].includes(existing.status)) {
      if (product !== "DOCUMENT_ASSISTED") existing.product = product;
      existing.updatedAt = nowIso();
      if (persist) await saveCase(env, existing);
      return existing;
    }
  }

  const caseRecord = {
    caseId: generateCaseId(),
    lineUserId: userId,
    product,
    source,
    status: "OPEN",
    priority: "NORMAL",
    documents: [],
    voucher: null,
    assignedTo: "",
    adminNote: "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    timeline: [eventLog("CASE_CREATED", { product, source })]
  };
  if (persist) await saveCase(env, caseRecord);
  return caseRecord;
}

async function loadCase(env, caseId) {
  ensureKv(env);
  const stored = env.DOCUMENTS ? await env.DOCUMENTS.get(`case-index/${caseId}.json`) : null;
  const record = stored ? await stored.json() : await env.CASES.get(`${CASE_PREFIX}${caseId}`, "json");
  return record ? hydrateDocuments(env, record) : null;
}
async function saveCase(env, caseRecord) {
  ensureKv(env);
  const value = JSON.stringify(caseRecord);
  if (env.DOCUMENTS) {
    await env.DOCUMENTS.put(`case-index/${caseRecord.caseId}.json`, value, { httpMetadata: { contentType: "application/json" } });
    try { await env.CASES.put(`${CASE_PREFIX}${caseRecord.caseId}`, value); }
    catch (error) { console.warn("Case KV mirror delayed; private R2 record saved", { reason: safeError(error) }); }
  } else await kvPut(env, `${CASE_PREFIX}${caseRecord.caseId}`, value);
}
async function getUserState(env, userId) {
  ensureKv(env);
  const stored = env.DOCUMENTS ? await env.DOCUMENTS.get(`user-state/${encodeURIComponent(userId)}.json`) : null;
  return stored ? stored.json() : env.CASES.get(`${USER_PREFIX}${userId}`, "json");
}
async function setUserState(env, userId, state) {
  ensureKv(env);
  const value = JSON.stringify({ ...state, updatedAt: nowIso() });
  if (env.DOCUMENTS) {
    await env.DOCUMENTS.put(`user-state/${encodeURIComponent(userId)}.json`, value, { httpMetadata: { contentType: "application/json" } });
    try { await env.CASES.put(`${USER_PREFIX}${userId}`, value); }
    catch (error) { console.warn("User KV mirror delayed; private R2 state saved", { reason: safeError(error) }); }
  } else await kvPut(env, `${USER_PREFIX}${userId}`, value);
}
async function clearTransientState(env, userId) { const current = await getUserState(env, userId); if (current?.caseId) await setUserState(env, userId, { mode: "MENU", caseId: current.caseId }); }
async function loadVoucher(env, code) { ensureKv(env); return env.CASES.get(`${VOUCHER_PREFIX}${code}`, "json"); }
async function saveVoucher(env, voucher) { ensureKv(env); await kvPut(env, `${VOUCHER_PREFIX}${voucher.code}`, JSON.stringify(voucher)); }

async function listAllCases(env) {
  ensureKv(env);
  const ids = new Set();
  let cursor;
  do {
    const page = await env.CASES.list({ prefix: CASE_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    page.keys.forEach(key => ids.add(key.name.slice(CASE_PREFIX.length)));
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  if (env.DOCUMENTS) {
    do {
      const page = await env.DOCUMENTS.list({ prefix: "case-index/", ...(cursor ? { cursor } : {}) });
      page.objects.forEach(object => ids.add(object.key.slice("case-index/".length, -5)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return (await Promise.all([...ids].map(caseId => loadCase(env, caseId)))).filter(Boolean);
}

async function listCasesForUser(env, userId) {
  const all = await listAllCases(env);
  return all.filter((item) => item.lineUserId === userId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function listAllVouchers(env) {
  ensureKv(env);
  const listed = await env.CASES.list({ prefix: VOUCHER_PREFIX, limit: 1000 });
  const values = await Promise.all(listed.keys.map((key) => env.CASES.get(key.name, "json")));
  return values.filter(Boolean).sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
}

function ensureKv(env) { if (!env.CASES) throw new Error("Cloudflare KV binding CASES is missing"); }
function requireLineSecrets(env) { if (!env.LINE_CHANNEL_SECRET) throw new Error("LINE channel secret missing"); }
function normalizeVoucher(value) { return value.trim().toUpperCase().replace(/^VOUCHER\s+/, "").replace(/\s+/g, ""); }
function generateCaseId() { const d = new Date(); const date = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`; return `HI-${date}-${crypto.randomUUID().slice(0,6).toUpperCase()}`; }
function eventLog(type, details = {}) { return { type, at: nowIso(), ...details }; }
function nowIso() { return new Date().toISOString(); }
function formatDate(value) { try { return new Intl.DateTimeFormat("th-TH", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value)); } catch { return value || ""; } }
function maskUserId(value) { if (!value) return ""; return `${value.slice(0,6)}…${value.slice(-4)}`; }
function extensionFromContentType(type) { if (type.includes("png")) return "png"; if (type.includes("jpeg") || type.includes("jpg")) return "jpg"; if (type.includes("pdf")) return "pdf"; return "bin"; }
function thaiStatus(status) { const map = { OPEN:"เปิดเคส", DOCUMENTS_RECEIVING:"กำลังรับเอกสาร", READY_FOR_REVIEW:"รอตรวจสอบ", VOUCHER_RESERVED:"สำรอง Voucher", QUOTATION_PENDING:"รอใบเสนอราคา", PAYMENT_PENDING:"รอชำระเงิน", PAID:"ชำระแล้ว", COMPLETED:"เสร็จสิ้น", CANCELLED:"ยกเลิก" }; return map[status] || status; }
function statusClass(status) { if (["READY_FOR_REVIEW","PAYMENT_FAILED"].includes(status)) return "red"; if (["DOCUMENTS_RECEIVING","QUOTATION_PENDING","PAYMENT_PENDING","VOUCHER_RESERVED"].includes(status)) return "amber"; if (["PAID","COMPLETED"].includes(status)) return "green"; return "blue"; }
function statusOptions(selected) { return ["OPEN","DOCUMENTS_RECEIVING","READY_FOR_REVIEW","VOUCHER_RESERVED","QUOTATION_PENDING","PAYMENT_PENDING","PAID","COMPLETED","CANCELLED"].map(s => `<option ${s===selected?"selected":""}>${s}</option>`).join(""); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

async function verifySignature(body, received, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return toBase64(signed) === received;
}

async function reply(replyToken, text, token) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text, quickReply: { items: [ ["ซื้อ พ.ร.บ.", "1"], ["ประกันรถยนต์", "2"], ["ส่งเอกสาร", "5"], ["ตรวจสอบเคส", "4"], ["เมนูหลัก", "เมนู"] ].map(([label, command]) => ({ type: "action", action: { type: "message", label, text: command } })) } }] })
  });
  if (!response.ok) throw new Error(`LINE reply failed: ${response.status}`);
}

function toBase64(buffer) { let binary = ""; for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte); return btoa(binary); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } }); }
function html(content, status = 200) { return new Response(content, { status, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } }); }

let healthCache;
async function health(env) {
  if (healthCache && healthCache.until > Date.now()) return json({ ...healthCache.data, processing: await readProcessingTrace(env), storageTest: await readStorageTest(env) });
  let line = { tokenAccepted: false, accountMatches: false };
  try {
    const response = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${await getLineToken(env)}` },
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) {
      const info = await response.json();
      line = { tokenAccepted: true, accountMatches: info.basicId === "@557cxljs", basicId: info.basicId };
      const webhook = await fetch("https://api.line.me/v2/bot/channel/webhook/endpoint", { headers: { Authorization: `Bearer ${await getLineToken(env)}` }, signal: AbortSignal.timeout(8000) });
      if (webhook.ok) { const settings = await webhook.json(); line.webhook = { active: settings.active, endpoint: settings.endpoint };
        const test = await fetch("https://api.line.me/v2/bot/channel/webhook/test", { method: "POST", headers: { Authorization: `Bearer ${await getLineToken(env)}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000) });
        if (test.ok) { const result = await test.json(); line.webhook.deliveryTest = { success: result.success, statusCode: result.statusCode, reason: result.reason }; }
        else line.webhook.deliveryTest = { success: false, statusCode: test.status }; }
    }
  } catch (error) { line.reason = /^LINE_TOKEN_[A-Z_]+$/.test(error.message || "") ? error.message : "LINE_CONNECTION_FAILED"; }
  const data = { signatureSecretConfigured: Boolean(env.LINE_CHANNEL_SECRET), bindings: { cases: Boolean(env.CASES), documents: Boolean(env.DOCUMENTS) }, adminConfigured: Boolean(env.ADMIN_DASHBOARD_KEY), line };
  healthCache = { data, until: Date.now() + 60000 };
  return json({ ...data, processing: await readProcessingTrace(env), storageTest: await readStorageTest(env) });
}


const OCR_ENDPOINT = "https://xuygpfswpimhtvtmoljg.supabase.co/functions/v1/hero-insure-read-document";
const OCR_CLIENT_KEY = "sb_publishable_bXiHN2U_vi3J3APNqfv14A_TXJ8tm1w"; // Existing public website client key; never a service-role credential.
const OCR_FIELDS = ["registration_number", "province", "make", "model", "model_year", "color", "chassis_number", "engine_number", "engine_cc", "seats", "owner_name", "legal_owner", "insurer", "policy_number", "policy_start", "policy_expiry", "premium"];
const ocrJobs = new Map();

function safeError(error) {
  const message = String(error);
  if (/429|rate.limit|too many/i.test(message)) return "STORAGE_RATE_LIMIT";
  if (/binding CASES is missing/.test(message)) return "CASES_BINDING_MISSING";
  if (/R2_VERIFICATION_FAILED/.test(message)) return "R2_VERIFICATION_FAILED";
  if (/timeout|abort/i.test(message)) return "UPSTREAM_TIMEOUT";
  return "STORAGE_OR_UPSTREAM_FAILURE";
}

async function kvPut(env, key, value) {
  for (let attempt = 0; ; attempt++) {
    try { return await env.CASES.put(key, value); }
    catch (error) {
      if (attempt >= 2 || !/429|rate.limit|too many/i.test(String(error))) throw error;
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }
}

async function hydrateDocuments(env, record) {
  if (!env.DOCUMENTS) return record;
  const documents = new Map((record.documents || []).map(d => [d.id, d]));
  let cursor;
  do {
    const page = await env.DOCUMENTS.list({ prefix: `${record.caseId}/documents/`, ...(cursor ? { cursor } : {}) });
    for (const entry of page.objects) {
      const object = await env.DOCUMENTS.get(entry.key);
      if (!object) continue;
      const document = await object.json();
      documents.set(document.id, document);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  record.documents = await Promise.all([...documents.values()].map(async document => {
    if (!document.r2Key) return document;
    const ocr = await env.DOCUMENTS.get(`${document.r2Key}.ocr.json`);
    if (ocr) document.ocr = await ocr.json();
    const review = await env.DOCUMENTS.get(`${document.r2Key}.review.json`);
    if (review) document.review = await review.json();
    const customerReview = await env.DOCUMENTS.get(`${document.r2Key}.customer.json`);
    if (customerReview) document.customerReview = await customerReview.json();
    return document;
  }));
  return record;
}

function scheduleOcr(env, caseId) {
  if (!env.TASK_CONTEXT?.waitUntil) return;
  if (ocrJobs.has(caseId)) return;
  const job = runCaseOcr(env, caseId).catch(error => console.error("OCR processing failed", { reason: safeError(error) })).finally(() => ocrJobs.delete(caseId));
  ocrJobs.set(caseId, job);
  env.TASK_CONTEXT.waitUntil(job);
}

async function runCaseOcr(env, caseId) {
  const record = await loadCase(env, caseId);
  if (!record?.ocrConsentAt || !env.DOCUMENTS) return;
  const pending = record.documents.filter(d => d.storage === "R2" && !d.ocr && (!record.ocrDocumentId || d.id === record.ocrDocumentId)).slice(0, 4);
  await Promise.all(pending.map(document => extractDocument(env, document)));
}

async function extractDocument(env, document) {
  if (document.intakeRole === "IDENTITY") {
    const result = { status: "MANUAL_REVIEW", reason: "IDENTITY_STAFF_REVIEW", needsReview: true, updatedAt: nowIso() };
    await env.DOCUMENTS.put(`${document.r2Key}.ocr.json`, JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
    return result;
  }
  const object = await env.DOCUMENTS.get(document.r2Key);
  if (!object) throw new Error("R2_VERIFICATION_FAILED");
  let result;
  const contentType = document.contentType || object.httpMetadata?.contentType || "application/octet-stream";
  if (!/^image\/(jpeg|png|webp)$/.test(contentType) || object.size > 5000000) {
    result = { status: "MANUAL_REVIEW", reason: "IMAGE_FORMAT_OR_SIZE", needsReview: true };
  } else {
    const form = new FormData();
    form.append("image", new Blob([await object.arrayBuffer()], { type: contentType }), "document." + extensionFromContentType(contentType));
    form.append("consent", "yes");
    form.append("type", "vehicle_document");
    try {
      const response = await fetch(OCR_ENDPOINT, {
        method: "POST", headers: { apikey: OCR_CLIENT_KEY, Origin: "https://hero-insure.pages.dev" }, body: form,
        signal: AbortSignal.timeout(20000)
      });
      const data = await response.json();
      if (!response.ok) {
        const reason = /^[A-Z_]{1,80}$/.test(data.error || "") ? data.error : "OCR_PROVIDER_FAILED";
        result = { status: "FAILED", reason, needsReview: true };
      } else if (!data.fields || !["registration_book", "prb_policy", "voluntary_policy", "other"].includes(data.document_type)) {
        result = { status: "FAILED", reason: "INVALID_OCR_RESULT", needsReview: true };
      } else {
        const fields = {};
        for (const name of OCR_FIELDS) if (typeof data.fields[name] === "string") fields[name] = data.fields[name].slice(0, 300);
        result = { status: "EXTRACTED", documentType: data.document_type, fields, warnings: (data.warnings || []).filter(x => typeof x === "string").slice(0, 12), needsReview: true };
      }
    } catch (error) { result = { status: "FAILED", reason: safeError(error), needsReview: true }; }
  }
  result.updatedAt = nowIso();
  await env.DOCUMENTS.put(`${document.r2Key}.ocr.json`, JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
  console.log("Document OCR finished", { status: result.status, reason: result.reason || null });
  return result;
}


const OCR_LABELS = {
  registration_number: "ทะเบียน", province: "จังหวัด", make: "ยี่ห้อ", model: "รุ่น",
  model_year: "ปีรถ", color: "สี", chassis_number: "เลขตัวถัง", engine_number: "เลขเครื่องยนต์",
  engine_cc: "ซีซี", seats: "ที่นั่ง", owner_name: "ชื่อผู้ครอบครอง", legal_owner: "ชื่อเจ้าของ",
  insurer: "บริษัทประกัน", policy_number: "เลขกรมธรรม์", policy_start: "วันเริ่มคุ้มครอง",
  policy_expiry: "วันหมดอายุ", premium: "เบี้ยประกัน"
};

function formatOcrText(record, document, result, customerReview = document.customerReview) {
  const heading = "📄 ผลอ่านเอกสาร • " + record.caseId + "\nไฟล์: " + document.fileName;
  if (result?.reason === "IDENTITY_STAFF_REVIEW") return heading + "\nบันทึกบัตรประชาชน/ใบขับขี่แล้ว รอเจ้าหน้าที่ตรวจสอบ";
  if (result?.status !== "EXTRACTED") return heading + "\n⚠️ ยังอ่านข้อมูลไม่ได้ กรุณาส่งภาพ JPG/PNG/WebP ที่ชัดเจน ขนาดไม่เกิน 5 MB หรือติดต่อเจ้าหน้าที่ พิมพ์ 5";
  const fields = { ...result.fields, ...customerReview?.fields };
  const rows = Object.entries(OCR_LABELS).filter(([key]) => fields[key]).map(([key, label]) => label + ": " + fields[key]);
  return [heading, ...rows, rows.length ? "" : "ไม่พบข้อมูลที่อ่านได้ กรุณาส่งภาพให้ชัดขึ้น",
    ...(result.warnings || []).slice(0, 3).map(warning => "⚠️ " + warning),
    "", "ข้อมูลจาก OCR กรุณาตรวจสอบกับต้นฉบับ",
    "ยืนยัน: พิมพ์ ยืนยันข้อมูล",
    "แก้ไข: พิมพ์ แก้ไข แล้วระบุแต่ละบรรทัด เช่น",
    "ทะเบียน: กข 1234\nจังหวัด: กรุงเทพมหานคร",
    "การยืนยัน/แก้ไขใช้กับเอกสารล่าสุดที่อ่านสำเร็จ"].join("\n");
}

async function handleCustomerOcrReview(event, env, userId, state, originalText) {
  const record = state?.caseId ? await loadCase(env, state.caseId) : null;
  const document = record?.documents.find(d => d.id === state?.ocrReviewDocumentId);
  if (!document || document.ocr?.status !== "EXTRACTED") {
    await reply(event.replyToken, "กรุณากด ยินยอมอ่านล่าสุด เพื่ออ่านเอกสารก่อนยืนยันหรือแก้ไข", env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }
  const editing = /^(แก้ไข|edit)(?:\s|$)/i.test(originalText);
  let customer = { ...document.customerReview, fields: { ...document.customerReview?.fields }, updatedAt: nowIso() };
  if (editing) {
    const input = originalText.replace(/^(แก้ไข|edit)\s*/i, "");
    const lines = input.split(/\r?\n/).filter(line => line.trim());
    const changes = {};
    const invalid = [];
    for (const line of lines) {
      const match = line.match(/^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/);
      const field = match && Object.keys(OCR_LABELS).find(key => key === match[1].trim().toLowerCase() || OCR_LABELS[key] === match[1].trim());
      if (!field || match[2].length > 300) invalid.push(line);
      else changes[field] = match[2];
    }
    if (!lines.length || invalid.length) {
      await reply(event.replyToken, "พิมพ์แก้ไขในรูปแบบนี้:\nแก้ไข\nทะเบียน: กข 1234\nจังหวัด: กรุงเทพมหานคร\n\nช่องข้อมูลที่แก้ไขได้: " + Object.values(OCR_LABELS).join(", ") + "\nยังไม่ได้บันทึกการแก้ไข", env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    customer.fields = { ...customer.fields, ...changes };
    customer.status = "EDITED";
    delete customer.confirmedAt;
  } else {
    if (!Object.values({ ...document.ocr.fields, ...customer.fields }).some(Boolean)) {
      await reply(event.replyToken, "ยังไม่มีข้อมูลให้อยืนยัน กรุณาส่งภาพที่ชัดเจนหรือแก้ไขข้อมูลก่อน", env.LINE_CHANNEL_ACCESS_TOKEN); return;
    }
    customer.status = "CUSTOMER_CONFIRMED";
    customer.confirmedAt = nowIso();
  }
  await env.DOCUMENTS.put(document.r2Key + ".customer.json", JSON.stringify(customer), { httpMetadata: { contentType: "application/json" } });
  await reply(event.replyToken, editing
    ? "✏️ บันทึกการแก้ไขแล้ว\n" + formatOcrText(record, document, document.ocr, customer)
    : "✅ ยืนยันข้อมูลเอกสารแล้ว\nหมายเลขเคส: " + record.caseId + "\nเจ้าหน้าที่ยังต้องตรวจสอบกับต้นฉบับก่อนดำเนินการ\nเมื่อส่งเอกสารครบ กด ส่งเอกสารครบแล้ว", env.LINE_CHANNEL_ACCESS_TOKEN);
}

function adminAuthorized(request, env, url) {
  const key = request.headers.get("x-admin-key") || url.searchParams.get("key");
  return Boolean(env.ADMIN_DASHBOARD_KEY && key === env.ADMIN_DASHBOARD_KEY);
}

async function adminDocument(request, env, url) {
  if (!adminAuthorized(request, env, url)) return json({ error: "Unauthorized" }, 401);
  const parts = url.pathname.split("/");
  const caseId = decodeURIComponent(parts[3] || "");
  const documentId = decodeURIComponent(parts[4] || "");
  const record = await loadCase(env, caseId);
  const document = record?.documents.find(d => d.id === documentId && d.storage === "R2");
  if (!document?.r2Key || !env.DOCUMENTS) return json({ error: "Document not found" }, 404);
  if (request.method === "GET" && parts.length === 5) {
    const object = await env.DOCUMENTS.get(document.r2Key);
    if (!object) return json({ error: "Document not found" }, 404);
    return new Response(object.body, { headers: {
      "Content-Type": document.contentType || "application/octet-stream", "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="document.${extensionFromContentType(document.contentType || "")}"`,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; sandbox"
    } });
  }
  if (request.method !== "POST" || parts[5] !== "review") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) return json({ error: "Origin denied" }, 403);
  const form = await request.formData();
  const status = String(form.get("reviewStatus") || "");
  if (!["VERIFIED", "REJECTED", "PENDING"].includes(status)) return json({ error: "Invalid review status" }, 400);
  const fields = {};
  for (const name of OCR_FIELDS) fields[name] = String(form.get(name) || "").trim().slice(0, 300);
  const review = { status, fields, note: String(form.get("reviewNote") || "").slice(0, 2000), reviewedAt: nowIso() };
  await env.DOCUMENTS.put(`${document.r2Key}.review.json`, JSON.stringify(review), { httpMetadata: { contentType: "application/json" } });
  return Response.redirect(`${url.origin}/admin?key=${encodeURIComponent(url.searchParams.get("key") || request.headers.get("x-admin-key") || "")}`, 303);
}

async function adminOcr(request, env, url) {
  if (!adminAuthorized(request, env, url)) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) return json({ error: "Origin denied" }, 403);
  const record = await loadCase(env, decodeURIComponent(url.pathname.split("/")[3] || ""));
  if (!record) return json({ error: "Case not found" }, 404);
  if (!record.ocrConsentAt) return json({ error: "CUSTOMER_OCR_CONSENT_REQUIRED" }, 409);
  const form = await request.formData();
  const document = record.documents.find(d => d.id === String(form.get("documentId")) && d.storage === "R2");
  if (!document) return json({ error: "Document not found" }, 404);
  const result = await extractDocument(env, document);
  return json({ success: result.status === "EXTRACTED", ocr: result });
}

function documentReviewHtml(record, key, origin) {
  const contact = record.postalContact;
  const contactHtml = contact ? `<section><h4>Postal contact</h4><p>${escapeHtml(contact.name)}<br>${escapeHtml(contact.address)}<br>${escapeHtml(contact.mobile)}<br>${escapeHtml(contact.email)}</p><p>Customer confirmed: ${escapeHtml(contact.confirmedAt || "PENDING")}</p></section>` : "";
  return contactHtml + (record.documents || []).map(document => {
    const base = `${origin}/admin/document/${encodeURIComponent(record.caseId)}/${encodeURIComponent(document.id)}?key=${encodeURIComponent(key)}`;
    const fields = { ...document.ocr?.fields, ...document.customerReview?.fields, ...document.review?.fields };
    return `<details><summary>Document: ${escapeHtml(DOC_ROLES[document.intakeRole] || "Additional")} — ${escapeHtml(document.fileName)} — ${escapeHtml(document.storage)} / OCR ${escapeHtml(document.ocr?.status || (record.ocrConsentAt ? "PENDING" : "AWAITING_CONSENT"))} / ${escapeHtml(document.review?.status || "PENDING")}</summary>
      ${document.storage === "R2" ? `<a href="${escapeHtml(base)}" rel="noreferrer">Download private original</a>` : "Storage failed: ask customer to resend"}
      <p>Customer confirmation: ${escapeHtml(document.customerReview?.status || "PENDING")}</p><p>${escapeHtml(document.ocr?.reason || "")}</p><p>${escapeHtml((document.ocr?.warnings || []).join(" • "))}</p>
      ${document.storage === "R2" ? `<form method="post" action="${origin}/admin/document/${encodeURIComponent(record.caseId)}/${encodeURIComponent(document.id)}/review?key=${encodeURIComponent(key)}">
      ${OCR_FIELDS.map(name => `<label>${escapeHtml(name)}<input name="${name}" value="${escapeHtml(fields[name] || "")}"></label>`).join("")}
      <label>Review<select name="reviewStatus">${["PENDING", "VERIFIED", "REJECTED"].map(s => `<option ${s === (document.review?.status || "PENDING") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Review note<textarea name="reviewNote">${escapeHtml(document.review?.note || "")}</textarea></label><button>Save document verification</button></form>` : ""}
      ${record.ocrConsentAt && document.storage === "R2" ? `<form method="post" action="${origin}/admin/ocr/${encodeURIComponent(record.caseId)}?key=${encodeURIComponent(key)}"><input type="hidden" name="documentId" value="${escapeHtml(document.id)}"><button>Read / retry OCR</button></form>` : ""}
      </details>`;
  }).join("");
}

const LINE_CHANNEL_ID = "2008306643";
let lineTokenCache;
let lineTokenPending;

async function getLineToken(env) {
  const secret = env.LINE_CHANNEL_SECRET;
  if (!secret) throw new Error("LINE_TOKEN_SECRET_MISSING");
  if (lineTokenCache?.secret === secret && lineTokenCache.expiresAt > Date.now()) return lineTokenCache.token;
  if (lineTokenPending?.secret === secret) return lineTokenPending.promise;
  const promise = (async () => {
    const response = await fetch("https://api.line.me/oauth2/v3/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: LINE_CHANNEL_ID, client_secret: secret }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? "LINE_TOKEN_SECRET_REJECTED" : "LINE_TOKEN_SERVICE_UNAVAILABLE");
    const data = await response.json();
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in) || data.expires_in < 60) throw new Error("LINE_TOKEN_INVALID_RESPONSE");
    lineTokenCache = { secret, token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  })();
  lineTokenPending = { secret, promise };
  try { return await promise; } finally { if (lineTokenPending?.promise === promise) lineTokenPending = null; }
}

function traceStage(env, stage, details = {}) {
  if (env.PROCESSING_TRACE) Object.assign(env.PROCESSING_TRACE, { stage, updatedAt: nowIso() }, details);
}
async function persistProcessingTrace(env) {
  if (!env.DOCUMENTS || !env.PROCESSING_TRACE) return;
  try { await env.DOCUMENTS.put("_health/last-webhook.json", JSON.stringify(env.PROCESSING_TRACE), { httpMetadata: { contentType: "application/json" } }); }
  catch { console.error("Processing trace persistence unavailable"); }
}
async function readProcessingTrace(env) {
  try { const object = await env.DOCUMENTS?.get("_health/last-webhook.json"); return object ? await object.json() : null; }
  catch { return { stage: "TRACE_UNAVAILABLE" }; }
}
async function readDocumentBytes(response) {
  const limit = 20 * 1024 * 1024;
  if (Number(response.headers.get("content-length") || 0) > limit) throw new Error("DOCUMENT_TOO_LARGE");
  if (!response.body) throw new Error("DOCUMENT_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error("DOCUMENT_TOO_LARGE"); }
    chunks.push(value);
  }
  if (!length) throw new Error("DOCUMENT_BODY_MISSING");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function runLineJob(bindings, key) {
  const object = await bindings.DOCUMENTS.get(key);
  if (!object) return;
  const job = await object.json();
  if (job.status === "COMPLETED" || job.attempts >= 4 || (job.notBefore && Date.parse(job.notBefore) > Date.now())) return;
  job.attempts = (job.attempts || 0) + 1;
  const env = { ...bindings, PROCESSING_TRACE: { receivedAt: job.createdAt, updatedAt: nowIso(), stage: "TOKEN", attempt: job.attempts } };
  try {
    await persistProcessingTrace(env);
    env.LINE_CHANNEL_ACCESS_TOKEN = await getLineToken(env);
    await processEvent(job.event, env);
    job.status = "COMPLETED";
    delete job.event;
    job.completedAt = nowIso();
  } catch (error) {
    job.status = "PENDING";
    job.notBefore = new Date(Date.now() + 60000).toISOString();
    env.PROCESSING_TRACE.failedStage = env.PROCESSING_TRACE.stage;
    env.PROCESSING_TRACE.stage = "FAILED";
    env.PROCESSING_TRACE.error = safeError(error);
    const status = String(error).match(/LINE reply failed: (\d{3})/);
    if (status) env.PROCESSING_TRACE.replyStatus = Number(status[1]);
    console.error("LINE durable job failed", { stage: env.PROCESSING_TRACE.failedStage, reason: env.PROCESSING_TRACE.error });
  }
  await bindings.DOCUMENTS.put(key, JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  await persistProcessingTrace(env);
}
async function drainLineJobs(env) {
  if (!env.DOCUMENTS) return;
  await verifyR2Storage(env);
  const page = await env.DOCUMENTS.list({ prefix: "_queue/", limit: 100 });
  for (const entry of page.objects) {
    const object = await env.DOCUMENTS.get(entry.key);
    if (!object) continue;
    const job = await object.json();
    if (job.status !== "COMPLETED" && (job.attempts || 0) < 4 && (!job.notBefore || Date.parse(job.notBefore) <= Date.now())) {
      await runLineJob(env, entry.key);
      break;
    }
  }
}

async function verifyR2Storage(env) {
  const key = "_health/probe-" + crypto.randomUUID();
  let result;
  try {
    const value = new TextEncoder().encode("hero-insure-storage-check");
    await env.DOCUMENTS.put(key, value.buffer);
    const object = await env.DOCUMENTS.get(key);
    const bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
    if (!bytes || bytes.length !== value.length || !bytes.every((byte, i) => byte === value[i])) throw new Error("R2_VERIFICATION_FAILED");
    result = { verified: true, checkedAt: nowIso() };
  } catch (error) { result = { verified: false, checkedAt: nowIso(), reason: safeError(error) }; }
  finally { try { await env.DOCUMENTS.delete(key); } catch {} }
  await env.DOCUMENTS.put("_health/storage-check.json", JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
}
async function readStorageTest(env) {
  try { let object = await env.DOCUMENTS?.get("_health/storage-check.json"); if (!object && env.DOCUMENTS) { await verifyR2Storage(env); object = await env.DOCUMENTS.get("_health/storage-check.json"); } return object ? await object.json() : null; }
  catch { return null; }
}

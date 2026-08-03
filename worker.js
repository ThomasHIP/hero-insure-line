const CASE_PREFIX = "case:";
const USER_PREFIX = "user:";
const VOUCHER_PREFIX = "voucher:";
const ADMIN_SESSION_TTL = 60 * 60 * 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        success: true,
        service: "HERO Insure LINE Case System",
        version: "case-admin-v1",
        status: "running",
        webhook: `${url.origin}/webhook`,
        admin: `${url.origin}/admin`
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

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

    await Promise.allSettled(events.map((event) => processEvent(event, env)));
    return json({ success: true, processed: events.length });
  } catch (error) {
    console.error("Webhook error", error);
    return json({ success: false, error: String(error) }, 500);
  }
}

async function processEvent(event, env) {
  const userId = event?.source?.userId;
  if (!userId || !event?.replyToken) return;

  if (event.type === "follow") {
    await reply(event.replyToken, mainMenu(), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (event.type !== "message") return;

  const state = await getUserState(env, userId);

  if (event.message?.type === "image" || event.message?.type === "file") {
    await handleDocumentMessage(event, env, userId, state);
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

  if (text === "1") {
    const caseRecord = await getOrCreateOpenCase(env, userId, "PRB", "LINE_MENU_1");
    await setUserState(env, userId, {
      mode: "WAITING_DOCUMENTS",
      caseId: caseRecord.caseId,
      product: "PRB"
    });
    await reply(event.replyToken, productDocumentPrompt(caseRecord, "ประกันภัย พ.ร.บ."), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (text === "2") {
    const caseRecord = await getOrCreateOpenCase(env, userId, "VOLUNTARY", "LINE_MENU_2");
    await setUserState(env, userId, {
      mode: "WAITING_DOCUMENTS",
      caseId: caseRecord.caseId,
      product: "VOLUNTARY"
    });
    await reply(event.replyToken, productDocumentPrompt(caseRecord, "ประกันภัยรถยนต์ภาคสมัครใจ"), env.LINE_CHANNEL_ACCESS_TOKEN);
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
    await reply(
      event.replyToken,
      [
        "📄 ส่งเอกสารผ่าน LINE / ติดต่อเจ้าหน้าที่",
        "",
        `หมายเลขเคส: ${caseRecord.caseId}`,
        "",
        "ส่งรูปเอกสารในแชตนี้ได้ทันที:",
        "• เล่มทะเบียนรถ",
        "• กรมธรรม์ พ.ร.บ. เดิม",
        "• กรมธรรม์ภาคสมัครใจเดิม",
        "• เอกสารอื่นที่เกี่ยวข้อง",
        "",
        "เมื่อส่งครบแล้ว พิมพ์:",
        "ส่งเอกสารครบแล้ว",
        "",
        "ระบบจะนำเอกสารทั้งหมดเข้าคิวให้เจ้าหน้าที่ตรวจสอบ"
      ].join("\n"),
      env.LINE_CHANNEL_ACCESS_TOKEN
    );
    return;
  }

  if (["ส่งเอกสารครบแล้ว", "documents complete", "done"].includes(text)) {
    if (!state?.caseId) {
      await reply(event.replyToken, "ยังไม่พบเคสเอกสาร กรุณาพิมพ์ 5 เพื่อเริ่มส่งเอกสาร", env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    const caseRecord = await loadCase(env, state.caseId);
    if (!caseRecord) {
      await reply(event.replyToken, "ไม่พบข้อมูลเคส กรุณาพิมพ์ 5 เพื่อสร้างเคสใหม่", env.LINE_CHANNEL_ACCESS_TOKEN);
      return;
    }
    caseRecord.status = "READY_FOR_REVIEW";
    caseRecord.priority = "HIGH";
    caseRecord.updatedAt = nowIso();
    caseRecord.timeline.push(eventLog("CUSTOMER_DOCUMENTS_COMPLETE"));
    await saveCase(env, caseRecord);
    await setUserState(env, userId, { mode: "CASE_SUBMITTED", caseId: caseRecord.caseId });
    await reply(
      event.replyToken,
      `✅ รับเอกสารครบแล้ว\n\nหมายเลขเคส: ${caseRecord.caseId}\nเอกสาร: ${caseRecord.documents.length} รายการ\n\nเจ้าหน้าที่ HERO Insure จะตรวจสอบและติดต่อกลับ`,
      env.LINE_CHANNEL_ACCESS_TOKEN
    );
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
  if (!caseRecord) caseRecord = await getOrCreateOpenCase(env, userId, "DOCUMENT_ASSISTED", "LINE_DIRECT_DOCUMENT");

  const documentNumber = caseRecord.documents.length + 1;
  const document = {
    id: event.message.id,
    type: event.message.type,
    fileName: event.message.fileName || `line-document-${documentNumber}`,
    receivedAt: nowIso(),
    storage: "LINE_TEMPORARY",
    r2Key: null
  };

  if (env.DOCUMENTS && event.message.id) {
    try {
      const response = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
        headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
      });
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const extension = extensionFromContentType(contentType);
        const key = `${caseRecord.caseId}/${Date.now()}-${documentNumber}.${extension}`;
        await env.DOCUMENTS.put(key, response.body, { httpMetadata: { contentType } });
        document.storage = "R2";
        document.r2Key = key;
        document.contentType = contentType;
      }
    } catch (error) {
      console.error("Document storage error", error);
    }
  }

  caseRecord.documents.push(document);
  caseRecord.status = "DOCUMENTS_RECEIVING";
  caseRecord.updatedAt = nowIso();
  caseRecord.timeline.push(eventLog("DOCUMENT_RECEIVED", { documentId: document.id, count: caseRecord.documents.length }));
  await saveCase(env, caseRecord);
  await setUserState(env, userId, { mode: "WAITING_DOCUMENTS", caseId: caseRecord.caseId, product: caseRecord.product });

  await reply(
    event.replyToken,
    [
      "✅ รับเอกสารแล้ว",
      "",
      `หมายเลขเคส: ${caseRecord.caseId}`,
      `จำนวนเอกสาร: ${caseRecord.documents.length} รายการ`,
      "",
      "ส่งเอกสารเพิ่มเติมได้ต่อเนื่อง",
      "เมื่อครบแล้ว พิมพ์: ส่งเอกสารครบแล้ว"
    ].join("\n"),
    env.LINE_CHANNEL_ACCESS_TOKEN
  );
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

  const caseRecord = await getOrCreateOpenCase(env, userId, "VOUCHER_REDEMPTION", "LINE_MENU_3");
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
    "5️⃣ ส่งเอกสารผ่าน LINE / ติดต่อเจ้าหน้าที่",
    "",
    "พิมพ์ตัวเลข 1–5 ได้ทันที"
  ].join("\n");
}

function productDocumentPrompt(caseRecord, productName) {
  return [
    `🛡️ ${productName}`,
    "",
    `หมายเลขเคส: ${caseRecord.caseId}`,
    "",
    "ส่งเอกสารผ่าน LINE ได้ทันที หรือใช้หน้าอัปโหลด:",
    `https://hero-insure.pages.dev/upload/?case=${encodeURIComponent(caseRecord.caseId)}`,
    "",
    "เอกสารที่ควรเตรียม:",
    "• เล่มทะเบียนรถ",
    "• กรมธรรม์เดิม ถ้ามี",
    "• บัตรประชาชน เมื่อเจ้าหน้าที่ร้องขอ",
    "",
    "เมื่อส่งทาง LINE ครบแล้ว พิมพ์: ส่งเอกสารครบแล้ว"
  ].join("\n");
}

async function getOrCreateOpenCase(env, userId, product, source) {
  ensureKv(env);
  const state = await getUserState(env, userId);
  if (state?.caseId) {
    const existing = await loadCase(env, state.caseId);
    if (existing && !["COMPLETED", "CANCELLED"].includes(existing.status)) {
      if (product !== "DOCUMENT_ASSISTED") existing.product = product;
      existing.updatedAt = nowIso();
      await saveCase(env, existing);
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
  await saveCase(env, caseRecord);
  await setUserState(env, userId, { mode: "CASE_OPEN", caseId: caseRecord.caseId, product });
  return caseRecord;
}

async function loadCase(env, caseId) { ensureKv(env); return env.CASES.get(`${CASE_PREFIX}${caseId}`, "json"); }
async function saveCase(env, caseRecord) { ensureKv(env); await env.CASES.put(`${CASE_PREFIX}${caseRecord.caseId}`, JSON.stringify(caseRecord)); }
async function getUserState(env, userId) { ensureKv(env); return env.CASES.get(`${USER_PREFIX}${userId}`, "json"); }
async function setUserState(env, userId, state) { ensureKv(env); await env.CASES.put(`${USER_PREFIX}${userId}`, JSON.stringify({ ...state, updatedAt: nowIso() })); }
async function clearTransientState(env, userId) { const current = await getUserState(env, userId); if (current?.caseId) await setUserState(env, userId, { mode: "MENU", caseId: current.caseId }); }
async function loadVoucher(env, code) { ensureKv(env); return env.CASES.get(`${VOUCHER_PREFIX}${code}`, "json"); }
async function saveVoucher(env, voucher) { ensureKv(env); await env.CASES.put(`${VOUCHER_PREFIX}${voucher.code}`, JSON.stringify(voucher)); }

async function listAllCases(env) {
  ensureKv(env);
  const listed = await env.CASES.list({ prefix: CASE_PREFIX, limit: 1000 });
  const values = await Promise.all(listed.keys.map((key) => env.CASES.get(key.name, "json")));
  return values.filter(Boolean);
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
function requireLineSecrets(env) { if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE secrets missing"); }
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
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] })
  });
  if (!response.ok) throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
}

function toBase64(buffer) { let binary = ""; for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte); return btoa(binary); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } }); }
function html(content, status = 200) { return new Response(content, { status, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } }); }

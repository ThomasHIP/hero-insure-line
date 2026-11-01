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

  if (["ยินยอมอ่านเอกสาร", "consent ocr", "read only latest doc.", "read only latest doc", "read latest document", "อ่านเฉพาะเอกสารล่าสุด"].includes(text)) {
    const record = state?.caseId ? await loadCase(env, state.caseId) : null;
    if (!record) { await reply(event.replyToken, "กรุณาส่งเอกสารก่อน", env.LINE_CHANNEL_ACCESS_TOKEN); return; }
    const latestOnly = !["ยินยอมอ่านเอกสาร", "consent ocr"].includes(text);
    const storedDocs = record.documents.filter(d => d.storage === "R2");
    if (!storedDocs.length) { await reply(event.replyToken, "ยังไม่มีเอกสารที่บันทึกสำเร็จ กรุณาส่งภาพเอกสารก่อน", env.LINE_CHANNEL_ACCESS_TOKEN); return; }
    record.ocrDocumentId = latestOnly ? storedDocs[storedDocs.length - 1].id : null;
    record.ocrConsentAt = nowIso();
    record.timeline.push(eventLog("OCR_CONSENT_GRANTED"));
    await saveCase(env, record);
    await reply(event.replyToken, "รับความยินยอมแล้ว ระบบจะส่งภาพที่เลือกให้ OpenAI อ่านข้อมูลเพื่อให้เจ้าหน้าที่ตรวจสอบกับต้นฉบับ", env.LINE_CHANNEL_ACCESS_TOKEN);
    scheduleOcr(env, record.caseId);
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
    if (!caseRecord.documents.length || caseRecord.documents.some(d => d.storage !== "R2")) {
      await reply(event.replyToken, "ยังมีไฟล์ที่บันทึกไม่สำเร็จ กรุณาส่งไฟล์นั้นใหม่ก่อนส่งตรวจสอบ", env.LINE_CHANNEL_ACCESS_TOKEN);
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
  caseRecord.status = "DOCUMENTS_RECEIVING";
  caseRecord.updatedAt = nowIso();
  caseRecord.timeline.push(eventLog(document.storage === "R2" ? "DOCUMENT_STORED" : "DOCUMENT_STORAGE_FAILED", { documentId: document.id, count: caseRecord.documents.length }));
  await saveCase(env, caseRecord);
  await setUserState(env, userId, { mode: "WAITING_DOCUMENTS", caseId: caseRecord.caseId, product: caseRecord.product });

  if (document.storage === "R2" && caseRecord.ocrConsentAt) scheduleOcr(env, caseRecord.caseId);

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
      "เมื่อครบแล้ว พิมพ์: ส่งเอกสารครบแล้ว"
    ].join("\n"),
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
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text, quickReply: { items: [ ["ยินยอมอ่านล่าสุด", "อ่านเฉพาะเอกสารล่าสุด"], ["ยินยอมอ่านทุกภาพ", "ยินยอมอ่านเอกสาร"], ["ส่งเอกสารครบแล้ว", "ส่งเอกสารครบแล้ว"], ["เมนูหลัก", "เมนู"] ].map(([label, command]) => ({ type: "action", action: { type: "message", label, text: command } })) } }] })
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
  return (record.documents || []).map(document => {
    const base = `${origin}/admin/document/${encodeURIComponent(record.caseId)}/${encodeURIComponent(document.id)}?key=${encodeURIComponent(key)}`;
    const fields = document.review?.fields || document.ocr?.fields || {};
    return `<details><summary>Document: ${escapeHtml(document.fileName)} — ${escapeHtml(document.storage)} / OCR ${escapeHtml(document.ocr?.status || (record.ocrConsentAt ? "PENDING" : "AWAITING_CONSENT"))} / ${escapeHtml(document.review?.status || "PENDING")}</summary>
      ${document.storage === "R2" ? `<a href="${escapeHtml(base)}" rel="noreferrer">Download private original</a>` : "Storage failed: ask customer to resend"}
      <p>${escapeHtml(document.ocr?.reason || "")}</p><p>${escapeHtml((document.ocr?.warnings || []).join(" • "))}</p>
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

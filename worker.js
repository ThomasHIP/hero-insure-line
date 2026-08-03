export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        success: true,
        service: "HERO Insure LINE Webhook",
        status: "running",
        webhook: `${url.origin}/webhook`
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleLineWebhook(request, env);
    }

    return jsonResponse({ success: false, error: "Not found" }, 404);
  }
};

async function handleLineWebhook(request, env) {
  try {
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) {
      return jsonResponse(
        { success: false, error: "LINE secrets are not configured" },
        500
      );
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");

    if (!signature) {
      return jsonResponse({ success: false, error: "Missing LINE signature" }, 401);
    }

    const valid = await verifyLineSignature(
      rawBody,
      signature,
      env.LINE_CHANNEL_SECRET
    );

    if (!valid) {
      return jsonResponse({ success: false, error: "Invalid LINE signature" }, 401);
    }

    const payload = JSON.parse(rawBody);
    const events = Array.isArray(payload.events) ? payload.events : [];

    if (events.length === 0) {
      return jsonResponse({ success: true, message: "Webhook verified" });
    }

    const results = await Promise.allSettled(
      events.map((event) => processLineEvent(event, env))
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("LINE event failed:", result.reason);
      }
    }

    return jsonResponse({ success: true, processed: events.length });
  } catch (error) {
    console.error("Webhook error:", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      },
      500
    );
  }
}

async function processLineEvent(event, env) {
  console.log("LINE event:", JSON.stringify(event));

  if (!event?.replyToken) return;

  if (event.type === "follow") {
    await replyText(event.replyToken, mainMenu(), env.LINE_CHANNEL_ACCESS_TOKEN);
    return;
  }

  if (event.type !== "message") return;

  if (event.message?.type !== "text") {
    await replyText(
      event.replyToken,
      "ขณะนี้ระบบรองรับข้อความตัวอักษรก่อนค่ะ\nกรุณาพิมพ์ เมนู เพื่อเริ่มต้น",
      env.LINE_CHANNEL_ACCESS_TOKEN
    );
    return;
  }

  const originalText = String(event.message.text || "").trim();
  const text = normalizeText(originalText);
  const reply = getReply(text, originalText);

  await replyText(event.replyToken, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
}

function getReply(text, originalText) {
  switch (text) {
    case "0":
    case "เมนู":
    case "menu":
    case "เริ่มต้น":
    case "start":
      return mainMenu();

    case "1":
      return [
        "🚗 ซื้อประกันภัย พ.ร.บ.",
        "",
        "กรุณาเลือกประเภทรถ",
        "11 — รถเก๋ง / รถยนต์นั่งส่วนบุคคล",
        "12 — รถกระบะ",
        "13 — รถตู้",
        "14 — รถจักรยานยนต์",
        "",
        "พิมพ์ 11, 12, 13 หรือ 14",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "2":
      return [
        "🛡️ ประกันภัยรถยนต์ภาคสมัครใจ",
        "",
        "กรุณาเลือกบริการ",
        "21 — ขอใบเสนอราคา",
        "22 — ต่ออายุกรมธรรม์",
        "23 — เปรียบเทียบแผนประกัน",
        "",
        "พิมพ์ 21, 22 หรือ 23",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "3":
      return [
        "🎁 แลกรับ Voucher / HERO Credits",
        "",
        "กรุณาพิมพ์รหัสในรูปแบบ",
        "VOUCHER ตามด้วยรหัส",
        "",
        "ตัวอย่าง",
        "VOUCHER EMP-2026-AB1234",
        "",
        "1 Voucher ใช้กับกรมธรรม์ได้ 1 รายการ",
        "ใช้เป็นส่วนลดสำหรับ พ.ร.บ. หรือประกันภัยภาคสมัครใจได้",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "4":
      return [
        "👤 บริการสมาชิก HERO Insure",
        "",
        "41 — สมัครสมาชิก",
        "42 — ตรวจสอบ HERO Credits",
        "43 — ตรวจสอบสถานะคำขอ",
        "44 — ดูกรมธรรม์ของฉัน",
        "",
        "พิมพ์ 41, 42, 43 หรือ 44",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "5":
      return [
        "💬 ติดต่อเจ้าหน้าที่ HERO Insure",
        "",
        "กรุณาส่งข้อมูลดังต่อไปนี้",
        "• ชื่อ–นามสกุล",
        "• เบอร์โทรศัพท์",
        "• เรื่องที่ต้องการติดต่อ",
        "",
        "เจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุด",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "11":
      return vehicleDocumentRequest("รถเก๋ง / รถยนต์นั่งส่วนบุคคล");
    case "12":
      return vehicleDocumentRequest("รถกระบะ");
    case "13":
      return vehicleDocumentRequest("รถตู้");
    case "14":
      return vehicleDocumentRequest("รถจักรยานยนต์");

    case "21":
      return [
        "📋 ขอใบเสนอราคาประกันภัยภาคสมัครใจ",
        "",
        "กรุณาส่ง",
        "1. รูปเล่มทะเบียนรถ",
        "2. รูปกรมธรรม์เดิม ถ้ามี",
        "3. วันที่ต้องการเริ่มความคุ้มครอง",
        "4. เบอร์โทรศัพท์",
        "",
        "เจ้าหน้าที่จะตรวจสอบและจัดทำข้อเสนอให้"
      ].join("\n");

    case "22":
      return [
        "🔄 ต่ออายุกรมธรรม์",
        "",
        "กรุณาส่งรูปกรมธรรม์เดิม",
        "เพื่อให้ระบบตรวจสอบข้อมูลและวันหมดอายุ",
        "หลังจากนั้นเจ้าหน้าที่จะจัดทำข้อเสนอให้"
      ].join("\n");

    case "23":
      return [
        "📊 เปรียบเทียบแผนประกัน",
        "",
        "กรุณาส่งข้อมูลรถและกรมธรรม์เดิม",
        "ระบบจะช่วยเปรียบเทียบความคุ้มครองและราคา",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "41":
      return [
        "📝 สมัครสมาชิก HERO Insure",
        "",
        "เปิดหน้าสมัครสมาชิกได้ที่",
        "https://hero-insure.pages.dev/",
        "",
        "หลังสมัครสำเร็จ ระบบจะเชื่อมต่อกับ LINE ของคุณ"
      ].join("\n");

    case "42":
      return [
        "⭐ ตรวจสอบ HERO Credits",
        "",
        "ระบบตรวจสอบยอดเครดิตกำลังเชื่อมต่อกับฐานข้อมูลสมาชิก",
        "พิมพ์ 0 เพื่อกลับเมนูหลัก"
      ].join("\n");

    case "43":
      return [
        "🔎 ตรวจสอบสถานะคำขอ",
        "",
        "กรุณาพิมพ์หมายเลขคำขอหรือเบอร์โทรศัพท์",
        "",
        "ตัวอย่าง",
        "HC-202607-760570"
      ].join("\n");

    case "44":
      return [
        "📄 กรมธรรม์ของฉัน",
        "",
        "กรุณาพิมพ์เบอร์โทรศัพท์ที่ใช้สมัครสมาชิก",
        "ระบบฐานข้อมูลกรมธรรม์จะเชื่อมต่อในขั้นตอนถัดไป"
      ].join("\n");

    default:
      if (text.startsWith("voucher ")) {
        const voucherCode = originalText.substring(8).trim();
        return [
          "🎁 รับข้อมูล Voucher แล้ว",
          "",
          `รหัส: ${voucherCode}`,
          "",
          "ระบบจะตรวจสอบความถูกต้อง สถานะการใช้งาน และมูลค่าสิทธิ์",
          "การตรวจสอบอัตโนมัติจะเชื่อมต่อกับฐานข้อมูลในขั้นตอนถัดไป"
        ].join("\n");
      }

      return [
        "กรุณาพิมพ์หมายเลข 1–5 เพื่อเลือกบริการ",
        "",
        mainMenu()
      ].join("\n");
  }
}

function mainMenu() {
  return [
    "HERO Insure 🛡️",
    "",
    "ยินดีต้อนรับสู่ HERO Insure",
    "กรุณาพิมพ์หมายเลขเพื่อเลือกบริการ",
    "",
    "1️⃣ ซื้อประกันภัย พ.ร.บ.",
    "2️⃣ ประกันภัยรถยนต์ภาคสมัครใจ",
    "3️⃣ แลกรับ Voucher / HERO Credits",
    "4️⃣ บริการสมาชิก",
    "5️⃣ ติดต่อเจ้าหน้าที่",
    "",
    "กรุณาพิมพ์ 1, 2, 3, 4 หรือ 5"
  ].join("\n");
}

function vehicleDocumentRequest(vehicleType) {
  return [
    `🚘 ประเภทรถ: ${vehicleType}`,
    "",
    "กรุณาส่งรูปเอกสาร",
    "1. เล่มทะเบียนรถ",
    "2. กรมธรรม์เดิม ถ้ามี",
    "3. วันที่ต้องการเริ่มความคุ้มครอง",
    "4. เบอร์โทรศัพท์",
    "",
    "หลังได้รับเอกสาร ระบบจะตรวจสอบข้อมูลให้",
    "พิมพ์ 0 เพื่อกลับเมนูหลัก"
  ].join("\n");
}

function normalizeText(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function verifyLineSignature(rawBody, receivedSignature, channelSecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody)
  );

  return arrayBufferToBase64(signatureBuffer) === receivedSignature;
}

async function replyText(replyToken, text, accessToken) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE Reply API failed: ${response.status} ${errorText}`);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

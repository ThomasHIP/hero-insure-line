export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        success: true,
        service: "HERO Insure LINE Bot",
        version: "thai-menu-v2",
        status: "running",
        webhook: `${url.origin}/webhook`
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return json({ success: false, error: "Not found" }, 404);
  }
};

async function handleWebhook(request, env) {
  try {
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) {
      return json({ success: false, error: "LINE secrets missing" }, 500);
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");

    if (!signature) {
      return json({ success: false, error: "Missing signature" }, 401);
    }

    const valid = await verifySignature(
      rawBody,
      signature,
      env.LINE_CHANNEL_SECRET
    );

    if (!valid) {
      return json({ success: false, error: "Invalid signature" }, 401);
    }

    const payload = JSON.parse(rawBody);
    const events = Array.isArray(payload.events) ? payload.events : [];

    await Promise.allSettled(
      events.map((event) => processEvent(event, env.LINE_CHANNEL_ACCESS_TOKEN))
    );

    return json({ success: true, processed: events.length });
  } catch (error) {
    console.error(error);
    return json({ success: false, error: String(error) }, 500);
  }
}

async function processEvent(event, token) {
  if (!event?.replyToken) return;

  if (event.type === "follow") {
    await reply(event.replyToken, mainMenu(), token);
    return;
  }

  if (event.type !== "message" || event.message?.type !== "text") {
    await reply(
      event.replyToken,
      "กรุณาพิมพ์ เมนู หรือหมายเลข 1–5 เพื่อเลือกบริการ",
      token
    );
    return;
  }

  const text = String(event.message.text || "").trim().toLowerCase();
  await reply(event.replyToken, menuReply(text), token);
}

function menuReply(text) {
  if (["menu", "เมนู", "0", "start", "เริ่มต้น"].includes(text)) {
    return mainMenu();
  }

  const replies = {
    "1": [
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
    ].join("\n"),

    "2": [
      "🛡️ ประกันภัยรถยนต์ภาคสมัครใจ",
      "",
      "21 — ขอใบเสนอราคา",
      "22 — ต่ออายุกรมธรรม์",
      "23 — เปรียบเทียบแผนประกัน",
      "",
      "พิมพ์ 21, 22 หรือ 23",
      "พิมพ์ 0 เพื่อกลับเมนูหลัก"
    ].join("\n"),

    "3": [
      "🎁 แลกรับ Voucher / HERO Credits",
      "",
      "กรุณาพิมพ์รหัสในรูปแบบ",
      "VOUCHER ตามด้วยรหัส",
      "",
      "ตัวอย่าง: VOUCHER EMP-2026-AB1234",
      "พิมพ์ 0 เพื่อกลับเมนูหลัก"
    ].join("\n"),

    "4": [
      "👤 บริการสมาชิก HERO Insure",
      "",
      "41 — สมัครสมาชิก",
      "42 — ตรวจสอบ HERO Credits",
      "43 — ตรวจสอบสถานะคำขอ",
      "44 — ดูกรมธรรม์ของฉัน",
      "",
      "พิมพ์ 41, 42, 43 หรือ 44",
      "พิมพ์ 0 เพื่อกลับเมนูหลัก"
    ].join("\n"),

    "5": [
      "💬 ติดต่อเจ้าหน้าที่ HERO Insure",
      "",
      "กรุณาส่ง",
      "• ชื่อ–นามสกุล",
      "• เบอร์โทรศัพท์",
      "• เรื่องที่ต้องการติดต่อ",
      "",
      "เจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุด",
      "พิมพ์ 0 เพื่อกลับเมนูหลัก"
    ].join("\n"),

    "11": documentRequest("รถเก๋ง / รถยนต์นั่งส่วนบุคคล"),
    "12": documentRequest("รถกระบะ"),
    "13": documentRequest("รถตู้"),
    "14": documentRequest("รถจักรยานยนต์"),

    "21": "📋 กรุณาส่งรูปเล่มทะเบียนรถ รูปกรมธรรม์เดิม (ถ้ามี) วันที่ต้องการเริ่มความคุ้มครอง และเบอร์โทรศัพท์",
    "22": "🔄 กรุณาส่งรูปกรมธรรม์เดิม เพื่อให้ระบบตรวจสอบข้อมูลและวันหมดอายุ",
    "23": "📊 กรุณาส่งข้อมูลรถและกรมธรรม์เดิม เพื่อเปรียบเทียบความคุ้มครองและราคา",

    "41": "📝 สมัครสมาชิก HERO Insure ได้ที่ https://hero-insure.pages.dev/",
    "42": "⭐ ระบบตรวจสอบ HERO Credits กำลังเชื่อมต่อกับฐานข้อมูลสมาชิก",
    "43": "🔎 กรุณาพิมพ์หมายเลขคำขอหรือเบอร์โทรศัพท์",
    "44": "📄 กรุณาพิมพ์เบอร์โทรศัพท์ที่ใช้สมัครสมาชิก"
  };

  if (replies[text]) return replies[text];

  if (text.startsWith("voucher ")) {
    return `🎁 รับรหัส Voucher แล้ว\n\nรหัส: ${text.slice(8).trim()}\n\nระบบตรวจสอบสิทธิ์จะเชื่อมต่อในขั้นตอนถัดไป`;
  }

  return `ไม่พบเมนูที่เลือก\n\n${mainMenu()}`;
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

function documentRequest(vehicleType) {
  return [
    `🚘 ประเภทรถ: ${vehicleType}`,
    "",
    "กรุณาส่งรูปเอกสาร",
    "1. เล่มทะเบียนรถ",
    "2. กรมธรรม์เดิม ถ้ามี",
    "3. วันที่ต้องการเริ่มความคุ้มครอง",
    "4. เบอร์โทรศัพท์",
    "",
    "พิมพ์ 0 เพื่อกลับเมนูหลัก"
  ].join("\n");
}

async function verifySignature(body, received, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return toBase64(signed) === received;
}

async function reply(replyToken, text, token) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
  }
}

function toBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

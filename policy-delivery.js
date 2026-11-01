/**
 * HERO Insure LINE policy delivery — isolated opt-in module.
 * No existing routes, menus, voucher or policy logic are modified by this file.
 * Integration is intentionally disabled until authenticated storage and approval are ready.
 */
export async function notifyPolicyReady({ lineUserId, caseId, downloadUrl, channelAccessToken }) {
  if (!/^U[0-9a-f]{32}$/i.test(String(lineUserId || ""))) throw new Error("Invalid LINE recipient");
  if (!/^https:\/\//.test(String(downloadUrl || ""))) throw new Error("HTTPS download link required");
  if (!channelAccessToken) throw new Error("LINE channel token not configured");
  if (!caseId) throw new Error("Case ID required");
  const body = {
    to: lineUserId,
    messages: [{
      type: "text",
      text: ["HERO Insure 🛡️", "กรมธรรม์ของคุณพร้อมแล้ว", "หมายเลขเคส: " + caseId,
        "กรุณาเปิดลิงก์เพื่อยืนยันตัวตนและดาวน์โหลดเอกสาร:",
        downloadUrl,
        "เพื่อความปลอดภัย กรุณาอย่าส่งต่อลิงก์นี้"].join("\n")
    }]
  };
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: "Bearer " + channelAccessToken, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("LINE push failed: HTTP " + response.status);
  return { deliveredToLineApi: true, caseId };
}

/** Prevent delivery until a human approves the policy and payment is confirmed. */
export function assertPolicyDeliveryAllowed({ policy, caseRecord }) {
  if (!policy || !caseRecord) throw new Error("Missing policy or case");
  if (policy.caseId !== caseRecord.caseId) throw new Error("Policy/case mismatch");
  if (policy.lineUserId !== caseRecord.lineUserId) throw new Error("Policy/customer mismatch");
  if (policy.approved !== true) throw new Error("Policy not approved");
  if (policy.paymentVerified !== true) throw new Error("Payment not verified");
  if (policy.status !== "ISSUED") throw new Error("Policy not issued");
  if (!policy.privateStorageKey) throw new Error("Policy PDF not in private storage");
  return true;
}

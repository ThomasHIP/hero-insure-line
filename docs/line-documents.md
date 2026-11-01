# LINE document processing

Production webhook stays at https://hero-insure.pages.dev/api/line/webhook and forwards the original body/signature to the document Worker.

## Production secrets

- LINE_CHANNEL_SECRET: actual channel secret for channel 2008306643 (not the channel ID).
- LINE_CHANNEL_ACCESS_TOKEN: legacy value; no longer used. The Worker issues 15-minute stateless tokens for channel 2008306643 from LINE_CHANNEL_SECRET, caches them privately in memory, and renews before expiry. No copied access token or Developers Console login is required.
- ADMIN_DASHBOARD_KEY: private, unpredictable administrator password. Set through Cloudflare secrets; never commit it.

GET /health reports only binding presence, administrator setup, and public LINE bot identity. It never returns credentials or customer data. Results are cached for 60 seconds.

## Customer flow

1. Upload an image/file in LINE. The Worker downloads with the channel token, stores in private R2, and verifies object metadata before confirming storage.
2. Type ยินยอมอ่านเอกสาร to consent to sending images to the existing OpenAI OCR service. Without consent, originals remain available for manual admin review.
3. Send more documents, then ส่งเอกสารครบแล้ว. Failed storage blocks submission.

JPEG/PNG/WebP up to 5 MB use the existing Supabase OCR service. PDFs and other files remain stored for manual review. Background OCR attempts up to four pending images per customer event; failed, oversized, unsupported, or remaining pending documents can be processed/retried individually in admin. OCR is always unverified until an administrator checks the original and records verification/corrections.

## Persistence and review

Existing KV keys are preserved. Private R2 holds strongly consistent case/user snapshots and independent document manifests, OCR results and review records. KV remains a compatibility mirror for case/user records. A throttled KV mirror does not erase a successfully stored R2 record. Voucher handling continues to use KV.

/admin requires ADMIN_DASHBOARD_KEY. Each stored document has a protected original download, OCR fields, warnings, editable corrections, and PENDING/VERIFIED/REJECTED review status. Original files and result sidecars have no public R2 URLs.

## Validation

Run npm test. Tests simulate signed LINE uploads, content download, R2 head verification, same-key KV throttling, duplicate webhook delivery, consent, Thai OCR fields, private file authorization, admin corrections, XSS, download errors, and storage errors. These mocked tests do not prove production LINE token configuration or an actual customer document round trip.

A separate direct request to the existing production OCR service successfully extracted a synthetic registration image on 2026-11-01. Final production acceptance still requires a real LINE upload to return successful storage, its protected original to download, and OCR/admin review of that same document.

# HERO Insure — Case-based web document uploads (implementation specification)

Status: PROPOSED / NOT DEPLOYED. No production settings or existing insurance flows may be changed without approval.

## Approved product constraints
- Document upload is WEB-ONLY. LINE OA supplies secure links and notifications; LINE attachments must not be treated as successful uploads.
- OCR planning budget is USD 0.10–0.15 per sheet (not a verified provider quote). Track per-sheet costs and aggregate per case; avoid re-running OCR for manual text corrections.
- OCR must be triggered only after successful case-linked web upload, with retry controls to prevent duplicate charges.

## Customer experience
- LINE OA is for menu navigation, secure upload links, and notifications only. Do not solicit or accept document attachments as the primary upload path. For incoming image/file messages, send a short reply with the secure web upload link; do not claim the attachment was processed.
- Start/select a specific insurance case before uploading. Supported case types: PRB, voluntary policy purchase/renewal, claim inquiry, and document correction.
- A secure, expiring, signed case-specific URL opens the HERO Insure web form. Never expose R2 object keys, personal data, or unsigned case IDs as authorization.
- Show required documents per case: vehicle registration, existing policy (when relevant), ID or driving licence (when relevant), and contact/address information. Requirements vary by task.
- Display progress as '2 of 3 required document types received', NOT cumulative file count. Replacement of a document does not increase progress.
- Show OCR-extracted editable fields for customer confirmation; label as pending until extraction is actually integrated and successful.
- Notify customer on case creation, missing documents, admin correction requests, and review outcome; prevent duplicate LINE pushes.

## Data model (proposed)
insurance_cases(id, customer_id, case_type, vehicle_id, status, created_at, updated_at)
case_document_requirements(case_id, document_type, required)
case_documents(id, case_id, document_type, r2_key, version, upload_status, ocr_status, review_status, created_at)
case_ocr_fields(document_id, field_name, extracted_value, confirmed_value, confidence)
case_events(id, case_id, event_type, actor_id, timestamp)
line_case_links(line_user_id, case_id, verified_at)
notification_outbox(id, case_id, event_type, dedupe_key, status)

## Security and operations
- R2 private bucket; short-lived signed download or authenticated proxy only. Validate MIME, file size, malware scanning where available, ownership, and upload limits.
- Never store identity-document images or OCR text in LINE messages, logs, or public Pages assets.
- Admin authentication and role checks; audit all views, downloads, edits, decisions.
- Keep original and replacement file versions according to approved retention policy; do not delete legacy documents.
- Idempotency for webhook events and upload retries; use server-side case counts.
- Preserve existing quote, purchase, PRB, renewal, payment, and reminder routes and data; do not modify them as part of this work.

## Implementation checklist (not verified)
1. Inventory existing Pages routes, Worker handlers, and current storage bindings.
2. Build web case creation and authenticated upload routes behind a feature flag default OFF.
3. Add case-scoped document metadata, private R2 write/read, and upload validation.
4. Integrate OCR asynchronously; provide editable customer confirmation and admin review.
5. Change LINE document-event handling to reply with web link; add notification outbox.
6. Test multi-case isolation, replacement counts, duplicates, failure recovery, access control, and old workflows in staging.
7. Obtain approval for deployment, data migration, webhook configuration, and release.

## Acceptance gates
- Existing LINE webhook receives events reliably.
- Secure web upload creates correct case-linked objects in private R2.
- OCR extraction, customer confirmation, and admin review demonstrated end to end.
- Separate cases show independent counts and statuses.
- Regression tests pass for all existing insurance workflows.
- No production completion notice until all gates verified.

Connected to Cloudflare

# HERO Insure LINE Bot

Cloudflare Worker for the HERO Insure LINE Official Account.

## Current functions

- LINE webhook endpoint at `/webhook`
- HMAC-SHA256 signature verification
- Thai main menu controlled by numbers `1`–`5`
- Submenus for PRB, voluntary insurance, vouchers, member services, and staff contact
- Cloudflare Worker health check at `/`

## Required Cloudflare secrets

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

Never commit either secret to GitHub.

## Deploy

```bash
npm install
npm run deploy
```

## Webhook URL

```text
https://hero-insure-line.hero-intelligence-platform.workers.dev/webhook
```

## Current limitation

The bot responds to each number directly but does not yet persist a customer's multi-step session. Database, OCR, voucher validation, and policy records will be connected in later phases.

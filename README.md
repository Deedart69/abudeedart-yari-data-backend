# DataDock backend

A real backend for a data/airtime reselling app: user accounts, a wallet
funded through **Paystack**, and data/airtime delivered through **VTpass**.
Money is tracked in an append-only ledger so every naira is auditable.

## What this is (and isn't)

This replaces the "fake" wallet/orders from the artifact prototype with
real money movement and real delivery. It's a solid starting point, not a
finished, audited production system — see "Before you take real money" below.

## 1. Setup

```bash
cd data-app-backend
npm install
cp .env.example .env
```

Fill in `.env`:
- **Paystack**: sign up at paystack.com → Settings → API Keys & Webhooks. Use
  the `sk_test_...` / `pk_test_...` keys until you're ready to go live.
- **VTpass**: sign up at vtpass.com/business → you get sandbox credentials
  immediately; live credentials require a quick KYC review (you already have
  your CAC, so this should be fast).
- **JWT_SECRET**: any long random string (`openssl rand -hex 32`).

## 2. Run it

```bash
npm start
```

Server runs on `http://localhost:4000`. Test it:

```bash
curl http://localhost:4000/health
```

## 3. Wire up Paystack's webhook (important — do this even in sandbox)

In the Paystack dashboard → Settings → API Keys & Webhooks, set the webhook
URL to `https://<your-domain>/api/wallet/webhook/paystack`. Locally, use
[ngrok](https://ngrok.com) to expose your dev server so Paystack can reach it:

```bash
ngrok http 4000
# then set the webhook URL to https://<ngrok-id>.ngrok.io/api/wallet/webhook/paystack
```

The webhook is what actually credits a wallet — don't skip it and rely only
on the frontend redirect, which a customer can close or lose connection on.

## 4. API overview

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/register` | Create account → `{ email, password }` |
| `POST /api/auth/login` | Get a JWT → `{ email, password }` |
| `POST /api/wallet/fund/initialize` | Start a top-up → returns Paystack checkout URL |
| `GET /api/wallet/fund/verify/:reference` | Confirm a payment after redirect |
| `POST /api/wallet/webhook/paystack` | Paystack calls this automatically |
| `GET /api/wallet/balance` | Current wallet balance |
| `GET /api/purchase/plans/:network` | Live data plans + your sale price for `mtn`/`airtel`/`glo`/`9mobile` |
| `POST /api/purchase/data` | Buy a plan → `{ network, phone, planCode }` |
| `POST /api/purchase/resolve-pending` | Re-checks any stuck orders (run on a schedule) |
| `GET /api/purchase/orders` | Order history |

All routes except `/auth/*` and the webhook need `Authorization: Bearer <token>`.

## 5. Connect your frontend

In the React artifact, replace the `window.storage` wallet/order calls with
`fetch()` calls to these endpoints, and store the JWT (e.g. in React state
after login — **not** localStorage in the artifact sandbox, but fine in a
normal deployed frontend). Happy to build that wiring next if useful.

## 6. Deploying

- **Backend**: Render or Railway — connect this repo, set the same env vars,
  it'll pick up `npm start`. Both give you a public HTTPS URL for the webhook.
- **Database**: `better-sqlite3` writes to a local file, which works for one
  server instance but not multiple. Moving to Postgres (see below) is the
  first thing to do once you have real traffic or need to scale beyond one
  server.
- **Frontend**: Vercel or Netlify, pointed at your backend's public URL.

## 7. Moving to Postgres later

The schema in `src/db.js` is plain SQL with no SQLite-specific features
except `datetime('now')` (→ `now()` in Postgres) and `WAL` mode (drop that
line). Swap `better-sqlite3` for `pg`, adjust the connection setup, and the
query strings themselves barely change.

## Before you take real money — a few things to add

This starter gets the core money-safety patterns right (idempotent wallet
credits, debit-before-deliver with refund-on-failure, webhook signature
verification), but a few things are still worth doing before real customers
use it:

- **Rate limiting** on `/purchase` and `/auth` (e.g. `express-rate-limit`) —
  without it, someone can hammer your VTpass balance or brute-force logins.
- **A cron job** hitting `/purchase/resolve-pending` every couple of minutes
  (e.g. `node-cron`), so orders VTpass leaves ambiguous don't sit stuck.
- **Input validation** (e.g. `zod`) on phone numbers/amounts — right now
  validation is minimal.
- **HTTPS only** in production; Render/Railway give you this by default.
- **Logging/alerting** (even just a Slack webhook on failed purchases) so you
  notice problems before customers complain.
- **Reconciliation**: periodically sum `wallet_ledger` per user and compare
  to `users.wallet_balance` — they should always match; if they don't,
  something upstream has a bug.

# Penny Pincher

<p align="center">
  <img src="public/og-image.png" alt="Penny Pincher — OSS personal finance CLI. npx penny-pincher" width="720" />
</p>

Penny Pincher is an agent-friendly CLI for connecting a bank account with Plaid and reading account data as JSON.

```sh
npx -p penny-pincher penny-pincher auth
npx -p penny-pincher penny-pincher accounts
npx -p penny-pincher penny-pincher balances
npx -p penny-pincher penny-pincher transactions --days 30
npx -p penny-pincher penny-pincher usage
```

## Setup

The default CLI flow uses the hosted Penny Pincher backend:

```sh
npx -p penny-pincher penny-pincher auth
```

The backend runs Stripe Checkout first, creates Plaid Link tokens after billing is active, exchanges public tokens, and proxies Plaid data requests. The CLI stores Stripe customer metadata, an encrypted token envelope, and a local signing key at `~/.penny-pincher/config.json`.

If you deploy your own backend, point the CLI at it:

```sh
export PENNY_PINCHER_API_URL=https://your-vercel-app.vercel.app
npx -p penny-pincher penny-pincher auth
```

Production Plaid is the default for the hosted backend. For sandbox testing, pass `--env sandbox`:

```sh
npx -p penny-pincher penny-pincher auth --env sandbox
```

## Commands

- `penny-pincher auth` opens Plaid Link, exchanges the public token through the backend, and saves local token metadata.
- `penny-pincher accounts` prints linked accounts.
- `penny-pincher balances` prints accounts with balances.
- `penny-pincher transactions --days 30` prints recent transactions.
- `penny-pincher identity` prints account owner identity data when the product is enabled.
- `penny-pincher numbers` prints ACH/routing data when the Plaid `auth` product is enabled.
- `penny-pincher usage` prints current billing-period usage and estimated costs.
- `penny-pincher billing` opens Stripe Customer Portal for payment method and subscription management.
- `penny-pincher status` prints local connection metadata without exposing the access token.
- `penny-pincher logout` removes the saved local token.

All data commands print JSON so another agent or script can parse them directly.

## Security Notes

The hosted backend stores your Plaid app credentials, Stripe secret key, and Postgres connection in Vercel environment variables. It does not need to store per-user Plaid access tokens. Instead, it returns an encrypted token envelope to the CLI. Data commands send that envelope back with a signed request; the backend decrypts the envelope just long enough to call Plaid.

Card data is collected by Stripe Checkout and managed through Stripe Customer Portal. Penny Pincher stores Stripe customer/subscription IDs, not raw card tokens.

Penny Pincher stores the encrypted envelope and a local private signing key in `~/.penny-pincher/config.json` with `0600` file permissions. Treat that file like a password. If someone steals the full file, they can query data until you revoke the Plaid Item, cancel billing, or rotate backend encryption keys.

## Vercel Backend

Deploy this repository to Vercel and set:

```sh
PLAID_CLIENT_ID=your-client-id
PLAID_SECRET=your-secret
PLAID_SANDBOX_SECRET=your-sandbox-secret
PLAID_ENV=production
PLAID_REDIRECT_URI=https://penny-pincher-cli.vercel.app/oauth-return
PENNY_PINCHER_ENCRYPTION_KEY=at-least-32-random-bytes
PENNY_PINCHER_TOKEN_KEY_VERSION=v1
POSTGRES_URL=postgresql://...neon.tech/neondb?sslmode=require
STRIPE_SECRET_KEY=sk_live_or_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_METERED_PRICE_ID=price_...
STRIPE_METER_EVENT_NAME=penny_pincher_plaid_request
PENNY_PINCHER_DEFAULT_USAGE_COST_CENTS=1
```

Generate a strong encryption key with:

```sh
openssl rand -base64 32
```

The Vercel API exposes:

- `POST /api/billing-session`
- `POST /api/billing-status`
- `POST /api/billing-portal`
- `POST /api/billing-usage`
- `POST /api/stripe-webhook`
- `POST /api/link-token`
- `POST /api/exchange`
- `POST /api/accounts`
- `POST /api/balances`
- `POST /api/transactions`
- `POST /api/identity`
- `POST /api/numbers`

Before deploying billing, run the SQL in `migrations/001_billing.sql` against the Neon Postgres database. Configure the Stripe webhook endpoint at `/api/stripe-webhook` for checkout session and subscription events.

## Bring Your Own Plaid App

You can still run the CLI without the hosted broker by using local Plaid credentials:

```sh
export PLAID_CLIENT_ID=your-client-id
export PLAID_SECRET=your-secret
export PLAID_ENV=sandbox
npx -p penny-pincher penny-pincher auth --direct-plaid
```

## Development

```sh
npm install
npm run typecheck
npm run build
npm run dev -- status
```

Publishing is intentionally left to the package owner:

```sh
npm login
npm publish
```

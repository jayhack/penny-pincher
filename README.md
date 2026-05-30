# Penny Pincher

<p align="center">
  <img src="public/og-image.png" alt="Penny Pincher — OSS personal finance CLI. npx penny-pincher" width="720" />
</p>

Penny Pincher is an agent-friendly CLI for connecting a bank account with Plaid and reading account data as JSON.

```sh
npx -p penny-pincher penny-pincher
npx -p penny-pincher penny-pincher auth
npx -p penny-pincher penny-pincher accounts
npx -p penny-pincher penny-pincher balances
npx -p penny-pincher penny-pincher transactions --days 30
```

Running `penny-pincher` with no command prints a JSON readiness report with the next command to run. It does not open an interactive menu by default.

## Setup

The default CLI flow uses the hosted Penny Pincher backend:

```sh
npx -p penny-pincher penny-pincher auth
```

The CLI prints any required Stripe Checkout or Plaid Link URLs so an agent can hand the URL to a human. Pass `--open` when a human is driving the terminal and you want the browser to open automatically.

The backend creates Plaid Link tokens, exchanges public tokens, and proxies Plaid data requests. The CLI stores encrypted token envelopes and a local signing key at `~/.penny-pincher/config.json`.

Run `auth` again to link another institution. Data commands query every linked item, so Chase and Mercury can sit side by side in the same local config.

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

- `penny-pincher auth` opens Plaid Link, exchanges the public token through the backend, and adds or refreshes one linked institution.
- `penny-pincher accounts` prints linked accounts.
- `penny-pincher balances` prints accounts with balances.
- `penny-pincher transactions --days 30` prints recent transactions.
- `penny-pincher identity` prints account owner identity data when the product is enabled.
- `penny-pincher numbers` prints ACH/routing data when the Plaid `auth` product is enabled.
- `penny-pincher status` prints local connection metadata, readiness, and the next command without exposing secrets.
- `penny-pincher doctor` prints the same machine-readable readiness report as `status`.
- `penny-pincher usage` prints current billing-period usage and estimated costs.
- `penny-pincher billing` prints a Stripe Customer Portal URL.
- `penny-pincher interactive` opens the human-oriented menu.
- `penny-pincher logout` removes all saved local tokens.

All data commands print JSON so another agent or script can parse them directly.
Commands accept `--json` where they have non-data output. Error responses also become machine-readable when `--json` is present.

## Security Notes

The hosted backend stores your Plaid app credentials in Vercel environment variables. It does not need to store per-user Plaid access tokens. Instead, it returns encrypted token envelopes to the CLI. Data commands send each envelope back with a signed request; the backend decrypts the envelope just long enough to call Plaid.

Penny Pincher stores the encrypted envelope and a local private signing key in `~/.penny-pincher/config.json` with `0600` file permissions. Treat that file like a password. If someone steals the full file, they can query data until you revoke the Plaid Item or rotate backend encryption keys.

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
```

Generate a strong encryption key with:

```sh
openssl rand -base64 32
```

The Vercel API exposes:

- `POST /api/link-token`
- `POST /api/exchange`
- `POST /api/accounts`
- `POST /api/balances`
- `POST /api/transactions`
- `POST /api/identity`
- `POST /api/numbers`

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

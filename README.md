# Penny Pincher

<p align="center">
  <img src="public/og-image.png" alt="Penny Pincher — OSS personal finance CLI. npx penny-pincher" width="720" />
</p>

Penny Pincher is an agent-friendly CLI for connecting a bank account with Plaid and reading account data as JSON.

```sh
npx -p penny-pincher penny-pincher
npx -p penny-pincher penny-pincher auth
npx -p penny-pincher penny-pincher sync
npx -p penny-pincher penny-pincher accounts
npx penny-pincher dashboard
npx -p penny-pincher penny-pincher balances
npx -p penny-pincher penny-pincher transactions --days 30
npx -p penny-pincher penny-pincher recurring
npx -p penny-pincher penny-pincher cache transactions --days 30
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

- `penny-pincher auth` opens Plaid Link, exchanges the public token through the backend, and adds or refreshes one linked institution. It requests 730 days of transaction history by default; use `--history-days <days>` to change that for new Items.
- `penny-pincher accounts` prints linked accounts.
- `penny-pincher dashboard` starts a local dashboard server with linked accounts and account-level transactions.
- `penny-pincher balances` prints accounts with balances.
- `penny-pincher transactions --days 30` prints recent transactions.
- `penny-pincher recurring` prints Plaid recurring inflow and outflow streams.
- `penny-pincher sync` hydrates or updates the encrypted local SQLite cache at `~/.penny-pincher/penny.db`. This is the command that writes Plaid data into SQLite.
- `penny-pincher cache summary` prints local cache counts and sync state.
- `penny-pincher cache transactions --days 30` reads transactions from the local cache without calling Plaid.
- `penny-pincher cache accounts`, `cache holdings`, and `cache investment-transactions` read cached account and Investments data.
- `penny-pincher identity` prints account owner identity data when the product is enabled.
- `penny-pincher numbers` prints ACH/routing data when the Plaid `auth` product is enabled.
- `penny-pincher status` prints local connection metadata, readiness, and the next command without exposing secrets.
- `penny-pincher doctor` prints the same machine-readable readiness report as `status`.
- `penny-pincher usage` prints current billing-period usage and estimated costs.
- `penny-pincher billing` prints a Stripe Customer Portal URL.
- `penny-pincher interactive` opens the human-oriented menu.
- `penny-pincher logout` removes all saved local tokens.
- `penny-pincher logout --purge-data` also deletes the local SQLite cache and removes its encryption key.

All data commands print JSON so another agent or script can parse them directly.
Commands accept `--json` where they have non-data output. Error responses also become machine-readable when `--json` is present.

## Local SQLite Cache

Penny Pincher has two data paths:

- Live commands such as `accounts`, `balances`, `transactions`, `recurring`, `identity`, and `numbers` call the backend/Plaid read path directly.
- Local cache commands such as `sync`, `cache`, and the dashboard net worth chart use `~/.penny-pincher/penny.db`.

The cache is intentionally explicit. `penny-pincher sync` is the writer: it pulls data for every linked Item and stores encrypted rows in SQLite. Normal live API reads do not write through to SQLite, and the dashboard Refresh button currently re-reads the local dashboard API from the existing DB; it does not call Plaid or hydrate the cache.

Recommended agent flow:

```sh
npx -p penny-pincher penny-pincher auth
npx -p penny-pincher penny-pincher sync
npx penny-pincher dashboard
```

Use `penny-pincher sync` again whenever you want to refresh the local warehouse for dashboards or agent analysis. Use `penny-pincher sync --reset` to delete the local DB first and rebuild it from Plaid. If `~/.penny-pincher/penny.db` is deleted manually, only the cache is gone; run `penny-pincher sync` to recreate it as long as `~/.penny-pincher/config.json` still contains the linked Item metadata and `localDatabaseKey`.

The dashboard net worth series is currently a balance reconstruction: it starts from current cached account balances and walks backward through cached transaction amounts. This is useful for the first dashboard graph, but true historical investment market value requires cached investment holdings/value snapshots over time.

## Security Notes

The hosted backend stores your Plaid app credentials in Vercel environment variables. It does not need to store per-user Plaid access tokens. Instead, it returns encrypted token envelopes to the CLI. Data commands send each envelope back with a signed request; the backend decrypts the envelope just long enough to call Plaid.

Penny Pincher stores the encrypted envelope and a local private signing key in `~/.penny-pincher/config.json` with `0600` file permissions. Treat that file like a password. If someone steals the full file, they can query data until you revoke the Plaid Item or rotate backend encryption keys.

The local cache stores account, transaction, holding, security, and investment transaction payloads as AES-256-GCM encrypted JSON inside `~/.penny-pincher/penny.db`. The cache encryption key is a random 32-byte base64url value stored in `~/.penny-pincher/config.json` as `localDatabaseKey`, by design, so future `npx penny-pincher` runs can read the cache without prompting. Treat `config.json` as the root local secret: someone who can copy both the config and database can decrypt the cached data. The SQLite file itself uses keyed hashes for record lookup and does not store raw Plaid IDs as primary keys.

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
- `POST /api/transactions-sync`
- `POST /api/recurring`
- `POST /api/investments-holdings`
- `POST /api/investments-transactions`
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

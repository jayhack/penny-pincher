# Finclaw

Finclaw is an agent-friendly CLI for connecting a bank account with Plaid and reading account data as JSON.

```sh
npx finclaw auth
npx finclaw accounts
npx finclaw balances
npx finclaw transactions --days 30
```

## Setup

Create a Plaid app and export your credentials:

```sh
export PLAID_CLIENT_ID=your-client-id
export PLAID_SECRET=your-secret
export PLAID_ENV=sandbox
```

You can also put those values in a `.env` file in the directory where you run `finclaw`.

For Chase and other OAuth institutions, configure a Plaid redirect URI and use the same URI locally:

```sh
export PLAID_REDIRECT_URI=http://localhost:7777/oauth-return
npx finclaw auth --env development --port 7777
```

## Commands

- `finclaw auth` opens Plaid Link, exchanges the public token, and saves the access token at `~/.finclaw/config.json`.
- `finclaw accounts` prints linked accounts.
- `finclaw balances` prints accounts with balances.
- `finclaw transactions --days 30` prints recent transactions.
- `finclaw identity` prints account owner identity data when the product is enabled.
- `finclaw numbers` prints ACH/routing data when the Plaid `auth` product is enabled.
- `finclaw status` prints local connection metadata without exposing the access token.
- `finclaw logout` removes the saved local token.

All data commands print JSON so another agent or script can parse them directly.

## Security Notes

Finclaw stores your Plaid access token locally in `~/.finclaw/config.json` with `0600` file permissions. Treat that file like a password. Do not commit it, paste it into prompts, or share it.

Finclaw does not proxy your bank data through a hosted service. The CLI talks to Plaid from your machine using your Plaid credentials.

## Development

```sh
npm install
npm run build
npm run dev -- status
```

Publishing is intentionally left to the package owner:

```sh
npm publish
```

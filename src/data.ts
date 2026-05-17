import { postSignedDataRequest } from "./backend.js";
import { loadConfig } from "./config.js";
import { createPlaidClient } from "./plaid.js";

export async function getAccounts() {
  const hosted = await hostedRequest("accounts", {});
  if (hosted) {
    return hosted;
  }

  const { client, accessToken } = await linkedClient();
  const response = await client.accountsGet({ access_token: accessToken });
  return response.data.accounts;
}

export async function getBalances() {
  const hosted = await hostedRequest("balances", {});
  if (hosted) {
    return hosted;
  }

  const { client, accessToken } = await linkedClient();
  const response = await client.accountsBalanceGet({ access_token: accessToken });
  return response.data.accounts;
}

export async function getTransactions(options: { startDate: string; endDate: string; count: number }) {
  const hosted = await hostedRequest("transactions", options);
  if (hosted) {
    return hosted;
  }

  const { client, accessToken } = await linkedClient();
  const response = await client.transactionsGet({
    access_token: accessToken,
    start_date: options.startDate,
    end_date: options.endDate,
    options: {
      count: options.count
    }
  });

  return {
    accounts: response.data.accounts,
    transactions: response.data.transactions,
    totalTransactions: response.data.total_transactions
  };
}

export async function getIdentity() {
  const hosted = await hostedRequest("identity", {});
  if (hosted) {
    return hosted;
  }

  const { client, accessToken } = await linkedClient();
  const response = await client.identityGet({ access_token: accessToken });
  return response.data.accounts;
}

export async function getAccountNumbers() {
  const hosted = await hostedRequest("numbers", {});
  if (hosted) {
    return hosted;
  }

  const { client, accessToken } = await linkedClient();
  const response = await client.authGet({ access_token: accessToken });
  return {
    accounts: response.data.accounts,
    numbers: response.data.numbers
  };
}

export async function getStatus() {
  const config = await loadConfig();

  return {
    mode: config.tokenEnvelope ? "hosted" : config.accessToken ? "direct" : config.mode,
    environment: config.environment,
    backendUrl: config.backendUrl,
    linked: Boolean(config.tokenEnvelope || config.accessToken),
    itemId: config.itemId,
    institutionName: config.institutionName,
    institutionId: config.institutionId,
    products: config.products,
    countryCodes: config.countryCodes,
    updatedAt: config.updatedAt
  };
}

async function linkedClient() {
  const config = await loadConfig();

  if (!config.accessToken) {
    throw new Error("No linked Plaid item found. Run `penny-pincher auth` first.");
  }

  return {
    client: createPlaidClient(config.environment),
    accessToken: config.accessToken
  };
}

async function hostedRequest<TResult>(path: string, payload: unknown): Promise<TResult | undefined> {
  const config = await loadConfig();

  if (!config.tokenEnvelope) {
    return undefined;
  }

  if (!config.backendUrl || !config.privateKeyPem) {
    throw new Error("Hosted Penny Pincher config is incomplete. Run `penny-pincher auth` again.");
  }

  return postSignedDataRequest<typeof payload, TResult>({
    backendUrl: config.backendUrl,
    path: `/api/${path}`,
    tokenEnvelope: config.tokenEnvelope,
    privateKeyPem: config.privateKeyPem,
    payload
  });
}

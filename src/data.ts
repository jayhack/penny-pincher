import { createBillingPortalSession, getBillingUsage, postSignedDataRequest, resolveBackendUrl } from "./backend.js";
import {
  getLinkedItems,
  loadConfig,
  type LinkedAccountItem,
  type PennyPincherConfig
} from "./config.js";
import { createPlaidClient } from "./plaid.js";

type JsonRecord = Record<string, unknown>;

interface LinkedContext {
  config: PennyPincherConfig;
  items: LinkedAccountItem[];
}

interface TransactionResult {
  accounts: unknown[];
  transactions: JsonRecord[];
  totalTransactions: number;
}

interface AccountNumbersResult {
  accounts: unknown[];
  numbers: Record<string, unknown>;
}

interface RecurringResult {
  itemId?: string;
  institutionName?: string;
  institutionId?: string;
  updatedDatetime?: string;
  personalFinanceCategoryVersion?: unknown;
  requestId?: string;
  inflowStreams: JsonRecord[];
  outflowStreams: JsonRecord[];
}

export async function getAccounts() {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getAccountsForItem(context.config, item)));
  return results.flat();
}

export async function getBalances() {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getBalancesForItem(context.config, item)));
  return results.flat();
}

export async function getTransactions(options: { startDate: string; endDate: string; count: number }) {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getTransactionsForItem(context.config, item, options)));
  const transactions = results
    .flatMap((result) => result.transactions)
    .sort((left, right) => transactionDate(right).localeCompare(transactionDate(left)))
    .slice(0, options.count);

  return {
    accounts: results.flatMap((result) => result.accounts),
    transactions,
    totalTransactions: results.reduce((total, result) => total + result.totalTransactions, 0)
  };
}

export async function getRecurring(options: { accountIds?: string[] }) {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getRecurringForItem(context.config, item, options)));

  return {
    itemCount: results.length,
    inflowStreams: results.flatMap((result) => result.inflowStreams),
    outflowStreams: results.flatMap((result) => result.outflowStreams),
    items: results
  };
}

export async function getIdentity() {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getIdentityForItem(context.config, item)));
  return results.flat();
}

export async function getAccountNumbers() {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getAccountNumbersForItem(context.config, item)));
  return mergeAccountNumbers(results);
}

export async function getStatus() {
  const config = await loadConfig();
  const items = getLinkedItems(config);
  const primary = items.at(-1);
  const mode = primary?.mode ?? config.mode;
  const backendUrl = mode === "direct" ? undefined : resolveBackendUrl(primary?.backendUrl ?? config.backendUrl);

  return {
    mode,
    environment: primary?.environment ?? config.environment,
    backendUrl,
    linked: items.length > 0,
    itemCount: items.length,
    hosted: items.some((item) => item.mode === "hosted") && Boolean(config.publicKeyPem && config.privateKeyPem),
    items: items.map((item) => publicLinkedItem(config, item)),
    itemId: config.itemId,
    institutionName: config.institutionName,
    institutionId: config.institutionId,
    products: config.products,
    countryCodes: config.countryCodes,
    billingStatus: config.billingStatus,
    stripeCustomerId: config.stripeCustomerId,
    stripeSubscriptionId: config.stripeSubscriptionId,
    billingCurrentPeriodStart: config.billingCurrentPeriodStart,
    billingCurrentPeriodEnd: config.billingCurrentPeriodEnd,
    updatedAt: config.updatedAt
  };
}

export async function getUsage() {
  const config = await hostedBillingConfig();
  return getBillingUsage(
    config.backendUrl,
    {
      publicKeyPem: config.publicKeyPem
    },
    config.privateKeyPem
  );
}

export async function createBillingPortal(returnUrl: string) {
  const config = await hostedBillingConfig();
  return createBillingPortalSession(
    config.backendUrl,
    {
      publicKeyPem: config.publicKeyPem,
      returnUrl
    },
    config.privateKeyPem
  );
}

async function linkedContext(): Promise<LinkedContext> {
  const config = await loadConfig();
  const items = getLinkedItems(config);

  if (items.length === 0) {
    throw new Error("No linked Plaid item found. Run `penny-pincher auth` first.");
  }

  return { config, items };
}

async function getAccountsForItem(config: PennyPincherConfig, item: LinkedAccountItem): Promise<unknown[]> {
  if (item.mode === "hosted") {
    return hostedRequest<unknown[]>(config, item, "accounts", {});
  }

  const client = createPlaidClient(item.environment);
  const response = await client.accountsGet({ access_token: directAccessToken(item) });
  return response.data.accounts;
}

async function getBalancesForItem(config: PennyPincherConfig, item: LinkedAccountItem): Promise<unknown[]> {
  if (item.mode === "hosted") {
    return hostedRequest<unknown[]>(config, item, "balances", {});
  }

  const client = createPlaidClient(item.environment);
  const response = await client.accountsBalanceGet({ access_token: directAccessToken(item) });
  return response.data.accounts;
}

async function getTransactionsForItem(
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  options: { startDate: string; endDate: string; count: number }
): Promise<TransactionResult> {
  if (item.mode === "hosted") {
    const result = await hostedRequest<unknown>(config, item, "transactions", options);
    return normalizeTransactionResult(result);
  }

  const client = createPlaidClient(item.environment);
  const response = await client.transactionsGet({
    access_token: directAccessToken(item),
    start_date: options.startDate,
    end_date: options.endDate,
    options: {
      count: options.count
    }
  });

  return {
    accounts: response.data.accounts,
    transactions: response.data.transactions as unknown as JsonRecord[],
    totalTransactions: response.data.total_transactions
  };
}

async function getRecurringForItem(
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  options: { accountIds?: string[] }
): Promise<RecurringResult> {
  if (item.mode === "hosted") {
    const result = await hostedRequest<unknown>(config, item, "recurring", options);
    return normalizeRecurringResult(item, result);
  }

  const client = createPlaidClient(item.environment);
  const response = await client.transactionsRecurringGet({
    access_token: directAccessToken(item),
    account_ids: options.accountIds
  });
  return normalizeRecurringResult(item, {
    inflowStreams: response.data.inflow_streams,
    outflowStreams: response.data.outflow_streams,
    updatedDatetime: response.data.updated_datetime,
    personalFinanceCategoryVersion: response.data.personal_finance_category_version,
    requestId: response.data.request_id
  });
}

async function getIdentityForItem(config: PennyPincherConfig, item: LinkedAccountItem): Promise<unknown[]> {
  if (item.mode === "hosted") {
    return hostedRequest<unknown[]>(config, item, "identity", {});
  }

  const client = createPlaidClient(item.environment);
  const response = await client.identityGet({ access_token: directAccessToken(item) });
  return response.data.accounts;
}

async function getAccountNumbersForItem(
  config: PennyPincherConfig,
  item: LinkedAccountItem
): Promise<AccountNumbersResult> {
  if (item.mode === "hosted") {
    const result = await hostedRequest<unknown>(config, item, "numbers", {});
    return normalizeAccountNumbersResult(result);
  }

  const client = createPlaidClient(item.environment);
  const response = await client.authGet({ access_token: directAccessToken(item) });
  return {
    accounts: response.data.accounts,
    numbers: response.data.numbers as unknown as Record<string, unknown>
  };
}

function hostedRequest<TResult>(
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  path: string,
  payload: unknown
): Promise<TResult> {
  if (!item.tokenEnvelope || !config.privateKeyPem) {
    throw new Error("Hosted Penny Pincher config is incomplete. Run `penny-pincher auth` again.");
  }

  return postSignedDataRequest<typeof payload, TResult>({
    backendUrl: resolveBackendUrl(item.backendUrl ?? config.backendUrl),
    path: `/api/${path}`,
    tokenEnvelope: item.tokenEnvelope,
    privateKeyPem: config.privateKeyPem,
    payload
  });
}

async function hostedBillingConfig() {
  const config = await loadConfig();

  if (!config.publicKeyPem || !config.privateKeyPem) {
    throw new Error("Hosted Penny Pincher billing config is incomplete. Run `penny-pincher auth` first.");
  }
  const backendUrl = resolveBackendUrl(config.backendUrl);

  return {
    backendUrl,
    publicKeyPem: config.publicKeyPem,
    privateKeyPem: config.privateKeyPem
  };
}

function directAccessToken(item: LinkedAccountItem): string {
  if (!item.accessToken) {
    throw new Error(`Direct Plaid config is incomplete for ${item.institutionName ?? item.itemId ?? "linked item"}.`);
  }

  return item.accessToken;
}

function publicLinkedItem(config: PennyPincherConfig, item: LinkedAccountItem) {
  return {
    mode: item.mode,
    environment: item.environment,
    backendUrl: item.mode === "hosted" ? resolveBackendUrl(item.backendUrl ?? config.backendUrl) : undefined,
    itemId: item.itemId,
    institutionName: item.institutionName,
    institutionId: item.institutionId,
    products: item.products,
    countryCodes: item.countryCodes,
    linkedAt: item.linkedAt,
    updatedAt: item.updatedAt
  };
}

function normalizeRecurringResult(item: LinkedAccountItem, result: unknown): RecurringResult {
  const value = result as {
    inflowStreams?: unknown;
    inflow_streams?: unknown;
    outflowStreams?: unknown;
    outflow_streams?: unknown;
    updatedDatetime?: unknown;
    updated_datetime?: unknown;
    personalFinanceCategoryVersion?: unknown;
    personal_finance_category_version?: unknown;
    requestId?: unknown;
    request_id?: unknown;
  };
  const source = {
    itemId: item.itemId,
    institutionName: item.institutionName,
    institutionId: item.institutionId
  };

  return {
    ...source,
    updatedDatetime: stringValue(value.updatedDatetime ?? value.updated_datetime),
    personalFinanceCategoryVersion: value.personalFinanceCategoryVersion ?? value.personal_finance_category_version,
    requestId: stringValue(value.requestId ?? value.request_id),
    inflowStreams: normalizeStreams(value.inflowStreams ?? value.inflow_streams, "inflow", source),
    outflowStreams: normalizeStreams(value.outflowStreams ?? value.outflow_streams, "outflow", source)
  };
}

function normalizeTransactionResult(result: unknown): TransactionResult {
  const value = result as {
    accounts?: unknown;
    transactions?: unknown;
    totalTransactions?: unknown;
    total_transactions?: unknown;
  };

  return {
    accounts: Array.isArray(value.accounts) ? value.accounts : [],
    transactions: Array.isArray(value.transactions) ? value.transactions as JsonRecord[] : [],
    totalTransactions:
      typeof value.totalTransactions === "number"
        ? value.totalTransactions
        : typeof value.total_transactions === "number"
          ? value.total_transactions
          : 0
  };
}

function normalizeStreams(value: unknown, type: "inflow" | "outflow", source: {
  itemId?: string;
  institutionName?: string;
  institutionId?: string;
}): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((stream) => ({
    ...source,
    streamType: type,
    ...(isRecord(stream) ? stream : {})
  }));
}

function normalizeAccountNumbersResult(result: unknown): AccountNumbersResult {
  const value = result as {
    accounts?: unknown;
    numbers?: unknown;
  };

  return {
    accounts: Array.isArray(value.accounts) ? value.accounts : [],
    numbers: isRecord(value.numbers) ? value.numbers : {}
  };
}

function mergeAccountNumbers(results: AccountNumbersResult[]): AccountNumbersResult {
  const numbers: Record<string, unknown> = {};

  for (const result of results) {
    for (const [key, value] of Object.entries(result.numbers)) {
      if (Array.isArray(value)) {
        const existing = numbers[key];
        numbers[key] = [...(Array.isArray(existing) ? existing : []), ...value];
      } else if (value !== undefined) {
        numbers[key] = value;
      }
    }
  }

  return {
    accounts: results.flatMap((result) => result.accounts),
    numbers
  };
}

function transactionDate(transaction: JsonRecord): string {
  if (typeof transaction.date === "string") {
    return transaction.date;
  }

  if (typeof transaction.authorized_date === "string") {
    return transaction.authorized_date;
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

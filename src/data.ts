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

interface HoldingsResult {
  source: LinkedItemSource;
  accounts: JsonRecord[];
  holdings: JsonRecord[];
  securities: JsonRecord[];
  item?: unknown;
  requestId?: string;
}

interface LinkedItemSource {
  mode: LinkedAccountItem["mode"];
  environment: LinkedAccountItem["environment"];
  itemId?: string;
  institutionName?: string;
  institutionId?: string;
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

export async function getHoldings() {
  const context = await linkedContext();
  const results = await Promise.all(context.items.map((item) => getHoldingsForItem(context.config, item)));
  return mergeHoldings(results);
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

async function getHoldingsForItem(config: PennyPincherConfig, item: LinkedAccountItem): Promise<HoldingsResult> {
  if (item.mode === "hosted") {
    const result = await hostedRequest<unknown>(config, item, "holdings", {});
    return normalizeHoldingsResult(result, item);
  }

  const client = createPlaidClient(item.environment);
  const response = await client.investmentsHoldingsGet({ access_token: directAccessToken(item) });
  return normalizeHoldingsResult(response.data, item);
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

function normalizeHoldingsResult(result: unknown, item: LinkedAccountItem): HoldingsResult {
  const value = result as {
    accounts?: unknown;
    holdings?: unknown;
    securities?: unknown;
    item?: unknown;
    request_id?: unknown;
    requestId?: unknown;
  };

  return {
    source: linkedItemSource(item),
    accounts: asRecords(value.accounts),
    holdings: asRecords(value.holdings),
    securities: asRecords(value.securities),
    item: value.item,
    requestId:
      typeof value.request_id === "string"
        ? value.request_id
        : typeof value.requestId === "string"
          ? value.requestId
          : undefined
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

function mergeHoldings(results: HoldingsResult[]) {
  const positions = results
    .flatMap((result) => buildPositions(result))
    .sort((left, right) => numericValue(right.institutionValue) - numericValue(left.institutionValue));

  return {
    accounts: results.flatMap((result) => result.accounts),
    holdings: results.flatMap((result) => result.holdings),
    securities: results.flatMap((result) => result.securities),
    positions,
    items: results.map((result) => ({
      ...result.source,
      accountCount: result.accounts.length,
      holdingCount: result.holdings.length,
      securityCount: result.securities.length,
      item: result.item,
      requestId: result.requestId
    }))
  };
}

function buildPositions(result: HoldingsResult): JsonRecord[] {
  const accountsById = indexById(result.accounts, "account_id");
  const securitiesById = indexById(result.securities, "security_id");

  return result.holdings.map((holding) => {
    const accountId = stringProp(holding, "account_id");
    const securityId = stringProp(holding, "security_id");
    const account = accountId ? accountsById.get(accountId) : undefined;
    const security = securityId ? securitiesById.get(securityId) : undefined;

    return compactRecord({
      institutionName: result.source.institutionName,
      institutionId: result.source.institutionId,
      itemId: result.source.itemId,
      accountId,
      accountName: account ? stringProp(account, "name") : undefined,
      accountMask: account ? stringProp(account, "mask") : undefined,
      accountType: account?.type,
      accountSubtype: account?.subtype,
      securityId,
      securityName: security ? stringProp(security, "name") : undefined,
      tickerSymbol: security ? stringProp(security, "ticker_symbol") : undefined,
      securityType: security?.type,
      securitySubtype: security?.subtype,
      quantity: holding.quantity,
      institutionValue: holding.institution_value,
      institutionPrice: holding.institution_price,
      institutionPriceAsOf: holding.institution_price_as_of,
      costBasis: holding.cost_basis,
      currencyCode:
        stringProp(holding, "iso_currency_code")
        ?? (security ? stringProp(security, "iso_currency_code") : undefined)
        ?? stringProp(holding, "unofficial_currency_code")
        ?? (security ? stringProp(security, "unofficial_currency_code") : undefined),
      holding,
      security,
      account
    });
  });
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

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function linkedItemSource(item: LinkedAccountItem): LinkedItemSource {
  return {
    mode: item.mode,
    environment: item.environment,
    itemId: item.itemId,
    institutionName: item.institutionName,
    institutionId: item.institutionId
  };
}

function indexById(records: JsonRecord[], key: string): Map<string, JsonRecord> {
  return new Map(
    records
      .map((record) => [stringProp(record, key), record] as const)
      .filter((entry): entry is readonly [string, JsonRecord] => Boolean(entry[0]))
  );
}

function stringProp(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

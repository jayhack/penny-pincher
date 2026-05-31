import { constants } from "node:fs";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { postSignedDataRequest, resolveBackendUrl } from "./backend.js";
import {
  configDir,
  getLinkedItems,
  loadConfig,
  saveConfig,
  type LinkedAccountItem,
  type PennyPincherConfig
} from "./config.js";
import {
  decryptLocalJson,
  encryptLocalJson,
  generateLocalDatabaseKey,
  localBlindIndex
} from "./crypto.js";
import { createPlaidClient } from "./plaid.js";

type JsonRecord = Record<string, unknown>;
type LocalDatabase = Database.Database;

export const localDatabasePath = join(configDir, "penny.db");

export interface LocalSyncOptions {
  count: number;
  maxPages: number;
  daysRequested?: number;
  reset: boolean;
  investments: boolean;
  investmentStartDate: string;
  investmentEndDate: string;
}

export interface LocalReadOptions {
  startDate?: string;
  endDate?: string;
  count?: number;
}

export interface NetWorthPoint {
  date: string;
  netWorth: number;
}

export interface NetWorthSeries {
  available: boolean;
  databasePath: string;
  generatedAt: string;
  currentNetWorth: number;
  startNetWorth: number;
  change: number;
  changePercent: number | null;
  currencyCode: string;
  points: NetWorthPoint[];
  accountCount: number;
  transactionCount: number;
  method: "balance-reconstruction";
}

interface TransactionsSyncResult {
  accounts: JsonRecord[];
  added: JsonRecord[];
  modified: JsonRecord[];
  removed: JsonRecord[];
  nextCursor: string;
  hasMore: boolean;
  transactionsUpdateStatus?: string;
  requestId?: string;
}

interface InvestmentHoldingsResult {
  accounts: JsonRecord[];
  holdings: JsonRecord[];
  securities: JsonRecord[];
  item?: JsonRecord;
  requestId?: string;
  isInvestmentsFallbackItem?: boolean;
}

interface InvestmentTransactionsResult {
  item?: JsonRecord;
  accounts: JsonRecord[];
  securities: JsonRecord[];
  investmentTransactions: JsonRecord[];
  totalInvestmentTransactions: number;
  requestId?: string;
  isInvestmentsFallbackItem?: boolean;
}

interface SyncState {
  cursor?: string;
  status?: string;
  lastSyncedAt?: string;
}

export async function syncLocalCache(options: LocalSyncOptions) {
  if (options.reset) {
    await deleteDatabaseFiles();
  }

  const loadedConfig = await loadConfig();
  const items = getLinkedItems(loadedConfig);

  if (items.length === 0) {
    throw new Error("No linked Plaid item found. Run `penny-pincher auth` first.");
  }

  const config = await ensureLocalDatabaseKey(loadedConfig);
  const linkedItems = getLinkedItems(config);

  const db = await openLocalDatabase();
  try {
    const results = [];
    for (const item of linkedItems) {
      results.push(await syncItem(db, config, item, config.localDatabaseKey, options));
    }

    return {
      ok: true,
      databasePath: localDatabasePath,
      encrypted: true,
      keyLocation: "config.json:localDatabaseKey",
      itemCount: linkedItems.length,
      items: results,
      cache: readSummary(db)
    };
  } finally {
    db.close();
  }
}

export async function readLocalCache(kind: string, options: LocalReadOptions) {
  const config = await loadConfig();
  if (!config.localDatabaseKey) {
    throw new Error("Local database key is missing. Run `penny-pincher sync` first.");
  }

  if (!(await localDatabaseExists())) {
    throw new Error("Local database does not exist. Run `penny-pincher sync` first.");
  }

  const localDatabaseKey = config.localDatabaseKey;
  const db = await openLocalDatabase();
  try {
    if (kind === "summary") {
      return {
        databasePath: localDatabasePath,
        encrypted: true,
        keyLocation: "config.json:localDatabaseKey",
        ...readSummary(db)
      };
    }

    if (kind === "accounts") {
      return {
        databasePath: localDatabasePath,
        accounts: readEncryptedRows(db, "accounts", localDatabaseKey)
          .map((row) => enrichWithItem(row.value, row.itemKey, db, localDatabaseKey))
      };
    }

    if (kind === "transactions") {
      return {
        databasePath: localDatabasePath,
        transactions: filterByDate(
          readEncryptedRows(db, "transactions", localDatabaseKey)
            .map((row) => enrichWithItem(row.value, row.itemKey, db, localDatabaseKey)),
          options
        )
          .sort((left, right) => recordDate(right).localeCompare(recordDate(left)))
          .slice(0, options.count)
      };
    }

    if (kind === "holdings") {
      return {
        databasePath: localDatabasePath,
        holdings: readEncryptedRows(db, "investment_holdings", localDatabaseKey)
          .map((row) => enrichWithItem(row.value, row.itemKey, db, localDatabaseKey)),
        securities: readEncryptedRows(db, "securities", localDatabaseKey).map((row) => row.value)
      };
    }

    if (kind === "investment-transactions") {
      return {
        databasePath: localDatabasePath,
        investmentTransactions: filterByDate(
          readEncryptedRows(db, "investment_transactions", localDatabaseKey)
            .map((row) => enrichWithItem(row.value, row.itemKey, db, localDatabaseKey)),
          options
        )
          .sort((left, right) => recordDate(right).localeCompare(recordDate(left)))
          .slice(0, options.count)
      };
    }

    throw new Error(`Unknown cache kind "${kind}". Use summary, accounts, transactions, holdings, or investment-transactions.`);
  } finally {
    db.close();
  }
}

export async function getLocalCacheStatus() {
  const config = await loadConfig();
  const exists = await localDatabaseExists();
  if (!exists || !config.localDatabaseKey) {
    return {
      databasePath: localDatabasePath,
      exists,
      encrypted: exists,
      hasKey: Boolean(config.localDatabaseKey)
    };
  }

  const db = await openLocalDatabase();
  try {
    return {
      databasePath: localDatabasePath,
      exists: true,
      encrypted: true,
      hasKey: true,
      ...readSummary(db)
    };
  } finally {
    db.close();
  }
}

export async function getNetWorthSeries(options: { days: number }): Promise<NetWorthSeries | undefined> {
  const config = await loadConfig();
  if (!config.localDatabaseKey || !(await localDatabaseExists())) {
    return undefined;
  }

  const db = await openLocalDatabase();
  try {
    const accounts = readEncryptedRows(db, "accounts", config.localDatabaseKey).map((row) => row.value);
    const transactions = readEncryptedRows(db, "transactions", config.localDatabaseKey).map((row) => row.value);
    const todayDate = today();
    const startDate = daysBefore(todayDate, options.days);
    const points = buildNetWorthPoints(accounts, transactions, startDate, todayDate);
    const currentNetWorth = points.at(-1)?.netWorth ?? 0;
    const startNetWorth = points.at(0)?.netWorth ?? currentNetWorth;
    const change = currentNetWorth - startNetWorth;

    return {
      available: true,
      databasePath: localDatabasePath,
      generatedAt: new Date().toISOString(),
      currentNetWorth,
      startNetWorth,
      change,
      changePercent: startNetWorth === 0 ? null : change / Math.abs(startNetWorth),
      currencyCode: preferredCurrencyCode(accounts),
      points,
      accountCount: accounts.length,
      transactionCount: transactions.length,
      method: "balance-reconstruction"
    };
  } finally {
    db.close();
  }
}

export async function purgeLocalCache() {
  await deleteDatabaseFiles();
  const config = await loadConfig();
  const { localDatabaseKey, ...rest } = config;
  void localDatabaseKey;
  await saveConfig(rest);

  return {
    ok: true,
    databasePath: localDatabasePath,
    purged: true
  };
}

async function syncItem(
  db: LocalDatabase,
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  localDatabaseKey: string,
  options: LocalSyncOptions
) {
  const itemKey = keyForItem(item, localDatabaseKey);
  const startedAt = new Date().toISOString();
  upsertItem(db, itemKey, item, localDatabaseKey, startedAt);

  const accounts = await fetchAccountsForItem(config, item);
  for (const account of accounts) {
    upsertAccount(db, itemKey, account, localDatabaseKey, startedAt);
  }

  const transactions = item.products.includes("transactions")
    ? await syncTransactionsForItem(db, config, item, itemKey, localDatabaseKey, options)
    : {
        skipped: true,
        reason: "transactions product is not enabled for this Item"
      };
  const investmentResult = options.investments && item.products.includes("investments")
    ? await syncInvestmentsForItemWithRouteFallback(db, config, item, itemKey, localDatabaseKey, options)
    : undefined;

  return {
    itemId: item.itemId,
    institutionName: item.institutionName,
    institutionId: item.institutionId,
    accounts: accounts.length,
    transactions,
    investments: investmentResult
  };
}

async function syncTransactionsForItem(
  db: LocalDatabase,
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  itemKey: string,
  localDatabaseKey: string,
  options: LocalSyncOptions
) {
  const previous = readSyncState(db, itemKey, "transactions", localDatabaseKey);
  let cursor = previous.cursor;
  let hasMore = true;
  let pages = 0;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let transactionsUpdateStatus = previous.status;
  let requestId: string | undefined;

  while (hasMore && pages < options.maxPages) {
    const page = await fetchTransactionsSyncForItem(config, item, {
      cursor,
      count: options.count,
      daysRequested: cursor ? undefined : options.daysRequested
    });
    const syncedAt = new Date().toISOString();

    applyTransactionsSyncPage(db, itemKey, localDatabaseKey, page, syncedAt);
    cursor = page.nextCursor;
    hasMore = page.hasMore;
    pages += 1;
    added += page.added.length;
    modified += page.modified.length;
    removed += page.removed.length;
    transactionsUpdateStatus = page.transactionsUpdateStatus ?? transactionsUpdateStatus;
    requestId = page.requestId;

    writeSyncState(db, itemKey, "transactions", localDatabaseKey, {
      cursor,
      status: transactionsUpdateStatus,
      lastSyncedAt: syncedAt
    });
  }

  return {
    pages,
    added,
    modified,
    removed,
    hasMore,
    transactionsUpdateStatus,
    requestId,
    cursorStored: Boolean(cursor)
  };
}

async function syncInvestmentsForItem(
  db: LocalDatabase,
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  itemKey: string,
  localDatabaseKey: string,
  options: LocalSyncOptions
) {
  const syncedAt = new Date().toISOString();
  const holdings = await fetchInvestmentHoldingsForItem(config, item);

  replaceInvestmentHoldings(db, itemKey, localDatabaseKey, holdings, syncedAt);

  let offset = 0;
  let pages = 0;
  let investmentTransactions = 0;
  let totalInvestmentTransactions = 0;
  let lastRequestId: string | undefined;
  let hasMore = true;

  while (hasMore && pages < options.maxPages) {
    const page = await fetchInvestmentTransactionsForItem(config, item, {
      startDate: options.investmentStartDate,
      endDate: options.investmentEndDate,
      count: options.count,
      offset
    });
    applyInvestmentTransactionsPage(db, itemKey, localDatabaseKey, page, new Date().toISOString());

    investmentTransactions += page.investmentTransactions.length;
    totalInvestmentTransactions = page.totalInvestmentTransactions;
    lastRequestId = page.requestId;
    pages += 1;
    offset += page.investmentTransactions.length;
    hasMore = offset < totalInvestmentTransactions && page.investmentTransactions.length > 0;
  }

  writeSyncState(db, itemKey, "investments", localDatabaseKey, {
    status: "SYNCED",
    lastSyncedAt: new Date().toISOString()
  });

  return {
    holdings: holdings.holdings.length,
    securities: holdings.securities.length,
    investmentTransactions,
    totalInvestmentTransactions,
    pages,
    hasMore,
    requestId: lastRequestId
  };
}

async function syncInvestmentsForItemWithRouteFallback(
  db: LocalDatabase,
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  itemKey: string,
  localDatabaseKey: string,
  options: LocalSyncOptions
) {
  try {
    return await syncInvestmentsForItem(db, config, item, itemKey, localDatabaseKey, options);
  } catch (error) {
    if (isMissingHostedRouteError(error, "/api/investments-holdings") || isMissingHostedRouteError(error, "/api/investments-transactions")) {
      return {
        skipped: true,
        reason: "hosted backend does not have the Investments cache routes deployed yet"
      };
    }

    throw error;
  }
}

function applyTransactionsSyncPage(
  db: LocalDatabase,
  itemKey: string,
  localDatabaseKey: string,
  page: TransactionsSyncResult,
  syncedAt: string
) {
  const apply = db.transaction(() => {
    for (const account of page.accounts) {
      upsertAccount(db, itemKey, account, localDatabaseKey, syncedAt);
    }

    for (const transaction of [...page.added, ...page.modified]) {
      upsertTransaction(db, itemKey, transaction, localDatabaseKey, syncedAt);
    }

    for (const removed of page.removed) {
      removeTransaction(db, itemKey, removed, localDatabaseKey, syncedAt);
    }
  });

  apply();
}

function replaceInvestmentHoldings(
  db: LocalDatabase,
  itemKey: string,
  localDatabaseKey: string,
  result: InvestmentHoldingsResult,
  syncedAt: string
) {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM investment_holdings WHERE item_key = ?").run(itemKey);

    for (const account of result.accounts) {
      upsertAccount(db, itemKey, account, localDatabaseKey, syncedAt);
    }

    for (const security of result.securities) {
      upsertSecurity(db, itemKey, security, localDatabaseKey, syncedAt);
    }

    for (const holding of result.holdings) {
      upsertHolding(db, itemKey, holding, localDatabaseKey, syncedAt);
    }
  });

  replace();
}

function applyInvestmentTransactionsPage(
  db: LocalDatabase,
  itemKey: string,
  localDatabaseKey: string,
  page: InvestmentTransactionsResult,
  syncedAt: string
) {
  const apply = db.transaction(() => {
    for (const account of page.accounts) {
      upsertAccount(db, itemKey, account, localDatabaseKey, syncedAt);
    }

    for (const security of page.securities) {
      upsertSecurity(db, itemKey, security, localDatabaseKey, syncedAt);
    }

    for (const transaction of page.investmentTransactions) {
      upsertInvestmentTransaction(db, itemKey, transaction, localDatabaseKey, syncedAt);
    }
  });

  apply();
}

function upsertItem(
  db: LocalDatabase,
  itemKey: string,
  item: LinkedAccountItem,
  localDatabaseKey: string,
  updatedAt: string
) {
  const { accessToken, tokenEnvelope, ...publicItem } = item;
  void accessToken;
  void tokenEnvelope;
  db.prepare(`
    INSERT INTO items (item_key, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(item_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(itemKey, encryptLocalJson(publicItem, localDatabaseKey), updatedAt);
}

function upsertAccount(
  db: LocalDatabase,
  itemKey: string,
  account: JsonRecord,
  localDatabaseKey: string,
  updatedAt: string
) {
  const accountId = stringValue(account.account_id);
  if (!accountId) {
    return;
  }

  const accountKey = localBlindIndex("account", accountId, localDatabaseKey);
  db.prepare(`
    INSERT INTO accounts (account_key, item_key, payload, deleted_at, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(account_key) DO UPDATE SET
      item_key = excluded.item_key,
      payload = excluded.payload,
      deleted_at = NULL,
      updated_at = excluded.updated_at
  `).run(accountKey, itemKey, encryptLocalJson(account, localDatabaseKey), updatedAt);
}

function upsertTransaction(
  db: LocalDatabase,
  itemKey: string,
  transaction: JsonRecord,
  localDatabaseKey: string,
  updatedAt: string
) {
  const transactionId = stringValue(transaction.transaction_id);
  if (!transactionId) {
    return;
  }

  const accountId = stringValue(transaction.account_id);
  const transactionKey = localBlindIndex("transaction", transactionId, localDatabaseKey);
  const accountKey = accountId ? localBlindIndex("account", accountId, localDatabaseKey) : undefined;
  db.prepare(`
    INSERT INTO transactions (transaction_key, item_key, account_key, payload, deleted_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?)
    ON CONFLICT(transaction_key) DO UPDATE SET
      item_key = excluded.item_key,
      account_key = excluded.account_key,
      payload = excluded.payload,
      deleted_at = NULL,
      updated_at = excluded.updated_at
  `).run(transactionKey, itemKey, accountKey, encryptLocalJson(transaction, localDatabaseKey), updatedAt);
}

function removeTransaction(
  db: LocalDatabase,
  itemKey: string,
  removed: JsonRecord,
  localDatabaseKey: string,
  removedAt: string
) {
  const transactionId = stringValue(removed.transaction_id);
  if (!transactionId) {
    return;
  }

  const transactionKey = localBlindIndex("transaction", transactionId, localDatabaseKey);
  db.prepare("DELETE FROM transactions WHERE transaction_key = ?").run(transactionKey);
  db.prepare(`
    INSERT INTO removed_transactions (transaction_key, item_key, payload, removed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(transaction_key) DO UPDATE SET
      item_key = excluded.item_key,
      payload = excluded.payload,
      removed_at = excluded.removed_at
  `).run(transactionKey, itemKey, encryptLocalJson(removed, localDatabaseKey), removedAt);
}

function upsertSecurity(
  db: LocalDatabase,
  itemKey: string,
  security: JsonRecord,
  localDatabaseKey: string,
  updatedAt: string
) {
  const securityId = stringValue(security.security_id);
  if (!securityId) {
    return;
  }

  const securityKey = localBlindIndex("security", securityId, localDatabaseKey);
  db.prepare(`
    INSERT INTO securities (security_key, item_key, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(security_key) DO UPDATE SET
      item_key = excluded.item_key,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(securityKey, itemKey, encryptLocalJson(security, localDatabaseKey), updatedAt);
}

function upsertHolding(
  db: LocalDatabase,
  itemKey: string,
  holding: JsonRecord,
  localDatabaseKey: string,
  updatedAt: string
) {
  const accountId = stringValue(holding.account_id);
  const securityId = stringValue(holding.security_id);
  if (!accountId || !securityId) {
    return;
  }

  const holdingKey = localBlindIndex("holding", `${accountId}:${securityId}`, localDatabaseKey);
  db.prepare(`
    INSERT INTO investment_holdings (holding_key, item_key, account_key, security_key, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(holding_key) DO UPDATE SET
      item_key = excluded.item_key,
      account_key = excluded.account_key,
      security_key = excluded.security_key,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(
    holdingKey,
    itemKey,
    localBlindIndex("account", accountId, localDatabaseKey),
    localBlindIndex("security", securityId, localDatabaseKey),
    encryptLocalJson(holding, localDatabaseKey),
    updatedAt
  );
}

function upsertInvestmentTransaction(
  db: LocalDatabase,
  itemKey: string,
  transaction: JsonRecord,
  localDatabaseKey: string,
  updatedAt: string
) {
  const transactionId = stringValue(transaction.investment_transaction_id);
  if (!transactionId) {
    return;
  }

  const accountId = stringValue(transaction.account_id);
  const securityId = stringValue(transaction.security_id);
  db.prepare(`
    INSERT INTO investment_transactions (
      investment_transaction_key,
      item_key,
      account_key,
      security_key,
      payload,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(investment_transaction_key) DO UPDATE SET
      item_key = excluded.item_key,
      account_key = excluded.account_key,
      security_key = excluded.security_key,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(
    localBlindIndex("investment_transaction", transactionId, localDatabaseKey),
    itemKey,
    accountId ? localBlindIndex("account", accountId, localDatabaseKey) : undefined,
    securityId ? localBlindIndex("security", securityId, localDatabaseKey) : undefined,
    encryptLocalJson(transaction, localDatabaseKey),
    updatedAt
  );
}

function readSyncState(
  db: LocalDatabase,
  itemKey: string,
  kind: string,
  localDatabaseKey: string
): SyncState {
  const row = db.prepare(`
    SELECT cursor_payload, status, last_synced_at AS lastSyncedAt
    FROM sync_state
    WHERE item_key = ? AND kind = ?
  `).get(itemKey, kind) as { cursor_payload?: string | null; status?: string; lastSyncedAt?: string } | undefined;

  if (!row) {
    return {};
  }

  return {
    cursor: row.cursor_payload ? decryptLocalJson<string>(row.cursor_payload, localDatabaseKey) : undefined,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt
  };
}

function writeSyncState(
  db: LocalDatabase,
  itemKey: string,
  kind: string,
  localDatabaseKey: string,
  state: SyncState
) {
  db.prepare(`
    INSERT INTO sync_state (item_key, kind, cursor_payload, status, last_synced_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(item_key, kind) DO UPDATE SET
      cursor_payload = excluded.cursor_payload,
      status = excluded.status,
      last_synced_at = excluded.last_synced_at
  `).run(
    itemKey,
    kind,
    state.cursor ? encryptLocalJson(state.cursor, localDatabaseKey) : undefined,
    state.status,
    state.lastSyncedAt
  );
}

async function fetchAccountsForItem(config: PennyPincherConfig, item: LinkedAccountItem): Promise<JsonRecord[]> {
  if (item.mode === "hosted") {
    const accounts = await hostedRequest<unknown[]>(config, item, "accounts", {});
    return accounts.filter(isRecord);
  }

  const client = createPlaidClient(item.environment);
  const response = await client.accountsGet({ access_token: directAccessToken(item) });
  return (response.data.accounts as unknown[]).filter(isRecord);
}

async function fetchTransactionsSyncForItem(
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  payload: { cursor?: string; count: number; daysRequested?: number }
): Promise<TransactionsSyncResult> {
  if (item.mode === "hosted") {
    try {
      return normalizeTransactionsSyncResult(
        await hostedRequest<unknown>(config, item, "transactions-sync", payload)
      );
    } catch (error) {
      if (!isMissingHostedRouteError(error, "/api/transactions-sync")) {
        throw error;
      }

      const endDate = today();
      const startDate = daysBefore(endDate, payload.daysRequested ?? 730);
      return normalizeTransactionsGetFallbackResult(
        await hostedRequest<unknown>(config, item, "transactions", {
          startDate,
          endDate,
          count: payload.count
        })
      );
    }
  }

  const client = createPlaidClient(item.environment);
  const response = await client.transactionsSync({
    access_token: directAccessToken(item),
    cursor: payload.cursor,
    count: payload.count,
    options: payload.cursor || !payload.daysRequested
      ? undefined
      : {
          days_requested: payload.daysRequested
        }
  });

  return normalizeTransactionsSyncResult({
    accounts: response.data.accounts,
    added: response.data.added,
    modified: response.data.modified,
    removed: response.data.removed,
    nextCursor: response.data.next_cursor,
    hasMore: response.data.has_more,
    transactionsUpdateStatus: response.data.transactions_update_status,
    requestId: response.data.request_id
  });
}

async function fetchInvestmentHoldingsForItem(
  config: PennyPincherConfig,
  item: LinkedAccountItem
): Promise<InvestmentHoldingsResult> {
  if (item.mode === "hosted") {
    return normalizeInvestmentHoldingsResult(
      await hostedRequest<unknown>(config, item, "investments-holdings", {})
    );
  }

  const client = createPlaidClient(item.environment);
  const response = await client.investmentsHoldingsGet({
    access_token: directAccessToken(item)
  });

  return normalizeInvestmentHoldingsResult({
    accounts: response.data.accounts,
    holdings: response.data.holdings,
    securities: response.data.securities,
    item: response.data.item,
    requestId: response.data.request_id,
    isInvestmentsFallbackItem: response.data.is_investments_fallback_item
  });
}

async function fetchInvestmentTransactionsForItem(
  config: PennyPincherConfig,
  item: LinkedAccountItem,
  payload: { startDate: string; endDate: string; count: number; offset: number }
): Promise<InvestmentTransactionsResult> {
  if (item.mode === "hosted") {
    return normalizeInvestmentTransactionsResult(
      await hostedRequest<unknown>(config, item, "investments-transactions", payload)
    );
  }

  const client = createPlaidClient(item.environment);
  const response = await client.investmentsTransactionsGet({
    access_token: directAccessToken(item),
    start_date: payload.startDate,
    end_date: payload.endDate,
    options: {
      count: payload.count,
      offset: payload.offset
    }
  });

  return normalizeInvestmentTransactionsResult({
    item: response.data.item,
    accounts: response.data.accounts,
    securities: response.data.securities,
    investmentTransactions: response.data.investment_transactions,
    totalInvestmentTransactions: response.data.total_investment_transactions,
    requestId: response.data.request_id,
    isInvestmentsFallbackItem: response.data.is_investments_fallback_item
  });
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

async function ensureLocalDatabaseKey(config: PennyPincherConfig): Promise<PennyPincherConfig & { localDatabaseKey: string }> {
  if (config.localDatabaseKey) {
    return config as PennyPincherConfig & { localDatabaseKey: string };
  }

  const next = {
    ...config,
    localDatabaseKey: generateLocalDatabaseKey()
  };
  await saveConfig(next);
  return next;
}

async function openLocalDatabase(): Promise<LocalDatabase> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700).catch(() => undefined);

  const db = new Database(localDatabasePath);
  await chmod(localDatabasePath, 0o600).catch(() => undefined);
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: LocalDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      item_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_key TEXT PRIMARY KEY,
      item_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      transaction_key TEXT PRIMARY KEY,
      item_key TEXT NOT NULL,
      account_key TEXT,
      payload TEXT NOT NULL,
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS removed_transactions (
      transaction_key TEXT PRIMARY KEY,
      item_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      removed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      item_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      cursor_payload TEXT,
      status TEXT,
      last_synced_at TEXT,
      PRIMARY KEY (item_key, kind)
    );

    CREATE TABLE IF NOT EXISTS securities (
      security_key TEXT PRIMARY KEY,
      item_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investment_holdings (
      holding_key TEXT PRIMARY KEY,
      item_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      security_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investment_transactions (
      investment_transaction_key TEXT PRIMARY KEY,
      item_key TEXT NOT NULL,
      account_key TEXT,
      security_key TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_item_key ON accounts(item_key);
    CREATE INDEX IF NOT EXISTS idx_transactions_item_key ON transactions(item_key);
    CREATE INDEX IF NOT EXISTS idx_investment_holdings_item_key ON investment_holdings(item_key);
    CREATE INDEX IF NOT EXISTS idx_investment_transactions_item_key ON investment_transactions(item_key);
  `);

  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES ('schemaVersion', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
}

function readEncryptedRows(db: LocalDatabase, table: string, localDatabaseKey: string) {
  assertKnownTable(table);
  const rows = db.prepare(`
    SELECT item_key AS itemKey, payload
    FROM ${table}
    ${table === "transactions" || table === "accounts" ? "WHERE deleted_at IS NULL" : ""}
  `).all() as Array<{ itemKey: string; payload: string }>;

  return rows.map((row) => ({
    itemKey: row.itemKey,
    value: decryptLocalJson<JsonRecord>(row.payload, localDatabaseKey)
  }));
}

function readSummary(db: LocalDatabase) {
  return {
    schemaVersion: stringScalar(db, "SELECT value FROM metadata WHERE key = 'schemaVersion'") ?? "unknown",
    counts: {
      items: countRows(db, "items"),
      accounts: countRows(db, "accounts", "deleted_at IS NULL"),
      transactions: countRows(db, "transactions", "deleted_at IS NULL"),
      removedTransactions: countRows(db, "removed_transactions"),
      securities: countRows(db, "securities"),
      holdings: countRows(db, "investment_holdings"),
      investmentTransactions: countRows(db, "investment_transactions")
    },
    syncState: (db.prepare(`
      SELECT kind, status, last_synced_at AS lastSyncedAt
      FROM sync_state
      ORDER BY last_synced_at DESC
    `).all() as Array<{ kind: string; status?: string; lastSyncedAt?: string }>)
  };
}

function enrichWithItem(value: JsonRecord, itemKey: string, db: LocalDatabase, localDatabaseKey: string): JsonRecord {
  const row = db.prepare("SELECT payload FROM items WHERE item_key = ?").get(itemKey) as { payload: string } | undefined;
  if (!row) {
    return value;
  }

  const item = decryptLocalJson<JsonRecord>(row.payload, localDatabaseKey);
  return {
    itemId: item.itemId,
    institutionName: item.institutionName,
    institutionId: item.institutionId,
    ...value
  };
}

function filterByDate(records: JsonRecord[], options: LocalReadOptions): JsonRecord[] {
  return records.filter((record) => {
    const date = recordDate(record);
    if (!date) {
      return true;
    }

    if (options.startDate && date < options.startDate) {
      return false;
    }

    if (options.endDate && date > options.endDate) {
      return false;
    }

    return true;
  });
}

function buildNetWorthPoints(
  accounts: JsonRecord[],
  transactions: JsonRecord[],
  startDate: string,
  endDate: string
): NetWorthPoint[] {
  const currentNetWorth = accounts.reduce((total, account) => total + accountNetWorthContribution(account), 0);
  const transactionAmounts = new Map<string, number>();

  for (const transaction of transactions) {
    const date = recordDate(transaction);
    const amount = numberValue(transaction.amount);

    if (!date || amount === undefined || date < startDate || date > endDate) {
      continue;
    }

    transactionAmounts.set(date, (transactionAmounts.get(date) ?? 0) + amount);
  }

  const dates = dateRange(startDate, endDate);
  let futureTransactionTotal = 0;
  const descendingPoints: NetWorthPoint[] = [];

  for (const date of [...dates].reverse()) {
    descendingPoints.push({
      date,
      netWorth: roundCurrency(currentNetWorth + futureTransactionTotal)
    });
    futureTransactionTotal += transactionAmounts.get(date) ?? 0;
  }

  return descendingPoints.reverse();
}

function accountNetWorthContribution(account: JsonRecord): number {
  const balances = isRecord(account.balances) ? account.balances : {};
  const current = numberValue(balances.current);

  if (current === undefined) {
    return 0;
  }

  return liabilityAccount(account) ? -current : current;
}

function liabilityAccount(account: JsonRecord): boolean {
  const type = stringValue(account.type)?.toLowerCase();
  return type === "credit" || type === "loan";
}

function preferredCurrencyCode(accounts: JsonRecord[]): string {
  for (const account of accounts) {
    const balances = isRecord(account.balances) ? account.balances : {};
    const code = stringValue(balances.iso_currency_code);
    if (code) {
      return code;
    }
  }

  return "USD";
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = localDateFromIsoDate(startDate);
  const end = localDateFromIsoDate(endDate);

  while (cursor <= end) {
    dates.push(formatLocalIsoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function normalizeTransactionsSyncResult(result: unknown): TransactionsSyncResult {
  const value = result as {
    accounts?: unknown;
    added?: unknown;
    modified?: unknown;
    removed?: unknown;
    nextCursor?: unknown;
    next_cursor?: unknown;
    hasMore?: unknown;
    has_more?: unknown;
    transactionsUpdateStatus?: unknown;
    transactions_update_status?: unknown;
    requestId?: unknown;
    request_id?: unknown;
  };

  return {
    accounts: Array.isArray(value.accounts) ? value.accounts.filter(isRecord) : [],
    added: Array.isArray(value.added) ? value.added.filter(isRecord) : [],
    modified: Array.isArray(value.modified) ? value.modified.filter(isRecord) : [],
    removed: Array.isArray(value.removed) ? value.removed.filter(isRecord) : [],
    nextCursor: stringValue(value.nextCursor ?? value.next_cursor) ?? "",
    hasMore: Boolean(value.hasMore ?? value.has_more),
    transactionsUpdateStatus: stringValue(value.transactionsUpdateStatus ?? value.transactions_update_status),
    requestId: stringValue(value.requestId ?? value.request_id)
  };
}

function normalizeTransactionsGetFallbackResult(result: unknown): TransactionsSyncResult {
  const value = result as {
    accounts?: unknown;
    transactions?: unknown;
    totalTransactions?: unknown;
    total_transactions?: unknown;
    requestId?: unknown;
    request_id?: unknown;
  };

  return {
    accounts: Array.isArray(value.accounts) ? value.accounts.filter(isRecord) : [],
    added: Array.isArray(value.transactions) ? value.transactions.filter(isRecord) : [],
    modified: [],
    removed: [],
    nextCursor: "",
    hasMore: false,
    transactionsUpdateStatus: "FALLBACK_TRANSACTIONS_GET",
    requestId: stringValue(value.requestId ?? value.request_id)
  };
}

function normalizeInvestmentHoldingsResult(result: unknown): InvestmentHoldingsResult {
  const value = result as {
    accounts?: unknown;
    holdings?: unknown;
    securities?: unknown;
    item?: unknown;
    requestId?: unknown;
    request_id?: unknown;
    isInvestmentsFallbackItem?: unknown;
    is_investments_fallback_item?: unknown;
  };

  return {
    accounts: Array.isArray(value.accounts) ? value.accounts.filter(isRecord) : [],
    holdings: Array.isArray(value.holdings) ? value.holdings.filter(isRecord) : [],
    securities: Array.isArray(value.securities) ? value.securities.filter(isRecord) : [],
    item: isRecord(value.item) ? value.item : undefined,
    requestId: stringValue(value.requestId ?? value.request_id),
    isInvestmentsFallbackItem: Boolean(value.isInvestmentsFallbackItem ?? value.is_investments_fallback_item)
  };
}

function normalizeInvestmentTransactionsResult(result: unknown): InvestmentTransactionsResult {
  const value = result as {
    item?: unknown;
    accounts?: unknown;
    securities?: unknown;
    investmentTransactions?: unknown;
    investment_transactions?: unknown;
    totalInvestmentTransactions?: unknown;
    total_investment_transactions?: unknown;
    requestId?: unknown;
    request_id?: unknown;
    isInvestmentsFallbackItem?: unknown;
    is_investments_fallback_item?: unknown;
  };

  const total = value.totalInvestmentTransactions ?? value.total_investment_transactions;
  const investmentTransactions = value.investmentTransactions ?? value.investment_transactions;

  return {
    item: isRecord(value.item) ? value.item : undefined,
    accounts: Array.isArray(value.accounts) ? value.accounts.filter(isRecord) : [],
    securities: Array.isArray(value.securities) ? value.securities.filter(isRecord) : [],
    investmentTransactions: Array.isArray(investmentTransactions)
      ? investmentTransactions.filter(isRecord)
      : [],
    totalInvestmentTransactions: typeof total === "number" ? total : 0,
    requestId: stringValue(value.requestId ?? value.request_id),
    isInvestmentsFallbackItem: Boolean(value.isInvestmentsFallbackItem ?? value.is_investments_fallback_item)
  };
}

function keyForItem(item: LinkedAccountItem, localDatabaseKey: string): string {
  const stableId =
    item.itemId
    ?? item.tokenEnvelope
    ?? item.accessToken
    ?? `${item.mode}:${item.environment}:${item.institutionId ?? item.institutionName ?? item.linkedAt ?? "unknown"}`;
  return localBlindIndex("item", stableId, localDatabaseKey);
}

function directAccessToken(item: LinkedAccountItem): string {
  if (!item.accessToken) {
    throw new Error(`Direct Plaid config is incomplete for ${item.institutionName ?? item.itemId ?? "linked item"}.`);
  }

  return item.accessToken;
}

function recordDate(record: JsonRecord): string {
  const value = stringValue(record.date)
    ?? stringValue(record.authorized_date)
    ?? stringValue(record.datetime)
    ?? stringValue(record.authorized_datetime)
    ?? "";

  return value.slice(0, 10);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function today(): string {
  return formatLocalIsoDate(new Date());
}

function daysBefore(endDate: string, days: number): string {
  const date = localDateFromIsoDate(endDate);
  date.setDate(date.getDate() - days);
  return formatLocalIsoDate(date);
}

function localDateFromIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(year, month - 1, day);
}

function formatLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isMissingHostedRouteError(error: unknown, path: string): boolean {
  return error instanceof Error && error.message.includes(`HTTP 404 for ${path}`);
}

function countRows(db: LocalDatabase, table: string, where?: string): number {
  assertKnownTable(table);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`).get() as {
    count?: number;
  };
  return row.count ?? 0;
}

function stringScalar(db: LocalDatabase, sql: string): string | undefined {
  const row = db.prepare(sql).get() as { value?: unknown } | undefined;
  return stringValue(row?.value);
}

function assertKnownTable(table: string) {
  const known = new Set([
    "items",
    "accounts",
    "transactions",
    "removed_transactions",
    "sync_state",
    "securities",
    "investment_holdings",
    "investment_transactions"
  ]);
  if (!known.has(table)) {
    throw new Error(`Unknown local database table "${table}".`);
  }
}

async function localDatabaseExists(): Promise<boolean> {
  try {
    await access(localDatabasePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function deleteDatabaseFiles() {
  await Promise.all([
    unlink(localDatabasePath).catch(ignoreMissingFile),
    unlink(`${localDatabasePath}-journal`).catch(ignoreMissingFile),
    unlink(`${localDatabasePath}-wal`).catch(ignoreMissingFile),
    unlink(`${localDatabasePath}-shm`).catch(ignoreMissingFile)
  ]);
}

function ignoreMissingFile(error: unknown) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return;
  }

  throw error;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

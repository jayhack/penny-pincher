#!/usr/bin/env node
import { createRequire } from "node:module";
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command, Option } from "commander";
import open from "open";
import { runAuthFlow, type AuthReadyEvent } from "./auth.js";
import {
  clearLinkedAccount,
  configPath,
  getLinkedItems,
  loadConfig,
  normalizePlaidEnvironment,
  plaidEnvironments,
  type PennyPincherConfig
} from "./config.js";
import {
  createBillingPortal,
  getAccountNumbers,
  getAccounts,
  getBalances,
  getIdentity,
  getRecurring,
  getStatus,
  getTransactions,
  getUsage
} from "./data.js";
import {
  getLocalCacheStatus,
  purgeLocalCache,
  readLocalCache,
  syncLocalCache
} from "./local-store.js";
import { startDashboard } from "./dashboard.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const cliVersion = packageJson.version;
const program = new Command();

class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly nextCommand?: string
  ) {
    super(message);
  }
}

program
  .name("penny-pincher")
  .description("Agent-friendly CLI for reading bank data through Plaid.")
  .version(cliVersion)
  .addHelpText("after", `
Local SQLite cache:
  penny-pincher sync       Hydrates ~/.penny-pincher/penny.db from Plaid/backend.
  penny-pincher cache ...  Reads the encrypted local cache without calling Plaid.
  penny-pincher dashboard  Reads the cache for the net worth chart; it does not sync automatically.

If the SQLite DB is deleted, run penny-pincher sync to rebuild it. The cache key lives in ~/.penny-pincher/config.json.
`);

program.configureOutput({
  writeErr: (value) => {
    if (!hasJsonFlag(process.argv)) {
      process.stderr.write(value);
    }
  }
});

program
  .command("auth")
  .description("Connect a bank account with Plaid Link and save local token metadata.")
  .addOption(environmentOption())
  .option("-p, --products <products>", "Comma-separated Plaid products to request.", "transactions")
  .option("-c, --country-codes <codes>", "Comma-separated country codes.", "US")
  .option("--history-days <days>", "Transaction history to request during Plaid Link, up to 730 days.", parseInteger, 730)
  .option("--port <port>", "Local auth server port.", parsePort, 7777)
  .option(
    "--backend <url>",
    "Penny Pincher backend URL.",
    process.env.PENNY_PINCHER_API_URL ?? process.env.PENNY_PINCER_API_URL ?? process.env.FINCLAW_API_URL
  )
  .option("--direct-plaid", "Use local Plaid credentials instead of the hosted Penny Pincher backend.")
  .addOption(new Option("--open", "Open browser URLs automatically. By default URLs are printed for agent handoff.").default(false))
  .addOption(new Option("--no-open", "Deprecated; URLs are printed by default.").hideHelp())
  .addOption(jsonOption())
  .action(async (options) => {
    const emitEvent = createAuthEventEmitter(Boolean(options.json));
    const environment = resolveEnvironment(options.env);
    const config = await runAuthFlow({
      environment,
      products: splitList(options.products),
      countryCodes: splitList(options.countryCodes),
      transactionsDaysRequested: boundedInteger(options.historyDays, "history-days", 1, 730),
      port: options.port,
      openBrowser: Boolean(options.open),
      directPlaid: Boolean(options.directPlaid),
      backendUrl: options.backend,
      onReady: emitEvent
    });

    if (options.json) {
      printJsonLine({
        ok: true,
        type: "linked",
        linked: true,
        mode: config.mode,
        environment: config.environment,
        institutionName: config.institutionName,
        configPath
      });
      return;
    }

    console.error(chalk.green(`Linked ${config.institutionName ?? "bank account"} in ${config.environment}.`));
    console.error(chalk.dim(`Saved token metadata to ${configPath}`));
  });

program
  .command("accounts")
  .description("Print linked accounts.")
  .addOption(jsonOption())
  .action(async () => printJson(await getAccounts()));

program
  .command("dashboard")
  .description("Open a local dashboard; net worth reads from the encrypted SQLite cache.")
  .option("--port <port>", "Local dashboard server port.", parsePort, 7778)
  .option("--no-open", "Print the dashboard URL without opening a browser.")
  .addOption(jsonOption())
  .action(async (options) => {
    const dashboard = await startDashboard({
      port: options.port,
      openBrowser: Boolean(options.open)
    });

    if (options.json) {
      printJsonLine({
        ok: true,
        type: "dashboard_url",
        url: dashboard.url,
        opened: dashboard.opened,
        openError: dashboard.openError,
        configPath
      });
      return;
    }

    console.error(chalk.cyan(`Dashboard: ${dashboard.url}`));
    if (dashboard.openError) {
      console.error(chalk.yellow(`Could not open browser automatically: ${dashboard.openError}`));
    }
    console.error(chalk.dim("Press Ctrl-C to stop the local dashboard server."));
  });

program
  .command("balances")
  .description("Print accounts with current balances.")
  .addOption(jsonOption())
  .action(async () => printJson(await getBalances()));

program
  .command("transactions")
  .description("Print recent transactions.")
  .option("--start <yyyy-mm-dd>", "Start date.")
  .option("--end <yyyy-mm-dd>", "End date.", today())
  .option("--days <days>", "Number of days back when --start is omitted.", parseInteger, 30)
  .option("--count <count>", "Maximum transactions to return.", parseInteger, 100)
  .addOption(jsonOption())
  .action(async (options) => {
    const endDate = options.end;
    const startDate = options.start ?? daysBefore(endDate, options.days);
    printJson(await getTransactions({ startDate, endDate, count: options.count }));
  });

program
  .command("recurring")
  .description("Print Plaid recurring transaction streams.")
  .option("--account-ids <ids>", "Comma-separated Plaid account IDs to include.")
  .addOption(jsonOption())
  .action(async (options) => {
    printJson(await getRecurring({
      accountIds: options.accountIds ? splitList(options.accountIds) : undefined
    }));
  });

program
  .command("sync")
  .description("Hydrate or update the encrypted local SQLite cache from Plaid/backend.")
  .option("--count <count>", "Plaid page size for transaction sync.", parseInteger, 500)
  .option("--max-pages <pages>", "Maximum pages to pull per linked item.", parseInteger, 100)
  .option("--days-requested <days>", "Transaction history to request when sync initializes Transactions.", parseInteger, 730)
  .option("--investment-start <yyyy-mm-dd>", "Investment transactions start date.")
  .option("--investment-end <yyyy-mm-dd>", "Investment transactions end date.", today())
  .option("--investment-days <days>", "Investment transaction days back when --investment-start is omitted.", parseInteger, 730)
  .addOption(new Option("--investments", "Cache investment holdings and investment transactions for Items with investments enabled.").default(true))
  .addOption(new Option("--no-investments", "Skip investment holdings and investment transactions."))
  .option("--reset", "Delete the local cache file before syncing.")
  .addOption(jsonOption())
  .action(async (options) => {
    const investmentEndDate = options.investmentEnd;
    const investmentStartDate = options.investmentStart ?? daysBefore(investmentEndDate, options.investmentDays);
    printJson(await syncLocalCache({
      count: boundedInteger(options.count, "count", 1, 500),
      maxPages: boundedInteger(options.maxPages, "max-pages", 1, 1000),
      daysRequested: boundedInteger(options.daysRequested, "days-requested", 1, 730),
      reset: Boolean(options.reset),
      investments: Boolean(options.investments),
      investmentStartDate,
      investmentEndDate
    }));
  });

program
  .command("cache")
  .description("Read the encrypted local SQLite cache without calling Plaid.")
  .argument("[kind]", "summary, accounts, transactions, holdings, or investment-transactions.", "summary")
  .option("--start <yyyy-mm-dd>", "Start date for transaction-like cache reads.")
  .option("--end <yyyy-mm-dd>", "End date for transaction-like cache reads.", today())
  .option("--days <days>", "Number of days back when --start is omitted.", parseInteger, 30)
  .option("--count <count>", "Maximum rows to return for transaction-like cache reads.", parseInteger, 100)
  .addOption(jsonOption())
  .action(async (kind, options) => {
    const normalizedKind = normalizeCacheKind(kind);
    const endDate = options.end;
    const startDate = options.start ?? (
      normalizedKind === "transactions" || normalizedKind === "investment-transactions"
        ? daysBefore(endDate, options.days)
        : undefined
    );
    printJson(await readLocalCache(normalizedKind, {
      startDate,
      endDate,
      count: boundedInteger(options.count, "count", 1, 10000)
    }));
  });

program
  .command("identity")
  .description("Print owner identity data for linked accounts.")
  .addOption(jsonOption())
  .action(async () => printJson(await getIdentity()));

program
  .command("numbers")
  .description("Print ACH account/routing numbers. Requires the Plaid auth product.")
  .addOption(jsonOption())
  .action(async () => printJson(await getAccountNumbers()));

program
  .command("status")
  .description("Print local Penny Pincher connection status.")
  .addOption(jsonOption())
  .action(async () => printJson(await getReadinessReport()));

program
  .command("doctor")
  .description("Print machine-readable setup diagnostics and the next command to run.")
  .addOption(jsonOption())
  .action(async () => printJson(await getReadinessReport()));

program
  .command("usage")
  .description("Print current billing-period usage and estimated costs.")
  .addOption(jsonOption())
  .action(async () => printJson(await getUsage()));

program
  .command("billing")
  .description("Create a Stripe Customer Portal URL for payment and subscription management.")
  .addOption(new Option("--open", "Open the billing portal automatically. By default the URL is printed for agent handoff.").default(false))
  .addOption(new Option("--no-open", "Deprecated; URLs are printed by default.").hideHelp())
  .addOption(jsonOption())
  .action(async (options) => {
    const portal = await createBillingPortal("https://penny-pincher-cli.vercel.app/");
    if (options.json) {
      printJsonLine({
        ok: true,
        type: "billing_portal_url",
        url: portal.url,
        requiresHuman: true,
        opened: Boolean(options.open)
      });
    } else {
      console.error(chalk.cyan(`Billing portal URL: ${portal.url}`));
    }

    if (options.open) {
      await open(portal.url);
      if (!options.json) {
        console.error(chalk.green("Opened Stripe billing portal."));
      }
    }
  });

program
  .command("logout")
  .description("Remove the locally saved Plaid access token.")
  .option("--purge-data", "Also delete the encrypted local SQLite cache and remove its key from config.json.")
  .addOption(jsonOption())
  .action(async (options) => {
    await clearLinkedAccount();
    const purged = options.purgeData ? await purgeLocalCache() : undefined;
    if (options.json) {
      printJson({ ok: true, linked: false, configPath, purged });
      return;
    }

    console.error(chalk.green("Removed local Plaid token."));
    if (purged) {
      console.error(chalk.green("Deleted local cache data."));
    }
  });

program
  .command("interactive")
  .alias("menu")
  .description("Open the human-oriented interactive command menu.")
  .action(async () => promptForCommand());

program.exitOverride();

main().catch((error) => {
  if (error?.code === "commander.helpDisplayed" || error?.code === "commander.version") {
    return;
  }

  printCliError(error, hasJsonFlag(process.argv));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.every((arg) => arg === "--json")) {
    printJson(await getReadinessReport());
    return;
  }

  await program.parseAsync(process.argv);
}

async function promptForCommand(): Promise<void> {
  const config = await loadConfig();
  const choices = buildInteractiveChoices(config);
  const action = await select({
    message: "What do you want Penny Pincher to do?",
    choices
  });

  await program.parseAsync(["node", "penny-pincher", ...action]);
}

function buildInteractiveChoices(config: PennyPincherConfig): Array<{ name: string; value: string[] }> {
  const choices: Array<{ name: string; value: string[] }> = [
    { name: "Show connection status", value: ["status"] }
  ];

  if (isLinked(config)) {
    choices.push(
      { name: "Show accounts", value: ["accounts"] },
      { name: "Open dashboard", value: ["dashboard"] },
      { name: "Show balances", value: ["balances"] },
      { name: "Show recent transactions", value: ["transactions"] },
      { name: "Show recurring charges", value: ["recurring"] },
      { name: "Sync local cache", value: ["sync"] },
      { name: "Show local cache summary", value: ["cache"] }
    );
  }

  choices.push({
    name: isLinked(config) ? "Reconnect bank account" : "Connect bank account",
    value: ["auth", "--open"]
  });

  return choices;
}

async function getReadinessReport() {
  const status = await getStatus();
  const cache = await getLocalCacheStatus();
  const linked = status.linked;
  const availableCommands = [
    "penny-pincher status --json",
    linked ? "penny-pincher accounts" : undefined,
    linked ? "penny-pincher dashboard" : undefined,
    linked ? "penny-pincher balances" : undefined,
    linked ? "penny-pincher transactions --days 30" : undefined,
    linked ? "penny-pincher recurring" : undefined,
    linked ? "penny-pincher sync" : undefined,
    cache.exists ? "penny-pincher cache transactions --days 30" : undefined,
    linked ? "penny-pincher identity" : undefined,
    linked ? "penny-pincher numbers" : undefined,
    "penny-pincher auth",
    "penny-pincher interactive"
  ].filter((command): command is string => Boolean(command));

  return {
    cli: "penny-pincher",
    version: cliVersion,
    ...status,
    cache,
    configPath,
    requiresHuman: !linked,
    nextCommand: linked ? "penny-pincher transactions --days 30" : "penny-pincher auth",
    reason: linked
      ? "Ready to query linked bank data."
      : "Plaid Link authorization has not been completed.",
    availableCommands
  };
}

function createAuthEventEmitter(json: boolean): (event: AuthReadyEvent) => void {
  return (event) => {
    if (json) {
      printJsonLine({
        ok: true,
        ...event
      });
      return;
    }

    const label = event.type === "billing_url" ? "Billing URL" : "Plaid Link URL";
    console.error(chalk.cyan(`${label}: ${event.url}`));
  };
}

function isLinked(config: PennyPincherConfig): boolean {
  return getLinkedItems(config).length > 0;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveEnvironment(value: string | undefined) {
  return normalizePlaidEnvironment(value ?? process.env.PLAID_ENV);
}

function environmentOption(): Option {
  return new Option("--env <env>", `Plaid environment (${[...plaidEnvironments, "prod"].join(", ")}).`)
    .default(process.env.PLAID_ENV ?? "production");
}

function jsonOption(): Option {
  return new Option("--json", "Accept and emit machine-readable JSON where the command has non-data output.");
}

function parsePort(value: string): number {
  const port = parseInteger(value);

  if (port < 1 || port > 65535) {
    throw new CliError("invalid_port", "Port must be between 1 and 65535.");
  }

  return port;
}

function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliError("invalid_integer", `Invalid integer: ${value}`);
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    throw new CliError("invalid_integer", `Invalid integer: ${value}`);
  }

  return parsed;
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CliError("invalid_integer", `${label} must be between ${min} and ${max}.`);
  }

  return value;
}

function normalizeCacheKind(value: string): string {
  const kind = value.trim().toLowerCase();
  const allowed = new Set(["summary", "accounts", "transactions", "holdings", "investment-transactions"]);

  if (!allowed.has(kind)) {
    throw new CliError(
      "invalid_cache_kind",
      `Invalid cache kind: ${value}. Use summary, accounts, transactions, holdings, or investment-transactions.`
    );
  }

  return kind;
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

function hasJsonFlag(argv: string[]): boolean {
  return argv.includes("--json");
}

function printCliError(error: unknown, json: boolean): void {
  const normalized = normalizeCliError(error);

  if (json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: normalized })}\n`);
    return;
  }

  console.error(chalk.red(normalized.message));
  if (normalized.nextCommand) {
    console.error(chalk.dim(`Next: ${normalized.nextCommand}`));
  }
}

function normalizeCliError(error: unknown): { code: string; message: string; nextCommand?: string } {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      nextCommand: error.nextCommand
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("No linked Plaid item found")) {
    return {
      code: "not_linked",
      message,
      nextCommand: "penny-pincher auth"
    };
  }

  if (message.includes("billing config is incomplete") || message.includes("Active Stripe billing is required")) {
    return {
      code: "billing_required",
      message,
      nextCommand: "penny-pincher auth"
    };
  }

  if (message.includes("Timed out waiting for Stripe Checkout") || message.includes("Timed out waiting for Plaid Link")) {
    return {
      code: "human_action_timeout",
      message,
      nextCommand: "penny-pincher auth"
    };
  }

  if (message.includes("Stripe Checkout was canceled")) {
    return {
      code: "billing_canceled",
      message,
      nextCommand: "penny-pincher auth"
    };
  }

  if (message.includes("Invalid Plaid environment")) {
    return {
      code: "invalid_environment",
      message
    };
  }

  if (message.includes("Allowed choices are")) {
    return {
      code: "invalid_option",
      message
    };
  }

  return {
    code: "command_failed",
    message
  };
}

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
  getHoldings,
  getIdentity,
  getStatus,
  getTransactions,
  getUsage
} from "./data.js";

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
  .description("Agent-friendly CLI for reading bank and investment data through Plaid.")
  .version(cliVersion);

program.configureOutput({
  writeErr: (value) => {
    if (!hasJsonFlag(process.argv)) {
      process.stderr.write(value);
    }
  }
});

program
  .command("auth")
  .description("Connect a bank or investment account with Plaid Link and save local token metadata.")
  .addOption(environmentOption())
  .option("-p, --products <products>", "Comma-separated Plaid products to request.", "transactions")
  .option("--investments", "Request only the Plaid investments product unless --products is also set.")
  .option("-c, --country-codes <codes>", "Comma-separated country codes.", "US")
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
  .action(async (options, command) => {
    const emitEvent = createAuthEventEmitter(Boolean(options.json));
    const environment = resolveEnvironment(options.env);
    const config = await runAuthFlow({
      environment,
      products: resolveAuthProducts(
        options.products,
        Boolean(options.investments),
        command.getOptionValueSource("products") === "cli"
      ),
      countryCodes: splitList(options.countryCodes),
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

    console.error(chalk.green(`Linked ${config.institutionName ?? "account"} in ${config.environment}.`));
    console.error(chalk.dim(`Saved token metadata to ${configPath}`));
  });

program
  .command("accounts")
  .description("Print linked accounts.")
  .addOption(jsonOption())
  .action(async () => printJson(await getAccounts()));

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
  .command("holdings")
  .alias("investments")
  .description("Print investment holdings and securities. Requires the Plaid investments product.")
  .addOption(jsonOption())
  .action(async () => printJson(await getHoldings()));

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
  .addOption(jsonOption())
  .action(async (options) => {
    await clearLinkedAccount();
    if (options.json) {
      printJson({ ok: true, linked: false, configPath });
      return;
    }

    console.error(chalk.green("Removed local Plaid token."));
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
      { name: "Show balances", value: ["balances"] },
      { name: "Show recent transactions", value: ["transactions"] },
      { name: "Show investment holdings", value: ["holdings"] }
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
  const linked = status.linked;
  const availableCommands = [
    "penny-pincher status --json",
    linked ? "penny-pincher accounts" : undefined,
    linked ? "penny-pincher balances" : undefined,
    linked ? "penny-pincher transactions --days 30" : undefined,
    linked ? "penny-pincher identity" : undefined,
    linked ? "penny-pincher numbers" : undefined,
    linked ? "penny-pincher holdings" : undefined,
    "penny-pincher auth",
    "penny-pincher auth --investments",
    "penny-pincher interactive"
  ].filter((command): command is string => Boolean(command));

  return {
    cli: "penny-pincher",
    version: cliVersion,
    ...status,
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

function resolveAuthProducts(value: string, investments: boolean, productsFromCli: boolean): string[] {
  if (investments && !productsFromCli) {
    return ["investments"];
  }

  const products = splitList(value);
  if (!investments || products.includes("investments")) {
    return products;
  }

  return [...products, "investments"];
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(endDate: string, days: number): string {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
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

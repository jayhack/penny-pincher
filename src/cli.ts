#!/usr/bin/env node
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command, Option } from "commander";
import { runAuthFlow } from "./auth.js";
import { clearLinkedAccount, configPath, loadConfig, plaidEnvironments, type PlaidEnvironment } from "./config.js";
import { getAccountNumbers, getAccounts, getBalances, getIdentity, getStatus, getTransactions } from "./data.js";

const program = new Command();

program
  .name("finclaw")
  .description("Agent-friendly CLI for reading your bank data through Plaid.")
  .version("0.1.0");

program
  .command("auth")
  .description("Connect a bank account with Plaid Link and save a local access token.")
  .addOption(environmentOption())
  .option("-p, --products <products>", "Comma-separated Plaid products to request.", "transactions")
  .option("-c, --country-codes <codes>", "Comma-separated country codes.", "US")
  .option("--port <port>", "Local auth server port.", parsePort, 7777)
  .option("--no-open", "Print the auth URL instead of opening a browser.")
  .action(async (options) => {
    const environment = resolveEnvironment(options.environment);
    const config = await runAuthFlow({
      environment,
      products: splitList(options.products),
      countryCodes: splitList(options.countryCodes),
      port: options.port,
      openBrowser: options.open,
      onReady: (url) => {
        if (!options.open) {
          console.error(chalk.cyan(`Open ${url} to connect your bank account.`));
        }
      }
    });

    console.error(chalk.green(`Linked ${config.institutionName ?? "bank account"} in ${config.environment}.`));
    console.error(chalk.dim(`Saved token metadata to ${configPath}`));
  });

program
  .command("accounts")
  .description("Print linked accounts.")
  .action(async () => printJson(await getAccounts()));

program
  .command("balances")
  .description("Print accounts with current balances.")
  .action(async () => printJson(await getBalances()));

program
  .command("transactions")
  .description("Print recent transactions.")
  .option("--start <yyyy-mm-dd>", "Start date.")
  .option("--end <yyyy-mm-dd>", "End date.", today())
  .option("--days <days>", "Number of days back when --start is omitted.", parseInteger, 30)
  .option("--count <count>", "Maximum transactions to return.", parseInteger, 100)
  .action(async (options) => {
    const endDate = options.end;
    const startDate = options.start ?? daysBefore(endDate, options.days);
    printJson(await getTransactions({ startDate, endDate, count: options.count }));
  });

program
  .command("identity")
  .description("Print owner identity data for linked accounts.")
  .action(async () => printJson(await getIdentity()));

program
  .command("numbers")
  .description("Print ACH account/routing numbers. Requires the Plaid auth product.")
  .action(async () => printJson(await getAccountNumbers()));

program
  .command("status")
  .description("Print local Finclaw connection status.")
  .action(async () => printJson(await getStatus()));

program
  .command("logout")
  .description("Remove the locally saved Plaid access token.")
  .action(async () => {
    await clearLinkedAccount();
    console.error(chalk.green("Removed local Plaid token."));
  });

program.exitOverride();

main().catch((error) => {
  if (error?.code === "commander.helpDisplayed") {
    return;
  }

  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    await promptForCommand();
    return;
  }

  await program.parseAsync(process.argv);
}

async function promptForCommand(): Promise<void> {
  const config = await loadConfig();
  const action = await select({
    message: "What do you want Finclaw to do?",
    choices: [
      { name: config.accessToken ? "Reconnect bank account" : "Connect bank account", value: "auth" },
      { name: "Show accounts", value: "accounts", disabled: !config.accessToken && "Run auth first" },
      { name: "Show balances", value: "balances", disabled: !config.accessToken && "Run auth first" },
      { name: "Show recent transactions", value: "transactions", disabled: !config.accessToken && "Run auth first" },
      { name: "Show connection status", value: "status" }
    ]
  });

  await program.parseAsync(["node", "finclaw", action]);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveEnvironment(value: string | undefined): PlaidEnvironment {
  const environment = value ?? process.env.PLAID_ENV ?? "sandbox";

  if (!plaidEnvironments.includes(environment as PlaidEnvironment)) {
    throw new Error(`Invalid Plaid environment "${environment}". Use sandbox, development, or production.`);
  }

  return environment as PlaidEnvironment;
}

function environmentOption(): Option {
  return new Option("--env <env>", "Plaid environment.")
    .choices([...plaidEnvironments])
    .default(process.env.PLAID_ENV ?? "sandbox");
}

function parsePort(value: string): number {
  const port = parseInteger(value);

  if (port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535.");
  }

  return port;
}

function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid integer: ${value}`);
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
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

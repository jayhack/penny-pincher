import "dotenv/config";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import type { PlaidEnvironment } from "./config.js";

const plaidHosts: Record<PlaidEnvironment, string> = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production
};

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
}

export function getPlaidCredentials(environment: PlaidEnvironment): PlaidCredentials {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;

  if (!clientId || !secret) {
    throw new Error(
      "Missing Plaid credentials. Set PLAID_CLIENT_ID and PLAID_SECRET in your environment or a local .env file."
    );
  }

  return { clientId, secret, environment };
}

export function createPlaidClient(environment: PlaidEnvironment): PlaidApi {
  const credentials = getPlaidCredentials(environment);
  const configuration = new Configuration({
    basePath: plaidHosts[credentials.environment],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": credentials.clientId,
        "PLAID-SECRET": credentials.secret
      }
    }
  });

  return new PlaidApi(configuration);
}

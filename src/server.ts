import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { z } from "zod";
import {
  decryptTokenEnvelope,
  encryptTokenEnvelope,
  verifySignedRequest,
  type SignedRequest,
  type TokenEnvelopePayload
} from "./crypto.js";
import { normalizePlaidEnvironment, type PlaidEnvironment } from "./config.js";

const signedRequestSchema = z.object({
  payload: z.unknown(),
  timestamp: z.string(),
  nonce: z.string(),
  signature: z.string()
});

const dataRequestSchema = signedRequestSchema.extend({
  tokenEnvelope: z.string()
});

const linkTokenSchema = z.object({
  publicKeyPem: z.string().min(1),
  environment: z.string().optional(),
  products: z.array(z.string()).default(["transactions"]),
  countryCodes: z.array(z.string()).default(["US"]),
  redirectUri: z.string().url().optional(),
  linkCustomizationName: z.string().min(1).optional()
});

const updateLinkTokenPayloadSchema = z.object({
  publicKeyPem: z.string().min(1),
  additionalConsentedProducts: z.array(z.string()).min(1),
  countryCodes: z.array(z.string()).default(["US"]),
  redirectUri: z.string().url().optional(),
  linkCustomizationName: z.string().min(1).optional()
});

const exchangePayloadSchema = z.object({
  publicToken: z.string().min(1),
  publicKeyPem: z.string().min(1),
  environment: z.string().optional(),
  products: z.array(z.string()).default(["transactions"]),
  countryCodes: z.array(z.string()).default(["US"]),
  metadata: z.unknown().optional()
});

const transactionsPayloadSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  count: z.number().int().positive().max(500).default(100)
});
const recurringPayloadSchema = z.object({
  accountIds: z.array(z.string()).optional()
});

const plaidHosts: Record<PlaidEnvironment, string> = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production
};

export type DataKind = "accounts" | "balances" | "transactions" | "recurring" | "identity" | "numbers" | "holdings" | "item";

export async function linkTokenHandler(request: VercelRequest, response: VercelResponse): Promise<void> {
  await withJsonPost(request, response, async () => {
    const body = linkTokenSchema.parse(request.body);
    const environment = getPlaidEnvironment(body.environment);
    const client = createServerPlaidClient(environment);
    const link = await client.linkTokenCreate({
      user: {
        client_user_id: `penny-pincher-${hashShort(body.publicKeyPem)}`
      },
      client_name: "Penny Pincher",
      products: body.products as never,
      country_codes: body.countryCodes as never,
      language: "en",
      redirect_uri: body.redirectUri ?? process.env.PLAID_REDIRECT_URI,
      link_customization_name: body.linkCustomizationName ?? process.env.PLAID_LINK_CUSTOMIZATION_NAME
    });

    response.status(200).json({
      linkToken: link.data.link_token,
      environment
    });
  });
}

export async function updateLinkTokenHandler(request: VercelRequest, response: VercelResponse): Promise<void> {
  await withJsonPost(request, response, async () => {
    const body = dataRequestSchema.parse(request.body);
    const envelope = decryptTokenEnvelope(body.tokenEnvelope, getEnvelopeSecret());
    const signed = {
      payload: body.payload,
      timestamp: body.timestamp,
      nonce: body.nonce,
      signature: body.signature
    };
    const payload = updateLinkTokenPayloadSchema.parse(signed.payload);

    verifySignedRequest({
      method: "POST",
      path: "/api/update-link-token",
      request: signed,
      publicKeyPem: envelope.publicKeyPem
    });

    if (payload.publicKeyPem !== envelope.publicKeyPem) {
      throw new ApiError(403, "Signed key does not match the linked Item.");
    }

    const client = createServerPlaidClient(envelope.environment);
    const link = await client.linkTokenCreate({
      user: {
        client_user_id: `penny-pincher-${hashShort(envelope.publicKeyPem)}`
      },
      client_name: "Penny Pincher",
      country_codes: payload.countryCodes as never,
      language: "en",
      access_token: envelope.accessToken,
      additional_consented_products: payload.additionalConsentedProducts as never,
      redirect_uri: payload.redirectUri ?? process.env.PLAID_REDIRECT_URI,
      link_customization_name: payload.linkCustomizationName ?? process.env.PLAID_LINK_CUSTOMIZATION_NAME
    });

    response.status(200).json({
      linkToken: link.data.link_token,
      environment: envelope.environment
    });
  });
}

export async function exchangeHandler(request: VercelRequest, response: VercelResponse): Promise<void> {
  await withJsonPost(request, response, async () => {
    const signed = signedRequestSchema.parse(request.body) as SignedRequest<unknown>;
    const payload = exchangePayloadSchema.parse(signed.payload);

    verifySignedRequest({
      method: "POST",
      path: "/api/exchange",
      request: signed as SignedRequest<typeof payload>,
      publicKeyPem: payload.publicKeyPem
    });

    const environment = getPlaidEnvironment(payload.environment);
    const client = createServerPlaidClient(environment);
    const exchange = await client.itemPublicTokenExchange({
      public_token: payload.publicToken
    });
    const institution = readInstitution(payload.metadata);
    const envelopePayload: TokenEnvelopePayload = {
      accessToken: exchange.data.access_token,
      itemId: exchange.data.item_id,
      environment,
      products: payload.products,
      countryCodes: payload.countryCodes,
      publicKeyPem: payload.publicKeyPem,
      institutionName: institution.name,
      institutionId: institution.id,
      issuedAt: new Date().toISOString(),
      keyVersion:
        process.env.PENNY_PINCHER_TOKEN_KEY_VERSION
        ?? process.env.PENNY_PINCER_TOKEN_KEY_VERSION
        ?? process.env.FINCLAW_TOKEN_KEY_VERSION
        ?? "v1"
    };

    response.status(200).json({
      tokenEnvelope: encryptTokenEnvelope(envelopePayload, getEnvelopeSecret()),
      itemId: envelopePayload.itemId,
      environment: envelopePayload.environment,
      institutionName: envelopePayload.institutionName,
      institutionId: envelopePayload.institutionId,
      products: envelopePayload.products,
      countryCodes: envelopePayload.countryCodes
    });
  });
}

export async function dataHandler(
  request: VercelRequest,
  response: VercelResponse,
  kind: DataKind
): Promise<void> {
  await withJsonPost(request, response, async () => {
    const body = dataRequestSchema.parse(request.body);
    const envelope = decryptTokenEnvelope(body.tokenEnvelope, getEnvelopeSecret());
    const signed = {
      payload: body.payload,
      timestamp: body.timestamp,
      nonce: body.nonce,
      signature: body.signature
    };

    verifySignedRequest({
      method: "POST",
      path: `/api/${kind}`,
      request: signed,
      publicKeyPem: envelope.publicKeyPem
    });

    const client = createServerPlaidClient(envelope.environment);
    const result = await callPlaidDataEndpoint(client, envelope.accessToken, kind, body.payload);
    response.status(200).json(result);
  });
}

async function callPlaidDataEndpoint(
  client: PlaidApi,
  accessToken: string,
  kind: DataKind,
  payload: unknown
): Promise<unknown> {
  if (kind === "accounts") {
    const response = await client.accountsGet({ access_token: accessToken });
    return response.data.accounts;
  }

  if (kind === "balances") {
    const response = await client.accountsBalanceGet({ access_token: accessToken });
    return response.data.accounts;
  }

  if (kind === "transactions") {
    const options = transactionsPayloadSchema.parse(payload);
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

  if (kind === "recurring") {
    const options = recurringPayloadSchema.parse(payload);
    const response = await client.transactionsRecurringGet({
      access_token: accessToken,
      account_ids: options.accountIds
    });

    return {
      inflowStreams: response.data.inflow_streams,
      outflowStreams: response.data.outflow_streams,
      updatedDatetime: response.data.updated_datetime,
      personalFinanceCategoryVersion: response.data.personal_finance_category_version,
      requestId: response.data.request_id
    };
  }

  if (kind === "identity") {
    const response = await client.identityGet({ access_token: accessToken });
    return response.data.accounts;
  }

  if (kind === "holdings") {
    const response = await client.investmentsHoldingsGet({ access_token: accessToken });
    return response.data;
  }

  if (kind === "item") {
    const response = await client.itemGet({ access_token: accessToken });
    return response.data;
  }

  const response = await client.authGet({ access_token: accessToken });
  return {
    accounts: response.data.accounts,
    numbers: response.data.numbers
  };
}

function createServerPlaidClient(environment: PlaidEnvironment): PlaidApi {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = getPlaidSecret(environment);

  if (!clientId || !secret) {
    throw new ApiError(500, `Plaid credentials are not configured for ${environment}.`);
  }

  return new PlaidApi(
    new Configuration({
      basePath: plaidHosts[environment],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret
        }
      }
    })
  );
}

function getPlaidEnvironment(value?: string): PlaidEnvironment {
  try {
    return normalizePlaidEnvironment(value ?? process.env.PLAID_ENV);
  } catch (error) {
    throw new ApiError(500, error instanceof Error ? error.message : "Invalid PLAID_ENV.");
  }
}

function getPlaidSecret(environment: PlaidEnvironment): string | undefined {
  if (environment === "sandbox") {
    return process.env.PLAID_SANDBOX_SECRET ?? process.env.PLAID_SECRET;
  }

  if (environment === "development") {
    return process.env.PLAID_DEVELOPMENT_SECRET ?? process.env.PLAID_SECRET;
  }

  return process.env.PLAID_PRODUCTION_SECRET ?? process.env.PLAID_SECRET;
}

function getEnvelopeSecret(): string {
  const secret =
    process.env.PENNY_PINCHER_ENCRYPTION_KEY
    ?? process.env.PENNY_PINCER_ENCRYPTION_KEY
    ?? process.env.FINCLAW_ENCRYPTION_KEY;

  if (!secret) {
    throw new ApiError(500, "PENNY_PINCHER_ENCRYPTION_KEY is not configured on the Penny Pincher backend.");
  }

  return secret;
}

async function withJsonPost(
  request: VercelRequest,
  response: VercelResponse,
  handler: () => Promise<void>
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await handler();
  } catch (error) {
    const plaid = extractPlaidError(error);
    if (plaid) {
      response.status(plaid.status).json({
        error: plaid.message,
        plaid: plaid.body
      });
      return;
    }

    const status = error instanceof ApiError ? error.status : 400;
    response.status(status).json({
      error: error instanceof Error ? error.message : "Unknown Penny Pincher backend error."
    });
  }
}

function extractPlaidError(
  error: unknown
): { status: number; message: string; body: unknown } | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const maybeResponse = (error as { response?: unknown }).response;
  if (typeof maybeResponse !== "object" || maybeResponse === null) {
    return undefined;
  }

  const body = (maybeResponse as { data?: unknown }).data;
  const status = (maybeResponse as { status?: unknown }).status;
  if (typeof status !== "number" || typeof body !== "object" || body === null) {
    return undefined;
  }

  const plaid = body as {
    error_message?: string;
    error_code?: string;
    error_type?: string;
    display_message?: string;
  };

  const message =
    plaid.display_message ??
    plaid.error_message ??
    [plaid.error_type, plaid.error_code].filter(Boolean).join("/") ??
    "Plaid request failed.";

  return { status, message: `Plaid ${plaid.error_code ?? "ERROR"}: ${message}`, body };
}

function readInstitution(metadata: unknown): { name?: string; id?: string } {
  const parsed = z
    .object({
      institution: z
        .object({
          name: z.string().optional(),
          institution_id: z.string().optional()
        })
        .optional()
    })
    .safeParse(metadata);

  return {
    name: parsed.success ? parsed.data.institution?.name : undefined,
    id: parsed.success ? parsed.data.institution?.institution_id : undefined
  };
}

function hashShort(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 32);
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

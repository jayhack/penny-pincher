import type { PlaidEnvironment } from "./config.js";
import { createSignedRequest, type SignedRequest } from "./crypto.js";

export const defaultBackendUrl = "https://penny-pincher-cli.vercel.app";

export interface BackendErrorBody {
  error?: string;
}

export interface LinkTokenRequest {
  publicKeyPem: string;
  environment: PlaidEnvironment;
  products: string[];
  countryCodes: string[];
  redirectUri?: string;
}

export interface LinkTokenResponse {
  linkToken: string;
  environment: "sandbox" | "development" | "production";
}

export interface ExchangePayload {
  publicToken: string;
  publicKeyPem: string;
  environment: PlaidEnvironment;
  products: string[];
  countryCodes: string[];
  metadata?: unknown;
}

export interface ExchangeResponse {
  tokenEnvelope: string;
  itemId: string;
  environment: "sandbox" | "development" | "production";
  institutionName?: string;
  institutionId?: string;
  products: string[];
  countryCodes: string[];
}

export async function createHostedLinkToken(
  backendUrl: string,
  body: LinkTokenRequest
): Promise<LinkTokenResponse> {
  return postJson(backendUrl, "/api/link-token", body);
}

export async function exchangeHostedPublicToken(
  backendUrl: string,
  payload: ExchangePayload,
  privateKeyPem: string
): Promise<ExchangeResponse> {
  const signed = createSignedRequest({
    method: "POST",
    path: "/api/exchange",
    payload,
    privateKeyPem
  });

  return postJson(backendUrl, "/api/exchange", signed);
}

export async function postSignedDataRequest<TPayload, TResult>(
  options: {
    backendUrl: string;
    path: string;
    tokenEnvelope: string;
    privateKeyPem: string;
    payload: TPayload;
  }
): Promise<TResult> {
  const signed = createSignedRequest({
    method: "POST",
    path: options.path,
    payload: options.payload,
    privateKeyPem: options.privateKeyPem
  });

  return postJson(options.backendUrl, options.path, {
    tokenEnvelope: options.tokenEnvelope,
    ...signed
  });
}

async function postJson<TResult>(backendUrl: string, path: string, body: unknown): Promise<TResult> {
  const response = await fetch(new URL(path, normalizeBackendUrl(backendUrl)), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const errorBody = parsed as BackendErrorBody | undefined;
    throw new Error(errorBody?.error ?? `Penny Pincher backend returned HTTP ${response.status}.`);
  }

  return parsed as TResult;
}

export function normalizeBackendUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export type SignedBackendRequest<TPayload> = SignedRequest<TPayload> & {
  tokenEnvelope: string;
};

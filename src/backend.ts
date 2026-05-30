import type { PlaidEnvironment } from "./config.js";
import { createSignedRequest, type SignedRequest } from "./crypto.js";

export const defaultBackendUrl = "https://penny-pincher-cli.vercel.app";
const legacyDefaultBackendUrls = new Set([
  "https://penny-pincher.vercel.app/",
  "http://localhost:3000/",
  "http://127.0.0.1:3000/"
]);

export interface BackendErrorBody {
  error?: string;
}

export interface LinkTokenRequest {
  publicKeyPem: string;
  environment: PlaidEnvironment;
  products: string[];
  countryCodes: string[];
  redirectUri?: string;
  linkCustomizationName?: string;
}

export interface LinkTokenResponse {
  linkToken: string;
  environment: "sandbox" | "development" | "production";
}

export interface BillingSessionRequest {
  publicKeyPem: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingStatusRequest {
  publicKeyPem: string;
  checkoutSessionId?: string;
}

export interface BillingPortalRequest {
  publicKeyPem: string;
  returnUrl: string;
}

export interface BillingUsageRequest {
  publicKeyPem: string;
}

export interface BillingStatusResponse {
  active: boolean;
  status: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
}

export interface BillingSessionResponse extends BillingStatusResponse {
  checkoutUrl?: string;
  checkoutSessionId?: string;
}

export interface BillingPortalResponse {
  url: string;
}

export interface BillingUsageResponse extends BillingStatusResponse {
  totalCalls: number;
  estimatedCents: number;
  currency: "usd";
  byKind: Array<{
    kind: string;
    calls: number;
    estimatedCents: number;
    pendingEvents: number;
    failedEvents: number;
  }>;
  recent: Array<{
    kind: string;
    estimatedCents: number;
    stripeStatus: string;
    requestedAt: string;
  }>;
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

export interface UpdateLinkTokenRequest {
  publicKeyPem: string;
  additionalConsentedProducts: string[];
  countryCodes: string[];
  redirectUri?: string;
  linkCustomizationName?: string;
}

export async function createHostedLinkToken(
  backendUrl: string,
  body: LinkTokenRequest
): Promise<LinkTokenResponse> {
  return postJson(backendUrl, "/api/link-token", body);
}

export async function createHostedUpdateLinkToken(
  backendUrl: string,
  tokenEnvelope: string,
  payload: UpdateLinkTokenRequest,
  privateKeyPem: string
): Promise<LinkTokenResponse> {
  return postSignedDataRequest<typeof payload, LinkTokenResponse>({
    backendUrl,
    path: "/api/update-link-token",
    tokenEnvelope,
    privateKeyPem,
    payload
  });
}

export async function createBillingCheckoutSession(
  backendUrl: string,
  payload: BillingSessionRequest,
  privateKeyPem: string
): Promise<BillingSessionResponse> {
  return postSigned(backendUrl, "/api/billing-session", payload, privateKeyPem);
}

export async function getBillingStatus(
  backendUrl: string,
  payload: BillingStatusRequest,
  privateKeyPem: string
): Promise<BillingStatusResponse> {
  return postSigned(backendUrl, "/api/billing-status", payload, privateKeyPem);
}

export async function createBillingPortalSession(
  backendUrl: string,
  payload: BillingPortalRequest,
  privateKeyPem: string
): Promise<BillingPortalResponse> {
  return postSigned(backendUrl, "/api/billing-portal", payload, privateKeyPem);
}

export async function getBillingUsage(
  backendUrl: string,
  payload: BillingUsageRequest,
  privateKeyPem: string
): Promise<BillingUsageResponse> {
  return postSigned(backendUrl, "/api/billing-usage", payload, privateKeyPem);
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

function postSigned<TPayload, TResult>(
  backendUrl: string,
  path: string,
  payload: TPayload,
  privateKeyPem: string
): Promise<TResult> {
  const signed = createSignedRequest({
    method: "POST",
    path,
    payload,
    privateKeyPem
  });

  return postJson(backendUrl, path, signed);
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

export function resolveBackendUrl(configuredUrl?: string): string {
  const override =
    process.env.PENNY_PINCHER_API_URL
    ?? process.env.PENNY_PINCER_API_URL
    ?? process.env.FINCLAW_API_URL;

  if (override) {
    return normalizeBackendUrl(override);
  }

  if (!configuredUrl) {
    return normalizeBackendUrl(defaultBackendUrl);
  }

  const normalized = normalizeBackendUrl(configuredUrl);
  return legacyDefaultBackendUrls.has(normalized)
    ? normalizeBackendUrl(defaultBackendUrl)
    : normalized;
}

export type SignedBackendRequest<TPayload> = SignedRequest<TPayload> & {
  tokenEnvelope: string;
};

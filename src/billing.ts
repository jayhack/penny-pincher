import type { VercelRequest } from "@vercel/node";
import Stripe from "stripe";
import { z } from "zod";
import { one, query } from "./db.js";
import { publicKeyFingerprint, verifySignedRequest, type SignedRequest } from "./crypto.js";

export type BillingStatus = "active" | "trialing" | "incomplete" | "incomplete_expired" | "past_due" | "canceled" | "unpaid" | "none";
export type BillableDataKind = "accounts" | "balances" | "transactions" | "identity" | "numbers";

const signedRequestSchema = z.object({
  payload: z.unknown(),
  timestamp: z.string(),
  nonce: z.string(),
  signature: z.string()
});

export const billingSessionPayloadSchema = z.object({
  publicKeyPem: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url()
});

export const billingStatusPayloadSchema = z.object({
  publicKeyPem: z.string().min(1),
  checkoutSessionId: z.string().min(1).optional()
});

export const billingPortalPayloadSchema = z.object({
  publicKeyPem: z.string().min(1),
  returnUrl: z.string().url()
});

export const billingUsagePayloadSchema = z.object({
  publicKeyPem: z.string().min(1)
});

interface BillingCustomerRow {
  public_key_fingerprint: string;
  public_key_pem: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  status: BillingStatus;
  current_period_start: Date | string | null;
  current_period_end: Date | string | null;
}

interface UsageSummaryRow {
  data_kind: BillableDataKind;
  calls: string;
  estimated_cents: string;
  pending_events: string;
  failed_events: string;
}

interface RecentUsageRow {
  data_kind: BillableDataKind;
  estimated_cents: number;
  stripe_status: string;
  requested_at: Date | string;
}

interface UsageTotalRow {
  calls: string | null;
  estimated_cents: string | null;
}

export interface BillingStatusResponse {
  active: boolean;
  status: BillingStatus;
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
    kind: BillableDataKind;
    calls: number;
    estimatedCents: number;
    pendingEvents: number;
    failedEvents: number;
  }>;
  recent: Array<{
    kind: BillableDataKind;
    estimatedCents: number;
    stripeStatus: string;
    requestedAt: string;
  }>;
}

export class BillingError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function parseSignedBillingPayload<TSchema extends z.ZodTypeAny>(
  body: unknown,
  path: string,
  schema: TSchema
): z.infer<TSchema> {
  const signed = signedRequestSchema.parse(body) as SignedRequest<unknown>;
  const payload = schema.parse(signed.payload) as z.infer<TSchema> & { publicKeyPem: string };

  verifySignedRequest({
    method: "POST",
    path,
    request: signed as SignedRequest<typeof payload>,
    publicKeyPem: payload.publicKeyPem
  });

  return payload;
}

export async function createBillingCheckoutSession(
  payload: z.infer<typeof billingSessionPayloadSchema>
): Promise<BillingSessionResponse> {
  const existing = await getBillingCustomer(payload.publicKeyPem);
  if (existing && isActiveBillingStatus(existing.status)) {
    return serializeBillingStatus(existing);
  }

  const customer = await ensureBillingCustomer(payload.publicKeyPem);
  const stripe = stripeClient();
  const priceId = getMeteredPriceId();
  const fingerprint = publicKeyFingerprint(payload.publicKeyPem);
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.stripe_customer_id,
    client_reference_id: fingerprint,
    line_items: [
      {
        price: priceId
      }
    ],
    success_url: withCheckoutSessionId(payload.successUrl),
    cancel_url: payload.cancelUrl,
    subscription_data: {
      metadata: {
        public_key_fingerprint: fingerprint
      }
    },
    metadata: {
      public_key_fingerprint: fingerprint
    }
  });

  await query(
    `INSERT INTO billing_sessions (
      public_key_fingerprint,
      stripe_checkout_session_id,
      status,
      expires_at
    ) VALUES ($1, $2, $3, to_timestamp($4))
    ON CONFLICT (stripe_checkout_session_id)
    DO UPDATE SET status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
    [fingerprint, checkout.id, checkout.status ?? "open", checkout.expires_at ?? null]
  );

  return {
    ...serializeBillingStatus(customer),
    checkoutUrl: checkout.url ?? undefined,
    checkoutSessionId: checkout.id
  };
}

export async function getBillingStatus(
  payload: z.infer<typeof billingStatusPayloadSchema>
): Promise<BillingStatusResponse> {
  if (payload.checkoutSessionId) {
    await syncCheckoutSession(payload.checkoutSessionId, publicKeyFingerprint(payload.publicKeyPem));
  }

  const customer = await getBillingCustomer(payload.publicKeyPem);
  return serializeBillingStatus(customer);
}

export async function createBillingPortalSession(
  payload: z.infer<typeof billingPortalPayloadSchema>
): Promise<BillingPortalResponse> {
  const customer = await getBillingCustomer(payload.publicKeyPem);
  if (!customer) {
    throw new BillingError(402, "No Stripe customer found. Run `penny-pincher auth` first.");
  }

  const session = await stripeClient().billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    return_url: payload.returnUrl
  });

  return { url: session.url };
}

export async function getBillingUsage(
  payload: z.infer<typeof billingUsagePayloadSchema>
): Promise<BillingUsageResponse> {
  const customer = await getBillingCustomer(payload.publicKeyPem);
  const status = serializeBillingStatus(customer);
  const fingerprint = publicKeyFingerprint(payload.publicKeyPem);
  const periodStart = customer?.current_period_start ? toIso(customer.current_period_start) : undefined;
  const values = periodStart ? [fingerprint, periodStart] : [fingerprint];
  const periodClause = periodStart ? "AND requested_at >= $2" : "";
  const totals = await one<UsageTotalRow>(
    `SELECT COUNT(*)::text AS calls, COALESCE(SUM(estimated_cents), 0)::text AS estimated_cents
     FROM usage_events
     WHERE public_key_fingerprint = $1 ${periodClause}`,
    values
  );
  const byKind = await query<UsageSummaryRow>(
    `SELECT
       data_kind,
       COUNT(*)::text AS calls,
       COALESCE(SUM(estimated_cents), 0)::text AS estimated_cents,
       COUNT(*) FILTER (WHERE stripe_status = 'pending')::text AS pending_events,
       COUNT(*) FILTER (WHERE stripe_status = 'failed')::text AS failed_events
     FROM usage_events
     WHERE public_key_fingerprint = $1 ${periodClause}
     GROUP BY data_kind
     ORDER BY data_kind`,
    values
  );
  const recent = await query<RecentUsageRow>(
    `SELECT data_kind, estimated_cents, stripe_status, requested_at
     FROM usage_events
     WHERE public_key_fingerprint = $1 ${periodClause}
     ORDER BY requested_at DESC
     LIMIT 10`,
    values
  );

  return {
    ...status,
    totalCalls: Number(totals?.calls ?? 0),
    estimatedCents: Number(totals?.estimated_cents ?? 0),
    currency: "usd",
    byKind: byKind.rows.map((row) => ({
      kind: row.data_kind,
      calls: Number(row.calls),
      estimatedCents: Number(row.estimated_cents),
      pendingEvents: Number(row.pending_events),
      failedEvents: Number(row.failed_events)
    })),
    recent: recent.rows.map((row) => ({
      kind: row.data_kind,
      estimatedCents: row.estimated_cents,
      stripeStatus: row.stripe_status,
      requestedAt: toIso(row.requested_at)
    }))
  };
}

export async function requireActiveBilling(publicKeyPem: string): Promise<BillingCustomerRow> {
  const customer = await getBillingCustomer(publicKeyPem);
  if (!customer || !isActiveBillingStatus(customer.status)) {
    throw new BillingError(402, "Active Stripe billing is required. Run `penny-pincher auth` first.");
  }

  return customer;
}

export async function recordUsageEvent(options: {
  publicKeyPem: string;
  kind: BillableDataKind;
  environment: string;
  itemId?: string;
  requestNonce: string;
  requestedAt: string;
}): Promise<void> {
  const customer = await requireActiveBilling(options.publicKeyPem);
  const idempotencyKey = [
    publicKeyFingerprint(options.publicKeyPem),
    options.kind,
    options.itemId ?? "unknown-item",
    options.requestNonce
  ].join(":");
  const estimatedCents = estimatedCentsForKind(options.kind);
  const inserted = await one<{ id: string }>(
    `INSERT INTO usage_events (
      idempotency_key,
      public_key_fingerprint,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_subscription_item_id,
      plaid_item_id,
      data_kind,
      environment,
      quantity,
      estimated_cents,
      stripe_status,
      requested_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 'pending', $10)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id::text`,
    [
      idempotencyKey,
      customer.public_key_fingerprint,
      customer.stripe_customer_id,
      customer.stripe_subscription_id,
      customer.stripe_subscription_item_id,
      options.itemId,
      options.kind,
      options.environment,
      estimatedCents,
      new Date(options.requestedAt)
    ]
  );

  if (!inserted) {
    return;
  }

  try {
    await stripeClient().billing.meterEvents.create({
      event_name: getMeterEventName(),
      identifier: idempotencyKey,
      timestamp: Math.floor(Date.parse(options.requestedAt) / 1000),
      payload: {
        stripe_customer_id: customer.stripe_customer_id,
        value: "1"
      }
    });
    await query(
      `UPDATE usage_events
       SET stripe_status = 'reported', stripe_error = NULL, updated_at = NOW()
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
  } catch (error) {
    await markUsageEventFailed(idempotencyKey, error instanceof Error ? error.message : "Stripe metering failed.");
  }
}

export async function handleStripeWebhook(request: VercelRequest): Promise<{ received: true }> {
  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string") {
    throw new BillingError(400, "Missing Stripe signature.");
  }

  const event = stripeClient().webhooks.constructEvent(
    await readRawBody(request),
    signature,
    getRequiredEnv("STRIPE_WEBHOOK_SECRET")
  );

  const existing = await one<{ stripe_event_id: string }>(
    "SELECT stripe_event_id FROM stripe_webhook_events WHERE stripe_event_id = $1",
    [event.id]
  );
  if (existing) {
    return { received: true };
  }

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.id) {
      await syncCheckoutSession(session.id, session.client_reference_id ?? undefined);
    }
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await syncSubscription(event.data.object as Stripe.Subscription);
  }

  await query(
    `INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [event.id, event.type]
  );

  return { received: true };
}

async function getBillingCustomer(publicKeyPem: string): Promise<BillingCustomerRow | undefined> {
  return one<BillingCustomerRow>(
    `SELECT
       public_key_fingerprint,
       public_key_pem,
       stripe_customer_id,
       stripe_subscription_id,
       stripe_subscription_item_id,
       status,
       current_period_start,
       current_period_end
     FROM billing_customers
     WHERE public_key_fingerprint = $1`,
    [publicKeyFingerprint(publicKeyPem)]
  );
}

async function ensureBillingCustomer(publicKeyPem: string): Promise<BillingCustomerRow> {
  const existing = await getBillingCustomer(publicKeyPem);
  if (existing) {
    return existing;
  }

  const fingerprint = publicKeyFingerprint(publicKeyPem);
  const customer = await stripeClient().customers.create({
    metadata: {
      public_key_fingerprint: fingerprint
    }
  });

  const inserted = await one<BillingCustomerRow>(
    `INSERT INTO billing_customers (
      public_key_fingerprint,
      public_key_pem,
      stripe_customer_id,
      status
    ) VALUES ($1, $2, $3, 'incomplete')
    ON CONFLICT (public_key_fingerprint)
    DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem, updated_at = NOW()
    RETURNING
      public_key_fingerprint,
      public_key_pem,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_subscription_item_id,
      status,
      current_period_start,
      current_period_end`,
    [fingerprint, publicKeyPem, customer.id]
  );

  if (!inserted) {
    throw new BillingError(500, "Unable to create billing customer.");
  }

  return inserted;
}

async function syncCheckoutSession(
  checkoutSessionId: string,
  expectedFingerprint?: string
): Promise<void> {
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
    expand: ["subscription", "subscription.items.data"]
  });
  const fingerprint = session.client_reference_id ?? session.metadata?.public_key_fingerprint;

  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new BillingError(403, "Checkout session does not belong to this CLI key.");
  }

  await query(
    `UPDATE billing_sessions
     SET status = $2, updated_at = NOW()
     WHERE stripe_checkout_session_id = $1`,
    [checkoutSessionId, session.status ?? "unknown"]
  );

  if (!fingerprint || !session.subscription) {
    return;
  }

  const subscription =
    typeof session.subscription === "string"
      ? await stripe.subscriptions.retrieve(session.subscription, { expand: ["items.data"] })
      : session.subscription;
  await syncSubscription(subscription as Stripe.Subscription, fingerprint);
}

async function syncSubscription(subscription: Stripe.Subscription, fallbackFingerprint?: string): Promise<void> {
  const fingerprint =
    subscription.metadata?.public_key_fingerprint ??
    fallbackFingerprint ??
    await findFingerprintForStripeCustomer(readStripeId(subscription.customer));
  if (!fingerprint) {
    return;
  }

  const subscriptionAny = subscription as unknown as {
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: Array<{ id: string; price?: { id?: string } }> };
  };
  const item = subscriptionAny.items?.data?.find((entry) => entry.price?.id === getMeteredPriceId())
    ?? subscriptionAny.items?.data?.[0];

  await query(
    `UPDATE billing_customers
     SET
       stripe_subscription_id = $2,
       stripe_subscription_item_id = $3,
       status = $4,
       current_period_start = CASE WHEN $5::bigint IS NULL THEN current_period_start ELSE to_timestamp($5) END,
       current_period_end = CASE WHEN $6::bigint IS NULL THEN current_period_end ELSE to_timestamp($6) END,
       updated_at = NOW()
     WHERE public_key_fingerprint = $1`,
    [
      fingerprint,
      subscription.id,
      item?.id ?? null,
      subscription.status,
      subscriptionAny.current_period_start ?? null,
      subscriptionAny.current_period_end ?? null
    ]
  );
}

async function findFingerprintForStripeCustomer(stripeCustomerId: string | undefined): Promise<string | undefined> {
  if (!stripeCustomerId) {
    return undefined;
  }

  const row = await one<{ public_key_fingerprint: string }>(
    "SELECT public_key_fingerprint FROM billing_customers WHERE stripe_customer_id = $1",
    [stripeCustomerId]
  );
  return row?.public_key_fingerprint;
}

async function markUsageEventFailed(idempotencyKey: string, message: string): Promise<void> {
  await query(
    `UPDATE usage_events
     SET stripe_status = 'failed', stripe_error = $2, updated_at = NOW()
     WHERE idempotency_key = $1`,
    [idempotencyKey, message.slice(0, 500)]
  );
}

function serializeBillingStatus(customer: BillingCustomerRow | undefined): BillingStatusResponse {
  return {
    active: customer ? isActiveBillingStatus(customer.status) : false,
    status: customer?.status ?? "none",
    stripeCustomerId: customer?.stripe_customer_id,
    stripeSubscriptionId: customer?.stripe_subscription_id ?? undefined,
    currentPeriodStart: customer?.current_period_start ? toIso(customer.current_period_start) : undefined,
    currentPeriodEnd: customer?.current_period_end ? toIso(customer.current_period_end) : undefined
  };
}

function isActiveBillingStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

function stripeClient(): Stripe {
  return new Stripe(getRequiredEnv("STRIPE_SECRET_KEY"));
}

function getMeteredPriceId(): string {
  return getRequiredEnv("STRIPE_METERED_PRICE_ID");
}

function getMeterEventName(): string {
  return getRequiredEnv("STRIPE_METER_EVENT_NAME");
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new BillingError(500, `${name} is not configured.`);
  }

  return value;
}

function estimatedCentsForKind(kind: BillableDataKind): number {
  const envName = `PENNY_PINCHER_COST_${kind.toUpperCase()}_CENTS`;
  const raw = process.env[envName] ?? process.env.PENNY_PINCHER_DEFAULT_USAGE_COST_CENTS ?? "1";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

function withCheckoutSessionId(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  return parsed.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
}

function readStripeId(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return typeof value === "string" ? value : value.id;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function readRawBody(request: VercelRequest): Promise<Buffer> {
  if (Buffer.isBuffer(request.body)) {
    return Promise.resolve(request.body);
  }

  if (typeof request.body === "string") {
    return Promise.resolve(Buffer.from(request.body));
  }

  if (request.body && typeof request.body === "object") {
    return Promise.resolve(Buffer.from(JSON.stringify(request.body)));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

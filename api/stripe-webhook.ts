import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleStripeWebhook } from "../src/billing.js";
import { withBillingJsonPost } from "../src/billing-http.js";

export default function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  return withBillingJsonPost(request, response, () => handleStripeWebhook(request));
}

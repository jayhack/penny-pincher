import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  billingStatusPayloadSchema,
  getBillingStatus,
  parseSignedBillingPayload
} from "../src/billing.js";
import { withBillingJsonPost } from "../src/billing-http.js";

export default function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  return withBillingJsonPost(request, response, () =>
    getBillingStatus(
      parseSignedBillingPayload(request.body, "/api/billing-status", billingStatusPayloadSchema)
    )
  );
}

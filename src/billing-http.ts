import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ZodError } from "zod";
import { BillingError } from "./billing.js";

export async function withBillingJsonPost(
  request: VercelRequest,
  response: VercelResponse,
  handler: () => Promise<unknown>
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const result = await handler();
    response.status(200).json(result);
  } catch (error) {
    const status = error instanceof BillingError ? error.status : error instanceof ZodError ? 400 : 500;
    response.status(status).json({
      error: error instanceof Error ? error.message : "Unknown billing error."
    });
  }
}

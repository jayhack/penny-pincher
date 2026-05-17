import type { VercelRequest, VercelResponse } from "@vercel/node";
import { exchangeHandler } from "../src/server.js";

export default function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  return exchangeHandler(request, response);
}

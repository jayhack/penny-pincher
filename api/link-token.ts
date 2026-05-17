import type { VercelRequest, VercelResponse } from "@vercel/node";
import { linkTokenHandler } from "../src/server.js";

export default function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  return linkTokenHandler(request, response);
}

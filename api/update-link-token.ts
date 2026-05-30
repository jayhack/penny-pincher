import type { VercelRequest, VercelResponse } from "@vercel/node";
import { updateLinkTokenHandler } from "../src/server.js";

export default function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  return updateLinkTokenHandler(request, response);
}

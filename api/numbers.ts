import type { VercelRequest, VercelResponse } from "@vercel/node";
import { dataHandler } from "../src/server.js";

export default function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  return dataHandler(request, response, "numbers");
}

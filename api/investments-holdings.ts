import type { VercelRequest, VercelResponse } from "@vercel/node";
import { dataHandler } from "../src/server.js";

export default function handler(request: VercelRequest, response: VercelResponse) {
  return dataHandler(request, response, "investments-holdings");
}

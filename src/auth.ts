import type { Server } from "node:http";
import express from "express";
import open from "open";
import { type FinclawConfig, type PlaidEnvironment, saveConfig } from "./config.js";
import { createPlaidClient } from "./plaid.js";

export interface AuthOptions {
  environment: PlaidEnvironment;
  products: string[];
  countryCodes: string[];
  port: number;
  openBrowser: boolean;
  onReady?: (url: string) => void;
}

interface LinkMetadata {
  institution?: {
    name?: string;
    institution_id?: string;
  };
}

export async function runAuthFlow(options: AuthOptions): Promise<FinclawConfig> {
  const client = createPlaidClient(options.environment);
  const redirectUri = process.env.PLAID_REDIRECT_URI;
  const linkTokenResponse = await client.linkTokenCreate({
    user: {
      client_user_id: `finclaw-${Date.now()}`
    },
    client_name: "Finclaw",
    products: options.products as never,
    country_codes: options.countryCodes as never,
    language: "en",
    redirect_uri: redirectUri
  });

  const linkToken = linkTokenResponse.data.link_token;
  const app = express();
  app.use(express.json());

  let server: Server | undefined;
  const finished = new Promise<FinclawConfig>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Plaid Link to finish."));
    }, 10 * 60 * 1000);

    app.get("/", (_request, response) => {
      response.type("html").send(renderLinkPage(linkToken));
    });

    app.get("/oauth-return", (_request, response) => {
      response.type("html").send(renderLinkPage(linkToken));
    });

    app.post("/exchange", async (request, response) => {
      try {
        const publicToken = request.body?.public_token;
        const metadata = request.body?.metadata as LinkMetadata | undefined;

        if (!publicToken || typeof publicToken !== "string") {
          response.status(400).json({ error: "Missing public_token" });
          return;
        }

        const exchange = await client.itemPublicTokenExchange({
          public_token: publicToken
        });
        const config: FinclawConfig = {
          environment: options.environment,
          accessToken: exchange.data.access_token,
          itemId: exchange.data.item_id,
          institutionName: metadata?.institution?.name,
          institutionId: metadata?.institution?.institution_id,
          products: options.products,
          countryCodes: options.countryCodes
        };

        await saveConfig(config);
        response.json({
          ok: true,
          configPath: "~/.finclaw/config.json",
          institutionName: config.institutionName,
          environment: config.environment
        });
        clearTimeout(timeout);
        resolve(config);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        response.status(500).json({
          error: error instanceof Error ? error.message : "Unknown Plaid exchange error"
        });
      }
    });
  }).finally(() => {
    server?.close();
  });

  server = await listen(app, options.port);
  const url = `http://localhost:${options.port}`;
  options.onReady?.(url);

  if (options.openBrowser) {
    await open(url);
  }

  return finished;
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on("error", reject);
  });
}

function renderLinkPage(linkToken: string): string {
  const serializedLinkToken = JSON.stringify(linkToken);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Finclaw Plaid Link</title>
    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { align-items: center; display: flex; min-height: 100vh; justify-content: center; margin: 0; padding: 24px; }
      main { max-width: 560px; }
      button { border: 0; border-radius: 10px; cursor: pointer; font: inherit; font-weight: 700; padding: 12px 18px; }
      pre { background: rgba(127, 127, 127, 0.15); border-radius: 10px; overflow: auto; padding: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect your bank with Finclaw</h1>
      <p id="status">Plaid Link should open automatically. If it does not, use the button below.</p>
      <button id="open">Open Plaid Link</button>
      <pre id="result" hidden></pre>
    </main>
    <script>
      const status = document.querySelector("#status");
      const result = document.querySelector("#result");
      const handler = Plaid.create({
        token: ${serializedLinkToken},
        receivedRedirectUri: window.location.pathname === "/oauth-return" ? window.location.href : undefined,
        onSuccess: async (public_token, metadata) => {
          status.textContent = "Exchanging Plaid public token...";
          const response = await fetch("/exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ public_token, metadata })
          });
          const body = await response.json();
          result.hidden = false;
          result.textContent = JSON.stringify(body, null, 2);
          status.textContent = response.ok ? "Success. You can return to your terminal." : "Token exchange failed.";
        },
        onExit: (error) => {
          if (error) {
            result.hidden = false;
            result.textContent = JSON.stringify(error, null, 2);
          }
          status.textContent = "Plaid Link was closed.";
        }
      });

      document.querySelector("#open").addEventListener("click", () => handler.open());
      handler.open();
    </script>
  </body>
</html>`;
}

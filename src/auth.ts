import type { Server } from "node:http";
import express from "express";
import open from "open";
import {
  createHostedLinkToken,
  defaultBackendUrl,
  exchangeHostedPublicToken,
  normalizeBackendUrl
} from "./backend.js";
import { type PennyPincherConfig, loadConfig, type PlaidEnvironment, saveConfig } from "./config.js";
import { generateSigningKeyPair } from "./crypto.js";
import { createPlaidClient } from "./plaid.js";

export interface AuthOptions {
  environment: PlaidEnvironment;
  products: string[];
  countryCodes: string[];
  port: number;
  openBrowser: boolean;
  directPlaid: boolean;
  backendUrl?: string;
  onReady?: (url: string) => void;
}

interface LinkMetadata {
  institution?: {
    name?: string;
    institution_id?: string;
  };
}

export async function runAuthFlow(options: AuthOptions): Promise<PennyPincherConfig> {
  if (!options.directPlaid) {
    return runHostedAuthFlow(options);
  }

  return runDirectAuthFlow(options);
}

async function runHostedAuthFlow(options: AuthOptions): Promise<PennyPincherConfig> {
  const existingConfig = await loadConfig();
  const keyPair =
    existingConfig.publicKeyPem && existingConfig.privateKeyPem
      ? {
          publicKeyPem: existingConfig.publicKeyPem,
          privateKeyPem: existingConfig.privateKeyPem
        }
      : generateSigningKeyPair();
  const backendUrl = normalizeBackendUrl(
    options.backendUrl
      ?? process.env.PENNY_PINCHER_API_URL
      ?? process.env.PENNY_PINCER_API_URL
      ?? process.env.FINCLAW_API_URL
      ?? defaultBackendUrl
  );
  const redirectUri = new URL("/oauth-return", backendUrl).toString();
  const link = await createHostedLinkToken(backendUrl, {
    publicKeyPem: keyPair.publicKeyPem,
    environment: options.environment,
    products: options.products,
    countryCodes: options.countryCodes,
    redirectUri
  });

  return runLocalLinkFlow({
    ...options,
    hostedLinkUrl: createHostedLinkUrl(backendUrl, link.linkToken, options.port),
    linkToken: link.linkToken,
    exchange: async (publicToken, metadata) => {
      const exchange = await exchangeHostedPublicToken(
        backendUrl,
        {
          publicToken,
          publicKeyPem: keyPair.publicKeyPem,
          environment: options.environment,
          products: options.products,
          countryCodes: options.countryCodes,
          metadata
        },
        keyPair.privateKeyPem
      );
      const config: PennyPincherConfig = {
        mode: "hosted",
        environment: exchange.environment,
        backendUrl,
        tokenEnvelope: exchange.tokenEnvelope,
        publicKeyPem: keyPair.publicKeyPem,
        privateKeyPem: keyPair.privateKeyPem,
        itemId: exchange.itemId,
        institutionName: exchange.institutionName,
        institutionId: exchange.institutionId,
        products: exchange.products,
        countryCodes: exchange.countryCodes
      };

      await saveConfig(config);
      return config;
    }
  });
}

async function runDirectAuthFlow(options: AuthOptions): Promise<PennyPincherConfig> {
  const client = createPlaidClient(options.environment);
  const redirectUri = process.env.PLAID_REDIRECT_URI;
  const linkTokenResponse = await client.linkTokenCreate({
    user: {
      client_user_id: `penny-pincher-${Date.now()}`
    },
    client_name: "Penny Pincher",
    products: options.products as never,
    country_codes: options.countryCodes as never,
    language: "en",
    redirect_uri: redirectUri
  });

  const linkToken = linkTokenResponse.data.link_token;

  return runLocalLinkFlow({
    ...options,
    linkToken,
    exchange: async (publicToken, metadata) => {
      const exchange = await client.itemPublicTokenExchange({
        public_token: publicToken
      });
      const config: PennyPincherConfig = {
        mode: "direct",
        environment: options.environment,
        accessToken: exchange.data.access_token,
        itemId: exchange.data.item_id,
        institutionName: metadata?.institution?.name,
        institutionId: metadata?.institution?.institution_id,
        products: options.products,
        countryCodes: options.countryCodes
      };

      await saveConfig(config);
      return config;
    }
  });
}

async function runLocalLinkFlow(options: AuthOptions & {
  linkToken: string;
  hostedLinkUrl?: string;
  exchange: (publicToken: string, metadata: LinkMetadata | undefined) => Promise<PennyPincherConfig>;
}): Promise<PennyPincherConfig> {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    if (_request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  });

  let server: Server | undefined;
  const finished = new Promise<PennyPincherConfig>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Plaid Link to finish."));
    }, 10 * 60 * 1000);

    app.get("/", (_request, response) => {
      if (options.hostedLinkUrl) {
        response.type("html").send(renderHostedWaitingPage(options.hostedLinkUrl));
        return;
      }

      response.type("html").send(renderLinkPage(options.linkToken));
    });

    app.get("/oauth-return", (_request, response) => {
      response.type("html").send(renderLinkPage(options.linkToken));
    });

    app.post("/exchange", async (request, response) => {
      try {
        const publicToken = request.body?.public_token;
        const metadata = request.body?.metadata as LinkMetadata | undefined;

        if (!publicToken || typeof publicToken !== "string") {
          response.status(400).json({ error: "Missing public_token" });
          return;
        }

        const config = await options.exchange(publicToken, metadata);
        response.json({
          ok: true,
          configPath: "~/.penny-pincher/config.json",
          institutionName: config.institutionName,
          environment: config.environment,
          mode: config.mode
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
  const url = options.hostedLinkUrl ?? `http://localhost:${options.port}`;
  options.onReady?.(url);

  if (options.openBrowser) {
    await open(url);
  }

  return finished;
}

function createHostedLinkUrl(backendUrl: string, linkToken: string, port: number): string {
  const url = new URL("/connect", backendUrl);
  url.searchParams.set("link_token", linkToken);
  url.searchParams.set("callback", `http://localhost:${port}/exchange`);
  return url.toString();
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on("error", reject);
  });
}

const SHARED_AUTH_STYLES = `
  :root {
    --paper:#fff; --lattice:#fbf4ec; --bloom:#f0cfab; --pulse:#d08454;
    --spark:#e04a14; --sovereign:#142a5c; --deep:#08163c;
    --glyph:#0b0f22; --stone:#757e96;
  }
  html, body { background: var(--paper); color: var(--glyph); margin: 0;
    font-family: "Inter", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased; }
  #ca-bg { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; opacity: 0.30; }
  .stage { position: relative; z-index: 1; min-height: 100vh; display: flex; flex-direction: column; }
  .top-bar { border-bottom: 1px solid var(--glyph); }
  .top-bar-inner { max-width: 760px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: var(--glyph); }
  .brand-mark { font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 0.16em; font-size: 11px; font-weight: 700; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; border: 1px solid var(--glyph); border-radius: 2px; font-family: "JetBrains Mono", monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: var(--glyph); background: var(--paper); }
  .chip::before { content: "▪"; color: var(--spark); }
  main { flex: 1; max-width: 760px; width: 100%; margin: 0 auto; padding: 64px 24px 56px; box-sizing: border-box; }
  .label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .label { font-family: "Inter", sans-serif; font-weight: 500; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--glyph); }
  .label::before { content: "▪"; color: var(--spark); margin-right: 0.5em; }
  .label-aux { font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 0.16em; font-size: 10px; color: var(--stone); }
  .display-lift { font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif; font-weight: 900; letter-spacing: -0.025em; line-height: 0.9; color: var(--glyph); font-size: clamp(3.5rem, 14vw, 9rem); text-shadow: 5px 5px 0 var(--bloom), 10px 10px 0 rgba(8, 22, 60, 0.22); margin: 0; }
  .lede { max-width: 560px; margin: 32px 0 0; font-size: 17px; line-height: 1.55; color: var(--glyph); font-weight: 500; }
  .lede .dim { color: var(--stone); }
  .actions { margin-top: 28px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .btn-primary { background: linear-gradient(180deg, #142a5c 0%, #08163c 100%); color: #fff; padding: 13px 22px; border: 0; border-radius: 2px; font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 0.16em; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 10px; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 2px 0 var(--bloom); transition: transform 80ms ease, box-shadow 80ms ease, background 80ms ease; cursor: pointer; text-decoration: none; }
  .btn-primary:hover { background: linear-gradient(180deg, #1f3d7f 0%, #0f2050 100%); }
  .btn-primary:active { transform: translateY(2px); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .status { display: inline-flex; align-items: center; gap: 10px; padding: 9px 14px; border: 1px solid var(--glyph); border-radius: 2px; background: var(--paper); font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--glyph); }
  .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 1px; background: var(--spark); animation: pulse 1.4s ease-in-out infinite; }
  .status.is-success .dot { background: var(--sovereign); animation: none; }
  .status.is-error   .dot { background: var(--spark); animation: none; }
  .status.is-idle    .dot { background: var(--stone); animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .status .dot { animation: none; } }
  .telemetry { margin-top: 40px; padding-top: 22px; border-top: 1px solid rgba(11, 15, 34, 0.15); display: flex; gap: 28px; flex-wrap: wrap; font-family: "JetBrains Mono", monospace; font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; }
  .telemetry .k { color: var(--stone); }
  .telemetry .v { color: var(--glyph); font-weight: 700; margin-left: 8px; }
  .ink { margin-top: 28px; background: var(--glyph); border: 1.5px solid var(--glyph); border-radius: 2px; box-shadow: 4px 4px 0 var(--sovereign); padding: 16px 18px; }
  .ink .ink-label { font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 0.16em; font-size: 10px; font-weight: 700; color: var(--spark); margin-bottom: 8px; }
  .ink pre { margin: 0; font-family: "JetBrains Mono", monospace; font-size: 12.5px; line-height: 1.6; color: var(--bloom); white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; }
  footer { border-top: 1px solid var(--glyph); }
  .footer-inner { max-width: 760px; margin: 0 auto; padding: 18px 24px; display: flex; gap: 12px; justify-content: space-between; align-items: center; flex-wrap: wrap; font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 0.16em; font-size: 10px; color: var(--stone); }
  .note { margin-top: 16px; font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 0.16em; font-size: 10px; color: var(--stone); }
  .note .accent { color: var(--spark); }
`;

const FONT_LINKS = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" />
`;

const BRAND_SVG = `
  <svg viewBox="0 0 36 36" width="22" height="22" aria-hidden="true">
    <g fill="#F0CFAB">
      <rect x="0"  y="0"  width="8" height="8" rx="1"/><rect x="9"  y="0"  width="8" height="8" rx="1"/>
      <rect x="27" y="0"  width="8" height="8" rx="1"/><rect x="18" y="9"  width="8" height="8" rx="1"/>
      <rect x="0"  y="18" width="8" height="8" rx="1"/><rect x="18" y="18" width="8" height="8" rx="1"/>
      <rect x="27" y="18" width="8" height="8" rx="1"/><rect x="9"  y="27" width="8" height="8" rx="1"/>
      <rect x="18" y="27" width="8" height="8" rx="1"/>
    </g>
    <g fill="#E04A14">
      <rect x="18" y="0"  width="8" height="8" rx="1"/><rect x="9"  y="9"  width="8" height="8" rx="1"/>
      <rect x="9"  y="18" width="8" height="8" rx="1"/><rect x="0"  y="27" width="8" height="8" rx="1"/>
      <rect x="27" y="27" width="8" height="8" rx="1"/>
    </g>
  </svg>
`;

const CA_BG_SCRIPT = `
  (function () {
    const canvas = document.getElementById("ca-bg");
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const CELL_SIZE = 44, CELL_GAP = 4, STEP_MS = 1200;
    const EASE_IN = 0.032, EASE_OUT = 0.020, MAX_ALPHA = 0.72;
    const CELL_RGB = [195, 210, 240];
    let cols = 0, rows = 0;
    let grid = new Uint8Array(0), alpha = new Float32Array(0), target = new Float32Array(0);
    let generation = 0, lastStep = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pitch = CELL_SIZE + CELL_GAP;
      cols = Math.ceil(w / pitch) + 1; rows = Math.ceil(h / pitch) + 1;
      const n = cols * rows;
      grid = new Uint8Array(n); alpha = new Float32Array(n); target = new Float32Array(n);
      for (let i = 0; i < n; i++) if (Math.random() < 0.22) grid[i] = 1;
      for (let i = 0; i < n; i++) target[i] = grid[i] ? MAX_ALPHA : 0;
    }
    function idx(x, y) { return ((y + rows) % rows) * cols + ((x + cols) % cols); }
    function step() {
      const next = new Uint8Array(grid.length);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          n += grid[idx(x + dx, y + dy)];
        }
        const here = grid[idx(x, y)];
        if (here && (n === 2 || n === 3)) next[idx(x, y)] = 1;
        else if (!here && n === 3) next[idx(x, y)] = 1;
      }
      grid = next; generation++;
      if (generation %  80 === 0) for (let i = 0; i < grid.length; i++) if (Math.random() < 0.05) grid[i] = 1;
      if (generation % 320 === 0) for (let i = 0; i < grid.length; i++) if (Math.random() < 0.24) grid[i] = 1;
      for (let i = 0; i < grid.length; i++) target[i] = grid[i] ? MAX_ALPHA : 0;
    }
    function draw() {
      const w = canvas.width / dpr, h = canvas.height / dpr;
      ctx.clearRect(0, 0, w, h);
      const pitch = CELL_SIZE + CELL_GAP;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const a = alpha[y * cols + x];
        if (a <= 0.003) continue;
        ctx.fillStyle = "rgba(" + CELL_RGB[0] + "," + CELL_RGB[1] + "," + CELL_RGB[2] + "," + a + ")";
        ctx.fillRect(x * pitch, y * pitch, CELL_SIZE, CELL_SIZE);
      }
    }
    function frame(now) {
      if (!lastStep) lastStep = now;
      if (now - lastStep >= STEP_MS) { step(); lastStep = now; }
      let dirty = false;
      for (let i = 0; i < alpha.length; i++) {
        const t = target[i], a = alpha[i];
        if (a !== t) {
          const ease = t > a ? EASE_IN : EASE_OUT;
          const nxt = a + (t - a) * ease;
          alpha[i] = Math.abs(nxt - t) < 0.002 ? t : nxt;
          dirty = true;
        }
      }
      if (dirty) draw();
      requestAnimationFrame(frame);
    }
    resize();
    let raf = 0;
    window.addEventListener("resize", () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(resize); });
    if (reducedMotion) { for (let i = 0; i < alpha.length; i++) alpha[i] = target[i]; draw(); }
    else { for (let i = 0; i < alpha.length; i++) alpha[i] = 0; requestAnimationFrame(frame); }
  })();
`;

function renderLinkPage(linkToken: string): string {
  const serializedLinkToken = JSON.stringify(linkToken);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Penny-Pincher · Connect bank</title>
    ${FONT_LINKS}
    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <style>${SHARED_AUTH_STYLES}</style>
  </head>
  <body>
    <canvas id="ca-bg" aria-hidden="true"></canvas>
    <div class="stage">
      <header class="top-bar">
        <div class="top-bar-inner">
          <a href="/" class="brand">${BRAND_SVG}<span class="brand-mark">Penny-Pincher</span></a>
          <span class="chip">Plaid Link · Direct</span>
        </div>
      </header>
      <main>
        <div class="label-row">
          <span class="label">§ Auth · step 01 / 02</span>
          <span class="label-aux">handshake · plaid → cli</span>
        </div>
        <h1 class="display-lift">CONNECT</h1>
        <p class="lede">
          Plaid Link should open in a moment.
          <span class="dim">Pick a bank, sign in, and the CLI will pick up the token automatically. You can close this tab when it's done.</span>
        </p>
        <div class="actions">
          <button type="button" id="open" class="btn-primary">Open Plaid Link →</button>
          <span id="status" class="status"><span class="dot"></span><span id="status-text">Initialising</span></span>
        </div>
        <div class="telemetry">
          <span><span class="k">Mode</span><span class="v">Direct · local Plaid creds</span></span>
          <span><span class="k">Tokens</span><span class="v">never persisted</span></span>
          <span><span class="k">Transport</span><span class="v">localhost · loopback</span></span>
        </div>
        <div id="ink" class="ink" hidden>
          <div class="ink-label" id="ink-label">Diagnostic</div>
          <pre id="ink-body"></pre>
        </div>
        <p class="note">
          <span class="accent">▪</span> Trouble? Press <code style="text-transform:none;letter-spacing:0;color:var(--glyph);font-weight:700;">Ctrl-C</code> in your terminal and re-run
          <code style="text-transform:none;letter-spacing:0;color:var(--glyph);font-weight:700;">penny-pincher auth --direct-plaid</code>.
        </p>
      </main>
      <footer>
        <div class="footer-inner">
          <span>▪ Penny-Pincher · navy &amp; ember</span>
          <span>localhost · plaid direct mode</span>
        </div>
      </footer>
    </div>
    <script>
      const statusEl  = document.getElementById("status");
      const statusTxt = document.getElementById("status-text");
      const openBtn   = document.getElementById("open");
      const ink       = document.getElementById("ink");
      const inkLabel  = document.getElementById("ink-label");
      const inkBody   = document.getElementById("ink-body");
      function setStatus(text, kind) {
        statusTxt.textContent = text;
        statusEl.classList.remove("is-success", "is-error", "is-idle");
        if (kind) statusEl.classList.add("is-" + kind);
      }
      function showInk(label, body) {
        inkLabel.textContent = label;
        inkBody.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
        ink.hidden = false;
      }
      setStatus("Opening Plaid Link", null);
      const handler = Plaid.create({
        token: ${serializedLinkToken},
        receivedRedirectUri: window.location.pathname === "/oauth-return" ? window.location.href : undefined,
        onSuccess: async (public_token, metadata) => {
          setStatus("Exchanging token", null);
          try {
            const response = await fetch("/exchange", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ public_token, metadata })
            });
            const body = await response.json();
            if (response.ok) {
              setStatus("Connected · back to your terminal", "success");
            } else {
              setStatus("Token exchange failed", "error");
              showInk("Exchange error", body);
            }
          } catch (err) {
            setStatus("Network error", "error");
            showInk("Exchange error", String(err && err.message ? err.message : err));
          }
        },
        onExit: (error) => {
          if (error) {
            setStatus("Plaid Link error", "error");
            showInk("Plaid onExit", error);
          } else {
            setStatus("Closed · click to reopen", "idle");
          }
        }
      });
      openBtn.addEventListener("click", () => handler.open());
      handler.open();
    </script>
    <script>${CA_BG_SCRIPT}</script>
  </body>
</html>`;
}

function renderHostedWaitingPage(hostedLinkUrl: string): string {
  const serializedHostedLinkUrl = JSON.stringify(hostedLinkUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Penny-Pincher · Redirecting to Plaid Link</title>
    ${FONT_LINKS}
    <style>${SHARED_AUTH_STYLES}</style>
  </head>
  <body>
    <div class="stage">
      <header class="top-bar">
        <div class="top-bar-inner">
          <a href="/" class="brand">${BRAND_SVG}<span class="brand-mark">Penny-Pincher</span></a>
          <span class="chip">Plaid Link · Hosted</span>
        </div>
      </header>
      <main>
        <div class="label-row">
          <span class="label">§ Auth · redirect</span>
          <span class="label-aux">cli → hosted broker</span>
        </div>
        <h1 class="display-lift">REDIRECT</h1>
        <p class="lede">
          Sending you to the hosted Penny-Pincher Plaid Link page.
          <span class="dim">Leave this local callback tab open until auth completes — your terminal will pick up the token as soon as Plaid hands it back.</span>
        </p>
        <div class="actions">
          <a id="link" href="#" class="btn-primary">Open Plaid Link →</a>
          <span class="status"><span class="dot"></span>Forwarding</span>
        </div>
        <p class="note"><span class="accent">▪</span> If nothing happens, use the button above.</p>
      </main>
      <footer>
        <div class="footer-inner">
          <span>▪ Penny-Pincher · navy &amp; ember</span>
          <span>localhost · hosted broker mode</span>
        </div>
      </footer>
    </div>
    <script>
      const url = ${serializedHostedLinkUrl};
      document.getElementById("link").href = url;
      window.location.href = url;
    </script>
  </body>
</html>`;
}

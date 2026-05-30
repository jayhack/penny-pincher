import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import open from "open";
import {
  configPath,
  type LinkedAccountItem,
  loadConfig,
  normalizePlaidEnvironment,
  saveConfig,
  upsertLinkedItem
} from "./config.js";
import {
  createHostedLinkToken,
  defaultBackendUrl,
  exchangeHostedPublicToken,
  resolveBackendUrl
} from "./backend.js";
import { generateSigningKeyPair } from "./crypto.js";
import { getAccountGroups, getStatus } from "./data.js";

export interface DashboardOptions {
  port: number;
  openBrowser: boolean;
}

export interface DashboardServer {
  url: string;
  server: Server;
  opened: boolean;
  openError?: string;
}

interface DashboardAuthSession {
  backendUrl: string;
  publicKeyPem: string;
  privateKeyPem: string;
  environment: "sandbox" | "development" | "production";
  products: string[];
  countryCodes: string[];
  timeout: ReturnType<typeof setTimeout>;
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const app = express();
  const authSessions = new Map<string, DashboardAuthSession>();

  app.use(express.json());
  app.use((request, response, next) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  });

  app.get("/", (_request, response) => {
    response.type("html").send(renderDashboardPage());
  });

  app.get("/connect", async (request, response) => {
    try {
      const { url } = await createDashboardAuthSession({
        port: options.port,
        sessions: authSessions,
        products: stringListQuery(request.query.products),
        countryCodes: stringListQuery(request.query.country_codes ?? request.query.countryCodes),
        environment: stringQuery(request.query.env)
      });
      response.redirect(url);
    } catch (error) {
      response
        .status(500)
        .type("html")
        .send(renderConnectErrorPage(error instanceof Error ? error.message : "Unable to start bank connection."));
    }
  });

  app.post("/exchange", async (request, response) => {
    try {
      const sessionId = stringQuery(request.query.session);
      const session = sessionId ? authSessions.get(sessionId) : undefined;
      const publicToken = request.body?.public_token;

      if (!sessionId || !session) {
        response.status(400).json({ error: "Missing or expired dashboard auth session." });
        return;
      }

      if (!publicToken || typeof publicToken !== "string") {
        response.status(400).json({ error: "Missing public_token" });
        return;
      }

      const exchange = await exchangeHostedPublicToken(
        session.backendUrl,
        {
          publicToken,
          publicKeyPem: session.publicKeyPem,
          environment: session.environment,
          products: session.products,
          countryCodes: session.countryCodes,
          metadata: request.body?.metadata
        },
        session.privateKeyPem
      );
      const item: LinkedAccountItem = {
        mode: "hosted",
        environment: exchange.environment,
        backendUrl: session.backendUrl,
        tokenEnvelope: exchange.tokenEnvelope,
        itemId: exchange.itemId,
        institutionName: exchange.institutionName,
        institutionId: exchange.institutionId,
        products: exchange.products,
        countryCodes: exchange.countryCodes
      };
      const config = upsertLinkedItem(await loadConfig(), item);

      await saveConfig(config);
      clearTimeout(session.timeout);
      authSessions.delete(sessionId);
      response.json({
        ok: true,
        dashboardUrl: `http://localhost:${options.port}/`,
        configPath,
        institutionName: config.institutionName,
        environment: config.environment,
        mode: config.mode
      });
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : "Unknown Plaid exchange error"
      });
    }
  });

  app.get("/api/dashboard", async (_request, response) => {
    try {
      response.json({
        ok: true,
        ...(await dashboardPayload())
      });
    } catch (error) {
      response.status(500).json({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : "Unknown dashboard error"
        },
        status: await getStatus().catch(() => undefined)
      });
    }
  });

  const server = await listen(app, options.port);
  const url = `http://localhost:${options.port}`;
  const result: DashboardServer = {
    url,
    server,
    opened: false
  };

  if (options.openBrowser) {
    try {
      await open(url);
      result.opened = true;
    } catch (error) {
      result.openError = error instanceof Error ? error.message : String(error);
    }
  }

  return result;
}

async function createDashboardAuthSession(options: {
  port: number;
  sessions: Map<string, DashboardAuthSession>;
  products?: string[];
  countryCodes?: string[];
  environment?: string;
}) {
  const existingConfig = await loadConfig();
  const keyPair =
    existingConfig.publicKeyPem && existingConfig.privateKeyPem
      ? {
          publicKeyPem: existingConfig.publicKeyPem,
          privateKeyPem: existingConfig.privateKeyPem
        }
      : generateSigningKeyPair();
  const environment = normalizePlaidEnvironment(options.environment ?? existingConfig.environment);
  const products = options.products?.length ? options.products : existingConfig.products;
  const countryCodes = options.countryCodes?.length ? options.countryCodes : existingConfig.countryCodes;
  const backendUrl = resolveBackendUrl(existingConfig.backendUrl ?? defaultBackendUrl);
  const redirectUri = shouldUseHostedRedirectUri(backendUrl)
    ? new URL("/oauth-return", backendUrl).toString()
    : undefined;

  await saveConfig({
    ...existingConfig,
    mode: "hosted",
    environment,
    backendUrl,
    publicKeyPem: keyPair.publicKeyPem,
    privateKeyPem: keyPair.privateKeyPem
  });

  const link = await createHostedLinkToken(backendUrl, {
    publicKeyPem: keyPair.publicKeyPem,
    environment,
    products,
    countryCodes,
    redirectUri
  });
  const sessionId = randomUUID();
  const timeout = setTimeout(() => {
    options.sessions.delete(sessionId);
  }, 10 * 60 * 1000);
  const session: DashboardAuthSession = {
    backendUrl,
    publicKeyPem: keyPair.publicKeyPem,
    privateKeyPem: keyPair.privateKeyPem,
    environment,
    products,
    countryCodes,
    timeout
  };

  options.sessions.set(sessionId, session);

  return {
    url: createHostedLinkUrl(
      backendUrl,
      link.linkToken,
      `http://localhost:${options.port}/exchange?session=${encodeURIComponent(sessionId)}`
    )
  };
}

function createHostedLinkUrl(backendUrl: string, linkToken: string, callbackUrl: string): string {
  const url = new URL("/connect", backendUrl);
  url.searchParams.set("link_token", linkToken);
  url.searchParams.set("callback", callbackUrl);
  return url.toString();
}

function shouldUseHostedRedirectUri(backendUrl: string): boolean {
  const hostname = new URL(backendUrl).hostname;
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

function stringQuery(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return stringQuery(value[0]);
  }

  return undefined;
}

function stringListQuery(value: unknown): string[] | undefined {
  const text = stringQuery(value);

  if (!text) {
    return undefined;
  }

  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function dashboardPayload() {
  const status = await getStatus();
  const accountGroups = status.linked ? await getAccountGroups() : [];

  return {
    status,
    configPath,
    generatedAt: new Date().toISOString(),
    accountGroups,
    accounts: accountGroups.flatMap((group) => group.accounts)
  };
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on("error", reject);
  });
}

function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Penny-Pincher Dashboard</title>
    ${FONT_LINKS}
    <style>${DASHBOARD_STYLES}</style>
  </head>
  <body>
    <canvas id="ca-bg" aria-hidden="true"></canvas>
    <div class="stage">
      <header class="top-bar">
        <div class="top-bar-inner">
          <a href="/" class="brand-link" style="text-decoration:none;">
            ${BRAND_SVG}
            <span class="brand-display">PENNY-PINCHER</span>
          </a>
          <div class="nav-actions">
            <button type="button" id="refresh" class="btn-secondary" aria-label="Refresh accounts" title="Refresh accounts">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <path d="M20 4v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main>
        <section class="dashboard-section dashboard-section-first" aria-labelledby="institutions-heading">
          <div class="section-head linked-head">
            <div class="section-title-row">
              <h1 class="section-title" id="institutions-heading">Linked Institutions</h1>
              <a href="/connect" class="btn-primary btn-compact" id="add-institution" title="Add account">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <span>Add Account</span>
              </a>
            </div>
          </div>
          <div id="error" class="error-box" hidden></div>
          <div class="institutions" id="institutions"></div>
        </section>

        <section class="dashboard-section" aria-labelledby="accounts-heading">
          <div class="section-head">
            <h2 class="label glyph-cell" id="accounts-heading">Current Accounts</h2>
            <span class="mono-up label-aux" id="account-summary">balances · masks · account ids</span>
          </div>
          <div id="accounts" class="provider-list" data-testid="accounts-grid"></div>
          <div id="empty" class="empty panel" hidden>
            <div>
              <strong>No linked accounts found</strong>
              <span>Connect a bank account, then refresh this dashboard.</span>
              <code class="mono">penny-pincher auth</code>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div class="footer-inner">
          <span class="mono-up">Penny-Pincher · navy &amp; ember</span>
          <span class="mono-up">automata vibe · local dashboard</span>
        </div>
      </footer>
    </div>

    <script>
      const state = {
        loading: false
      };

      const els = {
        refresh: document.getElementById("refresh"),
        error: document.getElementById("error"),
        accountSummary: document.getElementById("account-summary"),
        statusPill: document.getElementById("status-pill"),
        statusText: document.getElementById("status-text"),
        institutions: document.getElementById("institutions"),
        accounts: document.getElementById("accounts"),
        empty: document.getElementById("empty")
      };

      els.refresh.addEventListener("click", loadDashboard);
      loadDashboard();

      async function loadDashboard() {
        if (state.loading) return;
        state.loading = true;
        els.refresh.disabled = true;
        setStatus("Loading accounts", "loading");
        hideError();

        try {
          const response = await fetch("/api/dashboard", { cache: "no-store" });
          const body = await response.json();

          if (!response.ok || !body.ok) {
            throw new Error(body && body.error && body.error.message ? body.error.message : "Dashboard request failed");
          }

          renderDashboard(body);
          setStatus(body.status && body.status.linked ? "Connected" : "Not linked", body.status && body.status.linked ? "ready" : "error");
        } catch (error) {
          showError(error && error.message ? error.message : String(error));
          setStatus("Unable to load accounts", "error");
        } finally {
          state.loading = false;
          els.refresh.disabled = false;
        }
      }

      function renderDashboard(payload) {
        const status = payload.status || {};
        const groups = Array.isArray(payload.accountGroups) ? payload.accountGroups : [];
        const accounts = groups.flatMap((group) => Array.isArray(group.accounts) ? group.accounts : []);

        els.accountSummary.textContent = accountSummaryText(accounts.length, payload.generatedAt);

        renderInstitutions(groups, status);
        renderAccounts(groups);
      }

      function renderInstitutions(groups, status) {
        els.institutions.replaceChildren();
        const items = groups.length ? groups.map((group) => group.item || {}) : Array.isArray(status.items) ? status.items : [];

        for (const item of items) {
          const chip = document.createElement("div");
          chip.className = "institution panel";
          const name = document.createElement("span");
          name.textContent = item.institutionName || item.institutionId || "Linked institution";
          chip.append(name);
          els.institutions.append(chip);
        }
      }

      function renderAccounts(groups) {
        els.accounts.replaceChildren();
        let count = 0;

        for (const [index, group] of groups.entries()) {
          const item = group.item || {};
          const accounts = Array.isArray(group.accounts) ? group.accounts : [];

          if (accounts.length > 0) {
            count += accounts.length;
            els.accounts.append(renderProviderGroup(group, item, accounts, index));
          }
        }

        els.empty.hidden = count !== 0;
      }

      function renderProviderGroup(group, item, accounts, index) {
        const section = document.createElement("section");
        section.className = "provider-group";
        section.dataset.testid = "provider-group";

        const controlsId = "provider-accounts-" + index;
        const header = document.createElement("button");
        header.type = "button";
        header.className = "provider-toggle";
        header.setAttribute("aria-expanded", "true");
        header.setAttribute("aria-controls", controlsId);

        const nameWrap = document.createElement("span");
        nameWrap.className = "provider-title-wrap";
        const title = document.createElement("span");
        title.className = "provider-title";
        title.textContent = providerName(item);
        const meta = document.createElement("span");
        meta.className = "provider-meta mono-up";
        meta.textContent = providerSummary(item, accounts.length);
        nameWrap.append(title, meta);

        const toggle = document.createElement("span");
        toggle.className = "provider-chevron";
        toggle.setAttribute("aria-hidden", "true");
        toggle.textContent = "−";

        header.append(nameWrap, toggle);

        const accountsWrap = document.createElement("div");
        accountsWrap.className = "account-grid";
        accountsWrap.id = controlsId;

        for (const account of accounts) {
          accountsWrap.append(renderAccount(account || {}, item));
        }

        header.addEventListener("click", () => {
          const expanded = header.getAttribute("aria-expanded") === "true";
          header.setAttribute("aria-expanded", expanded ? "false" : "true");
          accountsWrap.hidden = expanded;
          section.classList.toggle("is-collapsed", expanded);
          toggle.textContent = expanded ? "+" : "−";
        });

        section.append(header, accountsWrap);
        return section;
      }

      function renderAccount(account, item) {
        const article = document.createElement("article");
        article.className = "account panel";
        article.dataset.testid = "account-card";

        const head = document.createElement("div");
        head.className = "account-head";

        const titleWrap = document.createElement("div");
        const title = document.createElement("h3");
        title.className = "account-name";
        title.textContent = account.name || account.official_name || "Account";

        const meta = document.createElement("div");
        meta.className = "account-meta";
        meta.textContent = [
          account.mask ? "ending " + account.mask : "",
          item.institutionName || item.institutionId || ""
        ].filter(Boolean).join(" · ");

        titleWrap.append(title, meta);

        const type = document.createElement("div");
        type.className = "account-type";
        type.textContent = [account.type, account.subtype].filter(Boolean).join(" / ") || "account";

        head.append(titleWrap, type);

        const balances = document.createElement("div");
        balances.className = "balance-row";
        balances.append(
          renderBalance("Current", account.balances && account.balances.current, account.balances && account.balances.iso_currency_code),
          renderBalance("Available", account.balances && account.balances.available, account.balances && account.balances.iso_currency_code)
        );

        const accountId = document.createElement("div");
        accountId.className = "account-id mono";
        accountId.textContent = account.account_id || "";
        accountId.title = account.account_id || "";

        article.append(head, balances, accountId);
        return article;
      }

      function renderBalance(label, value, currencyCode) {
        const box = document.createElement("div");
        box.className = "balance";

        const labelEl = document.createElement("span");
        labelEl.className = "balance-label mono-up";
        labelEl.textContent = label;

        const valueEl = document.createElement("span");
        valueEl.className = "balance-value";
        valueEl.textContent = formatMoney(value, currencyCode);

        box.append(labelEl, valueEl);
        return box;
      }

      function providerName(item) {
        return item.institutionName || item.institutionId || "Linked institution";
      }

      function providerSummary(item, count) {
        const accountText = count === 1 ? "1 account" : count + " accounts";
        return accountText;
      }

      function setStatus(text, stateName) {
        if (els.statusText) {
          els.statusText.textContent = text;
        }

        if (els.statusPill) {
          els.statusPill.dataset.state = stateName;
        }
      }

      function showError(message) {
        els.error.textContent = message;
        els.error.hidden = false;
      }

      function hideError() {
        els.error.textContent = "";
        els.error.hidden = true;
      }

      function formatMoney(value, currencyCode) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return "-";
        }

        try {
          return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: currencyCode || "USD",
            maximumFractionDigits: 2
          }).format(value);
        } catch {
          return String(value);
        }
      }

      function formatDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return value;
        }

        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(date);
      }

      function accountSummaryText(accountCount, generatedAt) {
        const countText = accountCount === 1 ? "1 account" : accountCount + " accounts";
        return generatedAt ? countText + " · updated " + formatDate(generatedAt) : countText;
      }
    </script>
    <script>${CA_BG_SCRIPT}</script>
  </body>
</html>`;
}

function renderConnectErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Penny-Pincher Connect</title>
    ${FONT_LINKS}
    <style>${DASHBOARD_STYLES}</style>
  </head>
  <body>
    <canvas id="ca-bg" aria-hidden="true"></canvas>
    <div class="stage">
      <header class="top-bar">
        <div class="top-bar-inner">
          <a href="/" class="brand-link" style="text-decoration:none;">
            ${BRAND_SVG}
            <span class="brand-display">PENNY-PINCHER</span>
          </a>
          <a href="/" class="btn-gh">Dashboard</a>
        </div>
      </header>
      <main>
        <section class="dashboard-section dashboard-section-first">
          <div class="section-head">
            <h1 class="display-lift section-title">Connect Failed</h1>
          </div>
          <div class="error-box">${escapeHtml(message)}</div>
        </section>
      </main>
    </div>
    <script>${CA_BG_SCRIPT}</script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") {
      return "&amp;";
    }

    if (char === "<") {
      return "&lt;";
    }

    if (char === ">") {
      return "&gt;";
    }

    if (char === "\"") {
      return "&quot;";
    }

    return "&#39;";
  });
}

const FONT_LINKS = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" />
`;

const DASHBOARD_STYLES = `
  :root {
    --paper:     #ffffff;
    --lattice:   #fbf4ec;
    --bloom:     #f0cfab;
    --pulse:     #d08454;
    --spark:     #e04a14;
    --sovereign: #142a5c;
    --deep:      #08163c;
    --glyph:     #0b0f22;
    --stone:     #757e96;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    min-height: 100%;
    background: var(--paper);
    color: var(--glyph);
    font-family: "Inter", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  button { font: inherit; }

  #ca-bg {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    pointer-events: none;
    opacity: 0.30;
  }

  .stage {
    position: relative;
    z-index: 1;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .display-lift {
    font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
    font-weight: 900;
    letter-spacing: -0.025em;
    line-height: 0.9;
    color: var(--glyph);
    text-shadow: none;
  }

  .display-lift-hero {
    text-shadow: none;
  }

  .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }

  .mono-up {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-weight: 500;
  }

  .label {
    margin: 0;
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .glyph-cell::before {
    content: "▪";
    color: var(--spark);
    margin-right: 0.5em;
  }

  .panel {
    background: var(--paper);
    border: 1.5px solid var(--glyph);
    border-radius: 2px;
    box-shadow: none;
  }

  .top-bar {
    position: sticky;
    top: 0;
    z-index: 50;
    border-bottom: 1px solid var(--glyph);
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(12px);
  }

  .top-bar-inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }

  .brand-link {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    color: var(--glyph);
  }

  .brand-link svg {
    flex: 0 0 auto;
  }

  .brand-display {
    font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
    font-weight: 900;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    line-height: 1;
    color: var(--glyph);
    text-shadow:
      2px 2px 0 var(--bloom),
      4px 4px 0 rgba(8, 22, 60, 0.18);
    font-size: clamp(15px, 2.2vw, 20px);
    margin-right: 4px;
    white-space: nowrap;
  }

  .nav-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  .btn-gh {
    background: var(--glyph);
    color: #fff;
    padding: 9px 14px;
    border: 1.5px solid var(--glyph);
    border-radius: 2px;
    font-family: "JetBrains Mono", monospace;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 2px 0 var(--bloom);
    text-decoration: none;
    transition: transform 80ms ease, box-shadow 80ms ease, background 80ms ease;
    cursor: pointer;
  }

  .btn-gh:hover { background: #1a2042; }
  .btn-gh:active { transform: translateY(2px); box-shadow: none; }
  .btn-gh:disabled { opacity: 0.58; cursor: wait; }
  .btn-gh svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
    display: block;
    flex: 0 0 auto;
  }

  .btn-primary {
    background: var(--glyph);
    color: #fff;
    padding: 9px 14px;
    border: 1.5px solid var(--glyph);
    border-radius: 2px;
    font-family: "JetBrains Mono", monospace;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    transition: background 80ms ease, color 80ms ease;
    cursor: pointer;
  }

  .btn-primary:hover {
    background: #1a2042;
  }

  .btn-primary svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
    display: block;
    flex: 0 0 auto;
  }

  .btn-secondary {
    background: var(--paper);
    color: var(--glyph);
    padding: 9px 14px;
    border: 1.5px solid var(--glyph);
    border-radius: 2px;
    font-family: "JetBrains Mono", monospace;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    transition: background 80ms ease, color 80ms ease;
    cursor: pointer;
  }

  .btn-secondary:hover {
    background: var(--lattice);
  }

  .btn-secondary:disabled {
    opacity: 0.58;
    cursor: wait;
  }

  .btn-secondary svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
    display: block;
    flex: 0 0 auto;
  }

  .btn-compact {
    padding: 7px 10px;
    font-size: 10px;
  }

  main {
    flex: 1;
    width: 100%;
    max-width: 1100px;
    margin: 0 auto;
    padding: 36px 24px 64px;
  }

  .label-row,
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }

  .label-aux {
    color: var(--stone);
    font-size: 10px;
  }

  .dashboard-title {
    margin: 0;
    font-size: clamp(3.6rem, 12vw, 8rem);
  }

  .section-title {
    margin: 0;
    font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
    font-weight: 900;
    letter-spacing: -0.015em;
    line-height: 1;
    color: var(--glyph);
    font-size: clamp(1.65rem, 3.4vw, 2.55rem);
    text-shadow: none;
  }

  .section-title-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }

  .hero-meta {
    margin-top: 28px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 24px;
  }

  .hero-meta p {
    max-width: 720px;
    margin: 0;
    font-size: 16px;
    line-height: 1.6;
    font-weight: 500;
  }

  .hero-meta p span {
    color: var(--stone);
  }

  .hero-meta code,
  .empty code {
    font-size: 13px;
    background: var(--lattice);
    padding: 1px 6px;
    border-radius: 2px;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 9px 14px;
    border: 1px solid var(--glyph);
    border-radius: 2px;
    background: var(--paper);
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--glyph);
    white-space: nowrap;
  }

  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 1px;
    background: var(--spark);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .status-pill[data-state="ready"] .status-dot {
    background: var(--sovereign);
    animation: none;
  }

  .status-pill[data-state="error"] .status-dot {
    background: var(--spark);
    animation: none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-dot { animation: none; }
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin: 0 0 46px;
  }

  .metric {
    min-height: 128px;
    padding: 18px;
    display: grid;
    align-content: space-between;
    gap: 18px;
  }

  .metric-top {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }

  .metric-top .mono-up {
    color: var(--stone);
    font-size: 10px;
    text-align: right;
  }

  .step-no {
    font-family: "Archivo Black", sans-serif;
    font-size: 36px;
    line-height: 1;
    color: var(--spark);
  }

  .metric-value {
    min-width: 0;
    font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
    font-size: clamp(1.25rem, 2.2vw, 1.8rem);
    line-height: 1;
    color: var(--glyph);
    overflow-wrap: anywhere;
  }

  .metric-label {
    font-size: 14px;
    line-height: 1.5;
    color: var(--glyph);
  }

  .dashboard-section {
    margin-top: 48px;
  }

  .dashboard-section-first {
    margin-top: 0;
  }

  .institutions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .institution {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    min-height: 42px;
    padding: 9px 12px;
    color: var(--glyph);
    font-size: 13.5px;
    font-weight: 700;
  }

  .institution span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .institution small {
    color: var(--stone);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 500;
  }

  .provider-list {
    display: grid;
    gap: 34px;
  }

  .provider-group {
    display: grid;
    gap: 14px;
  }

  .provider-toggle {
    width: 100%;
    min-height: 54px;
    padding: 0;
    border: 0;
    border-bottom: 1.5px solid var(--glyph);
    background: transparent;
    color: var(--glyph);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    text-align: left;
    cursor: pointer;
  }

  .provider-toggle:hover .provider-title {
    color: var(--sovereign);
  }

  .provider-title-wrap {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-wrap: wrap;
  }

  .provider-title {
    min-width: 0;
    font-family: "Inter", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: clamp(1.35rem, 2.4vw, 1.9rem);
    font-weight: 800;
    line-height: 1.15;
    overflow-wrap: anywhere;
  }

  .provider-meta {
    color: var(--stone);
    font-size: 10px;
  }

  .provider-chevron {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border: 1.5px solid var(--glyph);
    border-radius: 2px;
    display: inline-grid;
    place-items: center;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 17px;
    line-height: 1;
  }

  .provider-group.is-collapsed {
    gap: 0;
  }

  .account-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }

  .account {
    min-height: 190px;
    padding: 18px;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 18px;
  }

  .account-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 14px;
  }

  .account-name {
    margin: 0;
    font-family: "Inter", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: clamp(1.18rem, 2.15vw, 1.55rem);
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: 0;
    color: var(--glyph);
    overflow-wrap: anywhere;
    text-shadow: none;
  }

  .account-meta {
    margin-top: 10px;
    color: var(--stone);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.45;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }

  .account-type {
    max-width: 220px;
    padding: 5px 9px;
    border: 1px solid rgba(11, 15, 34, 0.22);
    border-radius: 2px;
    background: var(--lattice);
    color: var(--glyph);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .balance-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0;
    border-top: 1px solid rgba(11, 15, 34, 0.15);
    border-bottom: 1px solid rgba(11, 15, 34, 0.15);
  }

  .balance {
    min-width: 0;
    padding: 14px 14px 14px 0;
  }

  .balance + .balance {
    border-left: 1px solid rgba(11, 15, 34, 0.15);
    padding-left: 14px;
  }

  .balance-label {
    display: block;
    color: var(--stone);
    font-size: 10px;
    margin-bottom: 7px;
  }

  .balance-value {
    display: block;
    color: var(--glyph);
    font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
    font-size: clamp(1.15rem, 2vw, 1.45rem);
    line-height: 1.05;
    overflow-wrap: anywhere;
  }

  .account-id {
    color: var(--stone);
    font-size: 11px;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    min-height: 220px;
    display: grid;
    place-items: center;
    padding: 28px;
    text-align: center;
  }

  .empty strong {
    display: block;
    margin-bottom: 10px;
    font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
    font-size: 28px;
    line-height: 0.95;
    text-shadow: none;
  }

  .empty span {
    display: block;
    color: var(--stone);
    font-size: 15px;
    line-height: 1.55;
  }

  .empty code {
    display: inline-block;
    margin-top: 14px;
    color: var(--spark);
  }

  .error-box {
    margin-top: 22px;
    background: var(--glyph);
    border: 1.5px solid var(--glyph);
    border-radius: 2px;
    box-shadow: 4px 4px 0 var(--sovereign);
    padding: 16px 18px;
    color: var(--bloom);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12.5px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  footer {
    border-top: 1px solid var(--glyph);
  }

  .footer-inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    color: var(--stone);
    font-size: 10px;
  }

  [hidden] {
    display: none !important;
  }

  @media (max-width: 880px) {
    .summary,
    .account-grid {
      grid-template-columns: 1fr;
    }

    .hero-meta {
      grid-template-columns: 1fr;
      align-items: start;
    }
  }

  @media (max-width: 640px) {
    .top-bar-inner {
      align-items: flex-start;
      flex-direction: column;
    }

    .btn-gh,
    .btn-secondary,
    .btn-primary {
      width: 100%;
      justify-content: center;
    }

    .nav-actions {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr;
    }

    main {
      padding: 30px 18px 50px;
    }

    .label-row,
    .section-head {
      align-items: flex-start;
      flex-direction: column;
      gap: 8px;
    }

    .dashboard-title {
      font-size: clamp(3rem, 18vw, 5rem);
    }

    .metric {
      min-height: 112px;
    }

    .account-head,
    .balance-row {
      grid-template-columns: 1fr;
    }

    .provider-toggle {
      align-items: flex-start;
      padding-bottom: 12px;
    }

    .provider-title-wrap {
      display: grid;
      gap: 6px;
    }

    .account-type {
      max-width: 100%;
      justify-self: start;
    }

    .balance + .balance {
      border-left: 0;
      border-top: 1px solid rgba(11, 15, 34, 0.15);
      padding-left: 0;
    }
  }
`;

const BRAND_SVG = `
  <svg viewBox="0 0 36 36" width="28" height="28" aria-hidden="true">
    <g fill="#F0CFAB">
      <rect x="0" y="0" width="8" height="8" rx="1"/><rect x="9" y="0" width="8" height="8" rx="1"/>
      <rect x="27" y="0" width="8" height="8" rx="1"/><rect x="18" y="9" width="8" height="8" rx="1"/>
      <rect x="0" y="18" width="8" height="8" rx="1"/><rect x="18" y="18" width="8" height="8" rx="1"/>
      <rect x="27" y="18" width="8" height="8" rx="1"/><rect x="9" y="27" width="8" height="8" rx="1"/>
      <rect x="18" y="27" width="8" height="8" rx="1"/>
    </g>
    <g fill="#E04A14">
      <rect x="18" y="0" width="8" height="8" rx="1"/><rect x="9" y="9" width="8" height="8" rx="1"/>
      <rect x="9" y="18" width="8" height="8" rx="1"/><rect x="0" y="27" width="8" height="8" rx="1"/>
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
      if (generation % 80 === 0) for (let i = 0; i < grid.length; i++) if (Math.random() < 0.05) grid[i] = 1;
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

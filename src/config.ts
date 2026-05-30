import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const plaidEnvironments = ["sandbox", "development", "production"] as const;
export type PlaidEnvironment = (typeof plaidEnvironments)[number];

const linkedAccountModeSchema = z.enum(["hosted", "direct"]);
const linkedAccountItemSchema = z.object({
  mode: linkedAccountModeSchema,
  environment: z.enum(plaidEnvironments),
  backendUrl: z.string().url().optional(),
  tokenEnvelope: z.string().optional(),
  accessToken: z.string().optional(),
  itemId: z.string().optional(),
  institutionName: z.string().optional(),
  institutionId: z.string().optional(),
  products: z.array(z.string()).default(["transactions"]),
  countryCodes: z.array(z.string()).default(["US"]),
  linkedAt: z.string().optional(),
  updatedAt: z.string().optional()
});

const configSchema = z.object({
  environment: z.enum(plaidEnvironments).default("production"),
  mode: linkedAccountModeSchema.default("hosted"),
  backendUrl: z.string().url().optional(),
  items: z.array(linkedAccountItemSchema).default([]),
  tokenEnvelope: z.string().optional(),
  publicKeyPem: z.string().optional(),
  privateKeyPem: z.string().optional(),
  accessToken: z.string().optional(),
  itemId: z.string().optional(),
  institutionName: z.string().optional(),
  institutionId: z.string().optional(),
  products: z.array(z.string()).default(["transactions"]),
  countryCodes: z.array(z.string()).default(["US"]),
  stripeCustomerId: z.string().optional(),
  stripeSubscriptionId: z.string().optional(),
  billingStatus: z.string().optional(),
  billingCurrentPeriodStart: z.string().optional(),
  billingCurrentPeriodEnd: z.string().optional(),
  updatedAt: z.string().optional()
});

export type PennyPincherConfig = z.infer<typeof configSchema>;
export type LinkedAccountItem = z.infer<typeof linkedAccountItemSchema>;

export const configDir = join(homedir(), ".penny-pincher");
export const configPath = join(configDir, "config.json");
const legacyConfigPaths = [
  join(homedir(), ".penny-pincer", "config.json"),
  join(homedir(), ".finclaw", "config.json")
];

export async function loadConfig(): Promise<PennyPincherConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return normalizeConfig(configSchema.parse(JSON.parse(raw)));
  } catch (error) {
    if (isMissingFileError(error)) {
      return loadLegacyConfig();
    }

    throw error;
  }
}

export async function saveConfig(config: PennyPincherConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(configPath), 0o700).catch(() => undefined);

  const parsed = normalizeConfig(configSchema.parse({
    ...config,
    updatedAt: new Date().toISOString()
  }));
  const tempPath = `${configPath}.${process.pid}.tmp`;

  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, configPath);
  await chmod(configPath, 0o600).catch(() => undefined);
}

export async function hasConfigFile(): Promise<boolean> {
  try {
    await access(configPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function clearLinkedAccount(): Promise<void> {
  const config = await loadConfig();
  const {
    accessToken,
    tokenEnvelope,
    items,
    itemId,
    institutionName,
    institutionId,
    ...rest
  } = config;
  void accessToken;
  void tokenEnvelope;
  void items;
  void itemId;
  void institutionName;
  void institutionId;
  await saveConfig({
    ...rest,
    items: []
  });
}

export function getLinkedItems(config: PennyPincherConfig): LinkedAccountItem[] {
  return normalizeConfig(config).items;
}

export function upsertLinkedItem(config: PennyPincherConfig, item: LinkedAccountItem): PennyPincherConfig {
  const now = new Date().toISOString();
  const normalized = normalizeConfig(config);
  const nextItem = linkedAccountItemSchema.parse({
    ...item,
    linkedAt: item.linkedAt ?? now,
    updatedAt: now
  });
  const items = normalized.items.filter((existingItem) => !isSameLinkedItem(existingItem, nextItem));

  return normalizeConfig({
    ...normalized,
    items: [...items, nextItem]
  });
}

export function normalizePlaidEnvironment(value: string | undefined): PlaidEnvironment {
  const environment = value ?? "production";

  if (environment === "prod") {
    return "production";
  }

  if (!plaidEnvironments.includes(environment as PlaidEnvironment)) {
    throw new Error(`Invalid Plaid environment "${environment}". Use sandbox, development, or production.`);
  }

  return environment as PlaidEnvironment;
}

async function loadLegacyConfig(): Promise<PennyPincherConfig> {
  for (const legacyPath of legacyConfigPaths) {
    try {
      const raw = await readFile(legacyPath, "utf8");
      const config = normalizeConfig(configSchema.parse(JSON.parse(raw)));
      await saveConfig(config);
      return config;
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }

      throw error;
    }
  }

  return configSchema.parse({});
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeConfig(config: PennyPincherConfig): PennyPincherConfig {
  let items = config.items.map((item) => linkedAccountItemSchema.parse(item));
  const legacyItem = legacyItemFromConfig(config);

  if (legacyItem && !items.some((item) => isSameLinkedItem(item, legacyItem))) {
    items = [...items, legacyItem];
  }

  const primary = items.at(-1);
  if (!primary) {
    return {
      ...config,
      items
    };
  }

  return {
    ...config,
    mode: primary.mode,
    environment: primary.environment,
    backendUrl: primary.backendUrl ?? config.backendUrl,
    items,
    tokenEnvelope: primary.tokenEnvelope,
    accessToken: primary.accessToken,
    itemId: primary.itemId,
    institutionName: primary.institutionName,
    institutionId: primary.institutionId,
    products: primary.products,
    countryCodes: primary.countryCodes
  };
}

function legacyItemFromConfig(config: PennyPincherConfig): LinkedAccountItem | undefined {
  if (config.tokenEnvelope) {
    return linkedAccountItemSchema.parse({
      mode: "hosted",
      environment: config.environment,
      backendUrl: config.backendUrl,
      tokenEnvelope: config.tokenEnvelope,
      itemId: config.itemId,
      institutionName: config.institutionName,
      institutionId: config.institutionId,
      products: config.products,
      countryCodes: config.countryCodes,
      linkedAt: config.updatedAt,
      updatedAt: config.updatedAt
    });
  }

  if (config.accessToken) {
    return linkedAccountItemSchema.parse({
      mode: "direct",
      environment: config.environment,
      accessToken: config.accessToken,
      itemId: config.itemId,
      institutionName: config.institutionName,
      institutionId: config.institutionId,
      products: config.products,
      countryCodes: config.countryCodes,
      linkedAt: config.updatedAt,
      updatedAt: config.updatedAt
    });
  }

  return undefined;
}

function isSameLinkedItem(left: LinkedAccountItem, right: LinkedAccountItem): boolean {
  if (left.itemId && right.itemId) {
    return left.itemId === right.itemId;
  }

  if (left.tokenEnvelope && right.tokenEnvelope) {
    return left.tokenEnvelope === right.tokenEnvelope;
  }

  if (left.accessToken && right.accessToken) {
    return left.accessToken === right.accessToken;
  }

  return false;
}

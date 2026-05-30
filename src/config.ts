import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const plaidEnvironments = ["sandbox", "development", "production"] as const;
export type PlaidEnvironment = (typeof plaidEnvironments)[number];

const configSchema = z.object({
  environment: z.enum(plaidEnvironments).default("production"),
  mode: z.enum(["hosted", "direct"]).default("hosted"),
  backendUrl: z.string().url().optional(),
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

export const configDir = join(homedir(), ".penny-pincher");
export const configPath = join(configDir, "config.json");
const legacyConfigPaths = [
  join(homedir(), ".penny-pincer", "config.json"),
  join(homedir(), ".finclaw", "config.json")
];

export async function loadConfig(): Promise<PennyPincherConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return configSchema.parse(JSON.parse(raw));
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

  const parsed = configSchema.parse({
    ...config,
    updatedAt: new Date().toISOString()
  });
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
    itemId,
    institutionName,
    institutionId,
    ...rest
  } = config;
  void accessToken;
  void tokenEnvelope;
  void itemId;
  void institutionName;
  void institutionId;
  await saveConfig(rest);
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
      const config = configSchema.parse(JSON.parse(raw));
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

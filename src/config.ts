import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const plaidEnvironments = ["sandbox", "development", "production"] as const;
export type PlaidEnvironment = (typeof plaidEnvironments)[number];

const configSchema = z.object({
  environment: z.enum(plaidEnvironments).default("sandbox"),
  accessToken: z.string().optional(),
  itemId: z.string().optional(),
  institutionName: z.string().optional(),
  institutionId: z.string().optional(),
  products: z.array(z.string()).default(["transactions"]),
  countryCodes: z.array(z.string()).default(["US"]),
  updatedAt: z.string().optional()
});

export type FinclawConfig = z.infer<typeof configSchema>;

export const configDir = join(homedir(), ".finclaw");
export const configPath = join(configDir, "config.json");

export async function loadConfig(): Promise<FinclawConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return configSchema.parse({});
    }

    throw error;
  }
}

export async function saveConfig(config: FinclawConfig): Promise<void> {
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
  const { accessToken, itemId, institutionName, institutionId, ...rest } = config;
  void accessToken;
  void itemId;
  void institutionName;
  void institutionId;
  await saveConfig(rest);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

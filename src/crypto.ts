import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify
} from "node:crypto";

const envelopePrefix = "fclw1";

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface SignedRequest<TPayload = unknown> {
  payload: TPayload;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface TokenEnvelopePayload {
  accessToken: string;
  itemId: string;
  environment: "sandbox" | "development" | "production";
  products: string[];
  countryCodes: string[];
  publicKeyPem: string;
  institutionName?: string;
  institutionId?: string;
  issuedAt: string;
  keyVersion: string;
}

export function generateSigningKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey
  };
}

export function createSignedRequest<TPayload>(
  options: {
    method: string;
    path: string;
    payload: TPayload;
    privateKeyPem: string;
  }
): SignedRequest<TPayload> {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const canonical = canonicalRequest({
    method: options.method,
    path: options.path,
    payload: options.payload,
    timestamp,
    nonce
  });

  return {
    payload: options.payload,
    timestamp,
    nonce,
    signature: sign(null, Buffer.from(canonical), options.privateKeyPem).toString("base64url")
  };
}

export function verifySignedRequest<TPayload>(
  options: {
    method: string;
    path: string;
    request: SignedRequest<TPayload>;
    publicKeyPem: string;
    maxSkewMs?: number;
  }
): void {
  const timestampMs = Date.parse(options.request.timestamp);

  if (!Number.isFinite(timestampMs)) {
    throw new Error("Invalid request timestamp.");
  }

  const maxSkewMs = options.maxSkewMs ?? 5 * 60 * 1000;
  if (Math.abs(Date.now() - timestampMs) > maxSkewMs) {
    throw new Error("Request timestamp is outside the allowed window.");
  }

  const canonical = canonicalRequest({
    method: options.method,
    path: options.path,
    payload: options.request.payload,
    timestamp: options.request.timestamp,
    nonce: options.request.nonce
  });
  const ok = verify(
    null,
    Buffer.from(canonical),
    options.publicKeyPem,
    Buffer.from(options.request.signature, "base64url")
  );

  if (!ok) {
    throw new Error("Invalid request signature.");
  }
}

export function encryptTokenEnvelope(payload: TokenEnvelopePayload, secret: string): string {
  const key = deriveEncryptionKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    envelopePrefix,
    payload.keyVersion,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url")
  ].join(".");
}

export function decryptTokenEnvelope(token: string, secret: string): TokenEnvelopePayload {
  const [prefix, keyVersion, iv, ciphertext, tag] = token.split(".");

  if (prefix !== envelopePrefix || !keyVersion || !iv || !ciphertext || !tag) {
    throw new Error("Invalid Penny Pincher token envelope.");
  }

  const decipher = createDecipheriv("aes-256-gcm", deriveEncryptionKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final()
  ]);
  const payload = JSON.parse(plaintext.toString("utf8")) as TokenEnvelopePayload;

  if (payload.keyVersion !== keyVersion) {
    throw new Error("Penny Pincher token key version mismatch.");
  }

  return payload;
}

function canonicalRequest(options: {
  method: string;
  path: string;
  payload: unknown;
  timestamp: string;
  nonce: string;
}): string {
  return [
    options.method.toUpperCase(),
    options.path,
    options.timestamp,
    options.nonce,
    stableStringify(options.payload)
  ].join("\n");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function deriveEncryptionKey(secret: string): Buffer {
  if (!secret) {
    throw new Error("Missing PENNY_PINCHER_ENCRYPTION_KEY.");
  }

  const decoded = decodePotentialBase64Key(secret);
  if (decoded?.length === 32) {
    return decoded;
  }

  return createHash("sha256").update(secret).digest();
}

function decodePotentialBase64Key(secret: string): Buffer | undefined {
  try {
    return Buffer.from(secret, "base64url");
  } catch {
    return undefined;
  }
}

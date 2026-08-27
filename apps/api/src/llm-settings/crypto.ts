import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = "v1";

export function encryptApiKey(value: string): string {
  const key = loadEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptApiKey(envelope: string): string {
  const [version, encodedIv, encodedTag, encodedValue] = envelope.split(":");
  if (version !== ENVELOPE_VERSION || !encodedIv || !encodedTag || !encodedValue) {
    throw new Error("Invalid encrypted API key envelope");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadEncryptionKey(),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encodedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function loadEncryptionKey(): Buffer {
  const encoded = process.env.LLM_SETTINGS_ENCRYPTION_KEY?.trim();
  if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded)) {
    throw new Error("LLM_SETTINGS_ENCRYPTION_KEY must contain 64 hexadecimal characters");
  }
  return Buffer.from(encoded, "hex");
}

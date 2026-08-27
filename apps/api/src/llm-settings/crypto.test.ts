import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { decryptApiKey, encryptApiKey } from "./crypto";

const originalEncryptionKey = process.env.LLM_SETTINGS_ENCRYPTION_KEY;

describe("LLM settings encryption", () => {
  beforeEach(() => {
    process.env.LLM_SETTINGS_ENCRYPTION_KEY = "1".repeat(64);
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.LLM_SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.LLM_SETTINGS_ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  it("decrypts an encrypted API key", () => {
    const encrypted = encryptApiKey("secret-api-key");

    expect(encrypted).not.toContain("secret-api-key");
    expect(decryptApiKey(encrypted)).toBe("secret-api-key");
  });

  it("rejects a modified encrypted value", () => {
    const encrypted = encryptApiKey("secret-api-key");
    const parts = encrypted.split(":");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    const modified = parts.join(":");

    expect(() => decryptApiKey(modified)).toThrow();
  });
});

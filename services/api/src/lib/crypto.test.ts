import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./crypto.js";

describe("AES-GCM token encryption", () => {
  const hexKey = crypto.randomBytes(32).toString("hex");

  it("encrypts and decrypts a token round-trip", () => {
    const plaintext = "gho_superSecretGitHubToken123";
    const encrypted = encryptToken(plaintext, hexKey);

    expect(encrypted).not.toContain(plaintext);
    expect(encrypted.split(":")).toHaveLength(3);
    expect(decryptToken(encrypted, hexKey)).toBe(plaintext);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptToken("gho_secret", hexKey);
    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:00${parts[2]?.slice(2) ?? ""}`;

    expect(() => decryptToken(tampered, hexKey)).toThrow();
  });

  it("supports 32-byte UTF-8 keys and rejects invalid key lengths", () => {
    const utf8Key = "12345678901234567890123456789012";
    const encrypted = encryptToken("abc", utf8Key);
    expect(decryptToken(encrypted, utf8Key)).toBe("abc");

    expect(() => encryptToken("abc", "too-short")).toThrow();
  });
});


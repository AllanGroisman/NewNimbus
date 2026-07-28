// Testes da cifra dos dumps (AES-256-GCM, header NIMBUSENC1).
// Backend puro — manipula BACKUP_ENC_KEY no env e restaura ao final.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backupCrypto = require(
  path.resolve(__dirname, "..", "..", "backend", "scripts", "backup-crypto.js")
);

const KEY = "a".repeat(64); // 32 bytes em hex
const ORIGINAL_KEY = process.env.BACKUP_ENC_KEY;

beforeEach(() => {
  process.env.BACKUP_ENC_KEY = KEY;
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BACKUP_ENC_KEY;
  else process.env.BACKUP_ENC_KEY = ORIGINAL_KEY;
});

describe("backup-crypto", () => {
  it("roundtrip: encrypt + decrypt devolve o conteúdo original", () => {
    const plain = Buffer.from("dump de teste — conteúdo sensível 🗄️");
    const enc = backupCrypto.encryptBuffer(plain);
    expect(enc.equals(plain)).toBe(false);
    expect(backupCrypto.decryptBuffer(enc).equals(plain)).toBe(true);
  });

  it("looksEncrypted reconhece o header e rejeita gzip comum", () => {
    const enc = backupCrypto.encryptBuffer(Buffer.from("x"));
    expect(backupCrypto.looksEncrypted(enc)).toBe(true);
    // Um .sql.gz começa com o magic do gzip, não com NIMBUSENC1.
    expect(backupCrypto.looksEncrypted(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]))).toBe(false);
    expect(backupCrypto.looksEncrypted("não é buffer")).toBe(false);
  });

  it("conteúdo adulterado falha na autenticação (GCM)", () => {
    const enc = backupCrypto.encryptBuffer(Buffer.from("conteúdo íntegro"));
    enc[enc.length - 1] ^= 0xff; // corrompe o último byte do ciphertext
    expect(() => backupCrypto.decryptBuffer(enc)).toThrow();
  });

  it("sem BACKUP_ENC_KEY: isEnabled=false e encrypt/decrypt lançam", () => {
    delete process.env.BACKUP_ENC_KEY;
    expect(backupCrypto.isEnabled()).toBe(false);
    expect(() => backupCrypto.encryptBuffer(Buffer.from("x"))).toThrow(/BACKUP_ENC_KEY/);
    const enc = Buffer.concat([Buffer.from("NIMBUSENC1"), Buffer.alloc(40)]);
    expect(() => backupCrypto.decryptBuffer(enc)).toThrow(/BACKUP_ENC_KEY/);
  });

  it("chave com tamanho errado → erro claro", () => {
    process.env.BACKUP_ENC_KEY = "abc123"; // 3 bytes
    expect(() => backupCrypto.encryptBuffer(Buffer.from("x"))).toThrow(/inválida/);
  });
});

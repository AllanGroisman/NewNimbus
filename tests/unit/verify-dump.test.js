// Testes da validação de dump (gunzip íntegro + marcador de fim do pg_dump).
// Backend puro — escreve .sql.gz sintéticos num diretório temporário.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { verifyDumpFile } = require(
  path.resolve(__dirname, "..", "..", "backend", "backup", "verify-dump.js")
);

// Imita o fim real do pg_dump 16: marcador seguido do \unrestrict.
const COMPLETE_SQL =
  "-- PostgreSQL database dump\n" +
  "COPY public.users (id) FROM stdin;\n1\n\\.\n".repeat(2000) +
  "\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc123\n\n";

let dir;
const write = (name, buf) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-dump-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("verifyDumpFile", () => {
  it("aceita dump completo", async () => {
    const p = write("ok.sql.gz", zlib.gzipSync(COMPLETE_SQL));
    await expect(verifyDumpFile(p)).resolves.toMatchObject({ bytes: Buffer.byteLength(COMPLETE_SQL) });
  });

  it("rejeita gzip truncado (pg_dump morreu no meio da escrita)", async () => {
    const gz = zlib.gzipSync(COMPLETE_SQL);
    const p = write("cut.sql.gz", gz.subarray(0, Math.floor(gz.length / 2)));
    await expect(verifyDumpFile(p)).rejects.toThrow(/truncado\/corrompido/);
  });

  it("rejeita gzip válido sem o marcador de fim", async () => {
    const partialSql = COMPLETE_SQL.slice(0, COMPLETE_SQL.indexOf("-- PostgreSQL database dump complete"));
    const p = write("nofooter.sql.gz", zlib.gzipSync(partialSql));
    await expect(verifyDumpFile(p)).rejects.toThrow(/marcador de fim/);
  });

  it("rejeita gzip vazio (pg_dump falhou antes de escrever)", async () => {
    const p = write("empty.sql.gz", zlib.gzipSync(""));
    await expect(verifyDumpFile(p)).rejects.toThrow(/marcador de fim/);
  });

  it("rejeita arquivo inexistente", async () => {
    await expect(verifyDumpFile(path.join(dir, "nope.sql.gz"))).rejects.toThrow(/truncado\/corrompido/);
  });

  it("aceita o marcador mesmo quando cai na fronteira entre chunks", async () => {
    // Força muitos chunks pequenos de saída do gunzip.
    const big = "x".repeat(200_000) + "\n-- PostgreSQL database dump complete\n" + "y".repeat(100);
    const p = write("big.sql.gz", zlib.gzipSync(big));
    await expect(verifyDumpFile(p)).resolves.toBeTruthy();
  });
});

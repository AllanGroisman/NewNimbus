// Testes do expurgo de versões no bucket versionado (B2). Sem rede: o S3Client é
// substituído por um fake que responde ao ListObjectVersions/DeleteObjects.
//
// O que protege: a versão VIVA de cada backup nunca pode entrar na lista de delete
// (senão o expurgo apagaria os backups em vez do lixo), e os hide markers precisam
// entrar (são eles que seguram os bytes no cap da conta).

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { listPurgeable, purgeOldVersions, purgeKey } = require(
  path.resolve(__dirname, "..", "..", "backend", "scripts", "purge-remote-versions.js")
);

const { selectUploads } = require(
  path.resolve(__dirname, "..", "..", "backend", "scripts", "backup-remote.js")
);

// Client fake: devolve as páginas na ordem e grava os deletes recebidos.
function fakeClient(pages) {
  const deleted = [];
  return {
    deleted,
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "ListObjectVersionsCommand") {
        const page = pages.shift() || {};
        return page;
      }
      if (name === "DeleteObjectsCommand") {
        deleted.push(...cmd.input.Delete.Objects);
        return {};
      }
      throw new Error(`comando inesperado: ${name}`);
    },
  };
}

const V = (Key, VersionId, IsLatest, Size = 1024) => ({ Key, VersionId, IsLatest, Size });

describe("listPurgeable", () => {
  it("pega versões antigas e hide markers, nunca a versão viva", async () => {
    const client = fakeClient([{
      Versions: [
        V("nimbus/db-20260817-070001.sql.gz.enc", "v3", true),
        V("nimbus/db-20260817-070001.sql.gz.enc", "v2", false),
        V("nimbus/db-20260601-070001.sql.gz.enc", "v1", false, 2048),
      ],
      DeleteMarkers: [{ Key: "nimbus/db-20260601-070001.sql.gz.enc", VersionId: "m1" }],
    }]);

    const out = await listPurgeable(client, { bucket: "b", prefix: "nimbus/" });

    expect(out.versions).toBe(2);
    expect(out.markers).toBe(1);
    expect(out.bytes).toBe(1024 + 2048);
    expect(out.items.map(i => i.VersionId).sort()).toEqual(["m1", "v1", "v2"]);
    expect(out.items.some(i => i.VersionId === "v3")).toBe(false);
  });

  it("segue a paginação até o fim", async () => {
    const client = fakeClient([
      {
        Versions: [V("nimbus/a", "v1", false)],
        IsTruncated: true,
        NextKeyMarker: "nimbus/a",
        NextVersionIdMarker: "v1",
      },
      { Versions: [V("nimbus/b", "v2", false)] },
    ]);

    const out = await listPurgeable(client, { bucket: "b", prefix: "nimbus/" });

    expect(out.items.map(i => i.VersionId)).toEqual(["v1", "v2"]);
  });
});

describe("purgeOldVersions", () => {
  it("não apaga nada em dry-run", async () => {
    const client = fakeClient([{ Versions: [V("nimbus/a", "v1", false)] }]);
    const out = await purgeOldVersions(client, { bucket: "b", prefix: "nimbus/", dryRun: true });
    expect(out.deleted).toBe(0);
    expect(client.deleted).toEqual([]);
  });

  it("apaga por VersionId quando não é dry-run", async () => {
    const client = fakeClient([{
      Versions: [V("nimbus/a", "v1", false), V("nimbus/a", "v2", true)],
      DeleteMarkers: [{ Key: "nimbus/b", VersionId: "m1" }],
    }]);

    const out = await purgeOldVersions(client, { bucket: "b", prefix: "nimbus/" });

    expect(out.deleted).toBe(2);
    expect(client.deleted).toEqual([
      { Key: "nimbus/a", VersionId: "v1" },
      { Key: "nimbus/b", VersionId: "m1" },
    ]);
  });
});

describe("selectUploads — só backup novo", () => {
  const dumps = ["db-20260817-070001.sql.gz", "db-20260817-060001.sql.gz", "db-20260817-050001.sql.gz"]
    .map(name => ({ name, path: `/tmp/${name}` }));

  it("sobe o que não está no remoto e nunca foi enviado", () => {
    const out = selectUploads(dumps, new Set([dumps[2].name]), new Set([dumps[2].name]));
    expect(out.map(d => d.name)).toEqual([dumps[0].name, dumps[1].name]);
  });

  it("não reenvia um dump apagado na mão no B2 (já consta como enviado)", () => {
    // dumps[1] sumiu do bucket mas está no histórico → não volta.
    const out = selectUploads(dumps, new Set([dumps[0].name]), new Set([dumps[0].name, dumps[1].name]));
    expect(out.map(d => d.name)).toEqual([dumps[2].name]);
  });

  it("--backfill repõe o que falta no remoto mesmo já enviado antes", () => {
    const sent = new Set(dumps.map(d => d.name));
    const out = selectUploads(dumps, new Set([dumps[0].name]), sent, { backfill: true });
    expect(out.map(d => d.name)).toEqual([dumps[1].name, dumps[2].name]);
  });

  it("--latest olha só o snapshot mais novo", () => {
    expect(selectUploads(dumps, new Set(), new Set(), { latestOnly: true }).map(d => d.name))
      .toEqual([dumps[0].name]);
    expect(selectUploads(dumps, new Set([dumps[0].name]), new Set(), { latestOnly: true })).toEqual([]);
  });
});

describe("purgeKey", () => {
  it("apaga todas as versões da chave (inclusive a viva) e ignora chaves parecidas", async () => {
    const key = "nimbus/db-20260817-070001.sql.gz";
    const client = fakeClient([{
      Versions: [
        V(`${key}.enc`, "v2", true),
        V(`${key}.enc`, "v1", false),
        V(`${key}.enc.bak`, "x1", true), // sobra de outra chave: não pode ir junto
      ],
      DeleteMarkers: [],
    }]);

    const n = await purgeKey(client, { bucket: "b", key });

    expect(n).toBe(2);
    expect(client.deleted.every(d => d.Key === `${key}.enc`)).toBe(true);
  });
});

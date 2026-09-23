// Fila de downloads do Admin › Downloader.
//
// O que estes testes seguram é a autorização dos arquivos. As rotas
// GET /jobs/:id/file e /jobs/:id/zip são abertas por <a href>, que não manda
// header Authorization, então quem autoriza é a chave do job. Se a chave sumir
// do serialize(), ou o caminho do disco vazar junto, o vazamento não aparece em
// nenhuma tela — só aqui.

import "../helpers/env.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const jobs = require(path.join(backend, "downloader", "jobs.js"));

// createJob cria o diretório do lote em disco; limpar no fim evita deixar
// tmp/<uuid> vazios espalhados a cada rodada.
const criados = [];
function novoJob(videos, opts) {
  const job = jobs.createJob(videos, opts);
  criados.push(job);
  return job;
}

const VIDEO = { id: "abc123", url: "https://www.youtube.com/watch?v=abc123", title: "Vídeo", duration: 10 };

beforeAll(() => { fs.mkdirSync(jobs.TMP, { recursive: true }); });
afterAll(() => {
  for (const job of criados) fs.rmSync(job.dir, { recursive: true, force: true });
});

describe("createJob", () => {
  it("cunha uma chave de 24 bytes em hex", () => {
    const job = novoJob([VIDEO]);
    expect(job.key).toMatch(/^[0-9a-f]{48}$/);
  });

  it("dá chaves diferentes a lotes diferentes", () => {
    // Uma chave reaproveitada entre lotes faria o link de um download velho
    // abrir o lote novo de outro admin.
    expect(novoJob([VIDEO]).key).not.toBe(novoJob([VIDEO]).key);
  });

  it("guarda o dono pra um admin não ver o lote do outro", () => {
    expect(novoJob([VIDEO], { ownerId: 7 }).ownerId).toBe(7);
  });
});

describe("serialize", () => {
  it("entrega a chave — é dela que sai o ?k= dos links", () => {
    const job = novoJob([VIDEO]);
    expect(jobs.serialize(job).key).toBe(job.key);
  });

  it("não vaza caminho do disco nem o dono", () => {
    const job = novoJob([VIDEO], { ownerId: 7 });
    const visao = jobs.serialize(job);
    expect(visao.dir).toBeUndefined();
    expect(visao.ownerId).toBeUndefined();
    for (const item of visao.items) {
      // `filename` (basename) pode ir; o caminho absoluto, não.
      expect(item.file).toBeUndefined();
      expect(Object.values(item).join(" ")).not.toContain(path.sep + "tmp" + path.sep);
    }
  });

  it("marca o lote como não terminado enquanto um item renderiza", () => {
    // "rendering" e "queued" não são terminais: a limpeza do tmp/ só pode
    // correr depois que o último item saiu das duas filas.
    const job = novoJob([VIDEO, { ...VIDEO, id: "def456" }]);
    job.items[0].status = "done";
    job.items[1].status = "rendering";
    expect(jobs.serialize(job).finished).toBe(false);
    job.items[1].status = "error";
    expect(jobs.serialize(job).finished).toBe(true);
  });
});

// A comparação real vive em downloader/routes.js (jobByKey). O que se protege
// aqui é a propriedade da qual ela depende: timingSafeEqual LANÇA quando os
// buffers têm tamanhos diferentes, então conferir o tamanho antes não é
// preciosismo — sem isso uma chave curta derruba a rota com 500 em vez de 404.
describe("comparação da chave", () => {
  const compara = (dada, esperada) => {
    const a = Buffer.from(dada);
    const b = Buffer.from(esperada);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  it("aceita a chave certa", () => {
    const job = novoJob([VIDEO]);
    expect(compara(job.key, job.key)).toBe(true);
  });

  it("recusa chave de outro tamanho sem explodir", () => {
    const job = novoJob([VIDEO]);
    expect(() => compara("", job.key)).not.toThrow();
    expect(compara("", job.key)).toBe(false);
    expect(compara(job.key.slice(0, 10), job.key)).toBe(false);
  });

  it("recusa chave do mesmo tamanho com um caractere trocado", () => {
    const job = novoJob([VIDEO]);
    const trocado = (job.key[0] === "a" ? "b" : "a") + job.key.slice(1);
    expect(compara(trocado, job.key)).toBe(false);
  });
});

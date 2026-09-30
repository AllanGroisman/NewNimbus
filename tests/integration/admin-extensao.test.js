// Admin › Extensão — o zip e a versão saem da pasta extension/ na hora.
//
// O que pode quebrar sem ninguém notar: a rota perder o requireAdmin (qualquer
// cliente baixaria a extensão de admin), o caminho da pasta mudar e o zip sair
// vazio, ou a pasta ir para um nível a mais dentro do zip (o "Carregar sem
// compactação" do Chrome não acha o manifest.json).

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { request, app, createTestUser, auth as authMod } from "../helpers/app.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(raiz, "extension", "manifest.json"), "utf8"));

async function makeAdmin() {
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

// supertest não junta corpo binário sozinho.
function binario(res, cb) {
  const partes = [];
  res.on("data", (c) => partes.push(c));
  res.on("end", () => cb(null, Buffer.concat(partes)));
}

describe("Admin › Extensão", () => {
  it("sem token, 401", async () => {
    for (const rota of ["/api/admin/extensao/info", "/api/admin/extensao/zip"]) {
      const res = await request(app).get(rota);
      expect(res.status, rota).toBe(401);
    }
  });

  it("user comum recebe 403", async () => {
    const { token } = await createTestUser();
    for (const rota of ["/api/admin/extensao/info", "/api/admin/extensao/zip"]) {
      const res = await request(app).get(rota).set("Authorization", `Bearer ${token}`);
      expect(res.status, rota).toBe(403);
    }
  });

  it("/info devolve nome e versão do manifest", async () => {
    const { token } = await makeAdmin();
    const res = await request(app).get("/api/admin/extensao/info").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nome: manifest.name, versao: manifest.version });
  });

  it("/zip entrega um zip com o manifest.json na raiz", async () => {
    const { token } = await makeAdmin();
    const res = await request(app)
      .get("/api/admin/extensao/zip")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binario);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/zip/);
    expect(res.headers["content-disposition"]).toContain(`nimbus-extensao-${manifest.version}.zip`);
    const corpo = res.body;
    expect(corpo.subarray(0, 2).toString()).toBe("PK");
    // O nome de cada arquivo aparece em claro no diretório central do zip.
    // "manifest.json" sem prefixo de pasta é o que o Chrome precisa achar.
    const texto = corpo.toString("latin1");
    expect(texto).toContain("manifest.json");
    expect(texto).not.toMatch(/extension\/manifest\.json/);
  });
});

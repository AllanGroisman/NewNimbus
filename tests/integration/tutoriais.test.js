// Tutoriais — a página que todo mundo vê + Admin › Editar Tutoriais (task 102).
//
// O que estes testes protegem, em ordem de importância:
//   1. só admin escreve — a página é pública pra toda a base, e um usuário
//      comum não pode reescrever (nem esvaziar) ela;
//   2. os SLUGS sobrevivem ao round-trip. Eles são contrato de código: as telas
//      de afiliado linkam "afiliado-ml" & cia., e um slug que o backend
//      normaliza diferente do que o front pede deixa o botão "ver tutorial"
//      abrindo nada;
//   3. salvar a árvore inteira realmente cria, atualiza, reordena e EXCLUI;
//   4. payload inválido é recusado sem deixar o conteúdo pela metade.
//
// O truncate entre testes (helpers/setup-each.js) leva junto os tutoriais
// semeados pela migration, então cada teste semeia a árvore que precisa.

import { describe, it, expect, beforeEach } from "vitest";
import { app, request, createTestUser, auth as authMod } from "../helpers/app.js";

// Os ids que o front referencia em TUTORIAL_IDS (frontend/src/pages/Tutoriais.jsx).
const SLUGS_LINKADOS = ["afiliado-ml", "afiliado-amazon", "afiliado-shopee"];

const ARVORE = [
  {
    id: "new-s1", slug: "comecando", title: "Começando", description: "Configure sua conta", icon: "▶",
    tutorials: [
      { id: "new-t1", slug: "criar-conta", title: "Criar conta e verificar email", duration: "2 min", content: "", videoUrl: "" },
      { id: "new-t2", slug: "conectar-whatsapp", title: "Conectar um número de WhatsApp", duration: "3 min", content: "", videoUrl: "" },
    ],
  },
  {
    id: "new-s2", slug: "afiliados", title: "Configurar afiliados", description: "Sem afiliado não gera comissão.", icon: "◆",
    tutorials: SLUGS_LINKADOS.map((slug, i) => ({
      id: `new-a${i}`, slug, title: `Afiliado ${i}`, duration: "3 min", content: "", videoUrl: "",
    })),
  },
];

let admin, comum;

beforeEach(async () => {
  comum = await createTestUser();
  admin = await createTestUser();
  await authMod.setUserRole(admin.user.id, "admin");
  const r = await admin.auth("put", "/api/admin/tutoriais").send({ sections: ARVORE });
  expect(r.status).toBe(200);
});

const slugsDe = (body) => body.sections.flatMap(s => s.tutorials.map(t => t.slug));

describe("GET /api/tutoriais", () => {
  it("exige login", async () => {
    const r = await request(app).get("/api/tutoriais");
    expect(r.status).toBe(401);
  });

  it("qualquer usuário logado lê, mesmo sem assinatura ativa", async () => {
    // Tutorial é material de ajuda: quem está travado na assinatura é
    // justamente quem mais precisa dele.
    const r = await comum.auth("get", "/api/tutoriais");
    expect(r.status).toBe(200);
    expect(r.body.sections.map(s => s.slug)).toEqual(["comecando", "afiliados"]);
  });

  it("os slugs que as páginas de afiliado linkam voltam intactos", async () => {
    const r = await comum.auth("get", "/api/tutoriais");
    for (const slug of SLUGS_LINKADOS) expect(slugsDe(r.body)).toContain(slug);
  });

  it("traz os campos que a tela usa", async () => {
    const r = await comum.auth("get", "/api/tutoriais");
    const t = r.body.sections[0].tutorials[0];
    expect(t).toHaveProperty("slug");
    expect(t).toHaveProperty("title");
    expect(t).toHaveProperty("duration");
    expect(t).toHaveProperty("videoUrl");
    expect(t).toHaveProperty("content");
  });
});

describe("PUT /api/admin/tutoriais — permissão", () => {
  it("usuário comum leva 403", async () => {
    const r = await comum.auth("put", "/api/admin/tutoriais").send({ sections: [] });
    expect(r.status).toBe(403);
  });

  it("sem token leva 401", async () => {
    const r = await request(app).put("/api/admin/tutoriais").send({ sections: [] });
    expect(r.status).toBe(401);
  });

  it("a tentativa recusada não apaga nada", async () => {
    // O payload acima era `sections: []` — se a autorização rodasse depois da
    // gravação, a página teria ficado vazia pra toda a base.
    await comum.auth("put", "/api/admin/tutoriais").send({ sections: [] });
    const r = await comum.auth("get", "/api/tutoriais");
    expect(r.body.sections.length).toBe(2);
  });
});

describe("PUT /api/admin/tutoriais — gravação", () => {
  const arvoreAtual = async () => (await admin.auth("get", "/api/tutoriais")).body.sections;

  it("salva vídeo e texto num tutorial existente", async () => {
    const arvore = await arvoreAtual();
    const alvo = arvore.flatMap(s => s.tutorials).find(t => t.slug === "afiliado-ml");
    alvo.videoUrl = "https://www.youtube.com/watch?v=VIecfv5IlL0";
    alvo.content = "Passo 1\nPasso 2";

    const r = await admin.auth("put", "/api/admin/tutoriais").send({ sections: arvore });
    expect(r.status).toBe(200);

    const salvo = r.body.sections.flatMap(s => s.tutorials).find(t => t.slug === "afiliado-ml");
    expect(salvo.videoUrl).toBe("https://www.youtube.com/watch?v=VIecfv5IlL0");
    expect(salvo.content).toBe("Passo 1\nPasso 2");
  });

  it("cria seção e tutorial novos, gerando slug a partir do título", async () => {
    const arvore = [...(await arvoreAtual()), {
      id: "new-x1", slug: "", title: "Seção de Teste", description: "temporária", icon: "◇",
      tutorials: [{ id: "new-x2", slug: "", title: "Tutorial de Teste", duration: "1 min", content: "", videoUrl: "" }],
    }];

    const r = await admin.auth("put", "/api/admin/tutoriais").send({ sections: arvore });
    expect(r.status).toBe(200);

    const nova = r.body.sections.find(s => s.title === "Seção de Teste");
    expect(nova).toBeDefined();
    expect(nova.slug).toBe("secao-de-teste");   // acento e maiúscula normalizados
    expect(nova.id).not.toMatch(/^new-/);       // ganhou uuid de verdade
    expect(nova.tutorials[0].slug).toBe("tutorial-de-teste");
  });

  it("a ordem do array vira a ordem que o usuário vê", async () => {
    const invertida = [...(await arvoreAtual())].reverse();
    const r = await admin.auth("put", "/api/admin/tutoriais").send({ sections: invertida });
    expect(r.status).toBe(200);
    expect(r.body.sections.map(s => s.slug)).toEqual(["afiliados", "comecando"]);
  });

  it("o que sai da payload é excluído — inclusive tutorial dentro de seção que ficou", async () => {
    const arvore = (await arvoreAtual())
      .filter(s => s.slug !== "comecando")
      .map(s => ({ ...s, tutorials: s.tutorials.filter(t => t.slug !== "afiliado-shopee") }));

    const r = await admin.auth("put", "/api/admin/tutoriais").send({ sections: arvore });
    expect(r.status).toBe(200);
    expect(r.body.sections.map(s => s.slug)).toEqual(["afiliados"]);
    expect(slugsDe(r.body)).not.toContain("afiliado-shopee");
    expect(slugsDe(r.body)).not.toContain("criar-conta");   // foi junto com a seção
  });

  it("move um tutorial de seção sem perder o slug", async () => {
    const arvore = await arvoreAtual();
    const [movido] = arvore[1].tutorials.splice(0, 1);   // tira de "afiliados"
    arvore[0].tutorials.push(movido);                     // põe em "comecando"

    const r = await admin.auth("put", "/api/admin/tutoriais").send({ sections: arvore });
    expect(r.status).toBe(200);
    const comecando = r.body.sections.find(s => s.slug === "comecando");
    expect(comecando.tutorials.map(t => t.slug)).toContain("afiliado-ml");
  });
});

describe("PUT /api/admin/tutoriais — validação", () => {
  const invalidos = [
    ["seção sem título", { sections: [{ title: "", tutorials: [] }] }],
    ["tutorial sem título", { sections: [{ title: "A", tutorials: [{ title: "" }] }] }],
    ["link de vídeo que não é URL", { sections: [{ title: "A", tutorials: [{ title: "X", videoUrl: "nao-e-url" }] }] }],
    ["dois tutoriais com o mesmo slug", { sections: [{ title: "A", tutorials: [{ title: "Igual" }, { title: "Igual" }] }] }],
    ["duas seções com o mesmo slug", { sections: [{ title: "A", tutorials: [] }, { title: "A", tutorials: [] }] }],
    ["payload sem lista de seções", { sections: "isto não é lista" }],
  ];

  for (const [caso, payload] of invalidos) {
    it(`recusa: ${caso}`, async () => {
      const r = await admin.auth("put", "/api/admin/tutoriais").send(payload);
      expect(r.status).toBe(400);
      expect(r.body.error).toBeTruthy();
    });
  }

  it("payload recusado não encosta no conteúdo publicado", async () => {
    // A validação roda ANTES de abrir transação — um payload inválido não pode
    // ter apagado as seções que ele não trazia.
    await admin.auth("put", "/api/admin/tutoriais").send({ sections: [{ title: "", tutorials: [] }] });
    const r = await comum.auth("get", "/api/tutoriais");
    for (const slug of SLUGS_LINKADOS) expect(slugsDe(r.body)).toContain(slug);
  });
});

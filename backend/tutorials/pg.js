// Onde vivem as seções e os tutoriais da tela "Tutoriais" (task 102).
//
// Duas tabelas (ver schema.prisma): `tutorial_sections` e `tutorials`, ligadas
// por FK com ON DELETE CASCADE — apagar a seção leva os tutoriais dela junto.
//
// A tela do admin edita a árvore inteira em memória e manda tudo de uma vez em
// `saveTree`. Foi de propósito: é como as outras telas editáveis do projeto já
// funcionam (modelos de notificação, de e-mail), resolve reordenação de graça
// (a ordem do array VIRA o `sort`) e evita estado intermediário meio-salvo.
const { prisma } = require("../db");

// O slug é contrato de código, não texto livre: o front faz deep-link por ele
// (TUTORIAL_IDS em pages/Tutoriais.jsx, usado pelas telas de afiliado). Por isso
// é normalizado na gravação em vez de aceito como veio.
function normalizeSlug(raw) {
  return String(raw || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function texto(v) { return typeof v === "string" ? v.trim() : ""; }

// Erro de validação: o server transforma em 400 e a mensagem vai direto pra UI.
function erro(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function validarVideoUrl(url, ondeErro) {
  if (!url) return "";
  let u;
  try { u = new URL(url); } catch { throw erro(`O link do vídeo de "${ondeErro}" não é uma URL válida.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw erro(`O link do vídeo de "${ondeErro}" precisa começar com http:// ou https://.`);
  }
  return u.toString();
}

// ────────────────────────────────────────────────────────────────────────
// Leitura
// ────────────────────────────────────────────────────────────────────────

// A árvore inteira, já ordenada. Consumida tanto pela página pública quanto
// pela tela do admin — as duas querem exatamente a mesma coisa.
async function getTree() {
  const sections = await prisma().tutorialSection.findMany({
    orderBy: [{ sort: "asc" }, { title: "asc" }],
    include: { tutorials: { orderBy: [{ sort: "asc" }, { title: "asc" }] } },
  });
  return {
    sections: sections.map(s => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      description: s.description,
      icon: s.icon,
      tutorials: s.tutorials.map(t => ({
        id: t.id,
        slug: t.slug,
        title: t.title,
        duration: t.duration,
        content: t.content,
        videoUrl: t.videoUrl,
      })),
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Gravação
// ────────────────────────────────────────────────────────────────────────

// Valida a árvore recebida ANTES de encostar no banco, e já devolve ela
// normalizada. Separado da transação de propósito: um payload inválido não
// pode chegar a abrir transação nem apagar nada.
function validarArvore(payload) {
  const sections = Array.isArray(payload?.sections) ? payload.sections : null;
  if (!sections) throw erro("Formato inválido: esperava uma lista de seções.");

  const slugsSecao = new Set();
  const slugsTutorial = new Set();

  return sections.map((s, i) => {
    const title = texto(s?.title);
    if (!title) throw erro(`A ${i + 1}ª seção está sem título.`);

    const slug = normalizeSlug(s?.slug || title);
    if (!slug) throw erro(`Não consegui gerar um endereço (slug) para a seção "${title}".`);
    if (slugsSecao.has(slug)) throw erro(`Existem duas seções com o mesmo endereço "${slug}". Os títulos precisam ser diferentes.`);
    slugsSecao.add(slug);

    const tutoriais = Array.isArray(s?.tutorials) ? s.tutorials : [];
    return {
      id: texto(s?.id) || null,
      slug,
      title,
      description: texto(s?.description),
      icon: texto(s?.icon) || "▶",
      sort: i,
      tutorials: tutoriais.map((t, j) => {
        const tTitle = texto(t?.title);
        if (!tTitle) throw erro(`O ${j + 1}º tutorial da seção "${title}" está sem título.`);

        const tSlug = normalizeSlug(t?.slug || tTitle);
        if (!tSlug) throw erro(`Não consegui gerar um endereço (slug) para o tutorial "${tTitle}".`);
        if (slugsTutorial.has(tSlug)) throw erro(`Existem dois tutoriais com o mesmo endereço "${tSlug}". Os títulos precisam ser diferentes.`);
        slugsTutorial.add(tSlug);

        return {
          id: texto(t?.id) || null,
          slug: tSlug,
          title: tTitle,
          duration: texto(t?.duration),
          content: typeof t?.content === "string" ? t.content : "",
          videoUrl: validarVideoUrl(texto(t?.videoUrl), tTitle),
          sort: j,
        };
      }),
    };
  });
}

// Item novo chega da tela sem id (ou com um id temporário "new-…", que o React
// usa como key). Nos dois casos é criação, não update.
function isNovo(id) { return !id || id.startsWith("new-"); }

// Substitui a árvore inteira pela recebida. Devolve a árvore relida do banco —
// a tela precisa dela pra trocar os ids temporários pelos uuid de verdade.
async function saveTree(payload) {
  const sections = validarArvore(payload);

  await prisma().$transaction(async tx => {
    // Apaga primeiro o que sumiu da payload. O cascade da FK cuidaria dos
    // tutoriais das seções removidas, mas os tutoriais movidos/excluídos DENTRO
    // de seções que ficaram precisam sair explicitamente.
    const idsSecao = sections.map(s => s.id).filter(id => id && !isNovo(id));
    await tx.tutorial.deleteMany({
      where: { id: { notIn: sections.flatMap(s => s.tutorials.map(t => t.id)).filter(id => id && !isNovo(id)) } },
    });
    await tx.tutorialSection.deleteMany({ where: { id: { notIn: idsSecao } } });

    for (const s of sections) {
      const dados = { slug: s.slug, title: s.title, description: s.description, icon: s.icon, sort: s.sort };
      const secao = isNovo(s.id)
        ? await tx.tutorialSection.create({ data: dados })
        : await tx.tutorialSection.update({ where: { id: s.id }, data: dados });

      for (const t of s.tutorials) {
        const tDados = {
          slug: t.slug, title: t.title, duration: t.duration,
          content: t.content, videoUrl: t.videoUrl, sort: t.sort,
        };
        if (isNovo(t.id)) {
          await tx.tutorial.create({ data: { ...tDados, sectionId: secao.id } });
        } else {
          // sectionId no update porque o admin pode ter movido o tutorial de seção.
          await tx.tutorial.update({ where: { id: t.id }, data: { ...tDados, sectionId: secao.id } });
        }
      }
    }
  });

  return getTree();
}

module.exports = { getTree, saveTree, normalizeSlug };

// Templates de overlay salvos em disco. App local de um usuário só: um JSON
// lido e escrito inteiro a cada operação é mais simples que qualquer banco.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "data");
const FILE = path.join(DIR, "templates.json");

const IMPACT = "Impact, Haettenschweiler, sans-serif";

// Dois templates de fábrica para o editor abrir com algo em vez de uma tela em
// branco: um com faixa sobre o vídeo inteiro, outro no formato "vídeo reduzido".
const FACTORY = [
  {
    name: "Faixa no topo",
    format: "vertical",
    video: { top: 0, height: 1920, background: "#111111", fit: "cover" },
    layers: [
      { type: "box", x: 0, y: 0, w: 1080, h: 250, color: "#cd6f04", opacity: 0.92, radius: 0 },
      {
        type: "text", x: 540, y: 72, w: 980, text: "OLHA ESSE PREÇO",
        font: IMPACT, size: 92, weight: 400, color: "#ffffff",
        align: "center", lineHeight: 1.1, uppercase: true, opacity: 1,
        stroke: { color: "#000000", width: 0 },
        shadow: { color: "rgba(0,0,0,0.45)", blur: 10, y: 4 },
      },
    ],
  },
  {
    name: "Barras + vídeo reduzido",
    format: "vertical",
    video: { top: 270, height: 1380, background: "#0b0b0b", fit: "cover" },
    layers: [
      {
        type: "text", x: 540, y: 74, w: 1000, text: "{titulo}",
        font: IMPACT, size: 58, weight: 400, color: "#ffffff",
        align: "center", lineHeight: 1.15, uppercase: true, opacity: 1,
        stroke: { color: "#000000", width: 0 },
        shadow: { color: "rgba(0,0,0,0.45)", blur: 0, y: 0 },
      },
      {
        type: "text", x: 540, y: 1725, w: 1000, text: "LINK NA BIO",
        font: IMPACT, size: 70, weight: 400, color: "#cd6f04",
        align: "center", lineHeight: 1.1, uppercase: true, opacity: 1,
        stroke: { color: "#000000", width: 0 },
        shadow: { color: "rgba(0,0,0,0.45)", blur: 0, y: 0 },
      },
    ],
  },
];

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // arquivo ainda não existe ou ficou corrompido
  }
}

// Grava num .tmp e renomeia: se o processo morrer no meio da escrita, o
// templates.json antigo continua inteiro em vez de virar lixo.
function write(list) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(list, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
  return list;
}

const MAX_IMG = 2 * 1024 * 1024; // logo de verdade tem 20-200 KB

// O body vem do próprio editor, mas nada custa garantir que um template
// malformado não derrube a leitura do arquivo inteiro depois.
function sanitize(body) {
  const layers = (Array.isArray(body?.layers) ? body.layers : [])
    .filter((l) => ["box", "text", "image"].includes(l?.type))
    .filter((l) => l.type !== "image" || (/^data:image\/(png|jpeg|webp);base64,/.test(l.src || "") && l.src.length <= MAX_IMG))
    .slice(0, 40);
  return {
    name: String(body?.name || "Sem nome").slice(0, 80),
    format: body?.format === "horizontal" ? "horizontal" : "vertical",
    video: {
      top: Number(body?.video?.top) || 0,
      height: Number(body?.video?.height) || 0,
      background: String(body?.video?.background || "#000000").slice(0, 32),
      fit: body?.video?.fit === "contain" ? "contain" : "cover",
    },
    layers,
  };
}

function list() {
  return read() || write(FACTORY.map((t) => ({ ...t, id: crypto.randomUUID() })));
}

// Upsert: o id vem da URL, então salvar um template novo e editar um existente
// são a mesma chamada.
function save(id, template) {
  const item = { ...sanitize(template), id, updatedAt: Date.now() };
  const all = list();
  const i = all.findIndex((t) => t.id === id);
  if (i >= 0) all[i] = item; else all.push(item);
  write(all);
  return item;
}

function remove(id) {
  write(list().filter((t) => t.id !== id));
}

// Fábrica volta por nome: o que tem o mesmo nome de um de fábrica é
// sobrescrito (é o "desfazer" de quem editou o padrão e não gostou); os
// outros templates ficam intactos.
function restoreDefaults() {
  const all = list();
  for (const t of FACTORY) {
    const i = all.findIndex((x) => x.name === t.name);
    const item = { ...JSON.parse(JSON.stringify(t)), id: i >= 0 ? all[i].id : crypto.randomUUID(), updatedAt: Date.now() };
    if (i >= 0) all[i] = item; else all.push(item);
  }
  return write(all);
}

module.exports = { list, save, remove, restoreDefaults };

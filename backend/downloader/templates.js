// Templates de overlay salvos em disco. App local de um usuário só: um JSON
// lido e escrito inteiro a cada operação é mais simples que qualquer banco.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "data");
const FILE = path.join(DIR, "templates.json");
// Nomes dos templates de fábrica que já foram oferecidos. Ver list().
const SEEN_FILE = path.join(DIR, "factory-seen.json");

const IMPACT = "Impact, Haettenschweiler, sans-serif";

// Templates de fábrica para o editor abrir com algo em vez de uma tela em
// branco: faixa sobre o vídeo inteiro, "vídeo reduzido" entre barras e o post
// em formato de tweet com o vídeo embaixo.
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
  {
    // Fundo branco e "caber inteiro": o vídeo vertical sai reduzido e
    // centralizado embaixo do tweet, com branco dos lados.
    name: "TwitterReact",
    format: "vertical",
    video: { top: 620, height: 1000, background: "#ffffff", fit: "contain" },
    layers: [
      {
        type: "tweet", x: 84, y: 150, w: 912, size: 56,
        avatar: "", name: "Nome da Conta", handle: "suaconta", verified: true,
        text: "Escreva aqui o texto do tweet.", date: "17:00 · 01 de Julho de 2021",
        theme: "light", opacity: 1,
      },
    ],
  },
];

// Template de fábrica novo tem que chegar a quem já tem o templates.json, mas
// uma vez só: quem apagou não quer vê-lo voltar. O que já foi oferecido fica
// anotado à parte; sem a anotação, são os dois que existem desde o começo.
const LEGACY_SEEN = ["Faixa no topo", "Barras + vídeo reduzido"];

function readSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function markSeen(names) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...new Set(names)]));
}

const fresh = (t) => ({ ...JSON.parse(JSON.stringify(t)), id: crypto.randomUUID() });

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
const imagemOk = (src) => /^data:image\/(png|jpeg|webp);base64,/.test(src || "") && src.length <= MAX_IMG;

// O body vem do próprio editor, mas nada custa garantir que um template
// malformado não derrube a leitura do arquivo inteiro depois.
function sanitize(body) {
  const layers = (Array.isArray(body?.layers) ? body.layers : [])
    .filter((l) => ["box", "text", "image", "tweet"].includes(l?.type))
    .filter((l) => l.type !== "image" || imagemOk(l.src))
    // Tweet com foto inválida continua valendo, só sem a foto.
    .map((l) => (l.type === "tweet" && !imagemOk(l.avatar) ? { ...l, avatar: "" } : l))
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
  const all = read();
  if (!all) {
    markSeen(FACTORY.map((t) => t.name));
    return write(FACTORY.map(fresh));
  }
  const seen = readSeen() || LEGACY_SEEN;
  const novos = FACTORY.filter((t) => !seen.includes(t.name));
  if (!novos.length) return all;
  // Quem já criou um template com o mesmo nome fica com o seu.
  const add = novos.filter((t) => !all.some((x) => x.name === t.name)).map(fresh);
  if (add.length) write([...all, ...add]);
  markSeen([...seen, ...novos.map((t) => t.name)]);
  return [...all, ...add];
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
  markSeen([...(readSeen() || LEGACY_SEEN), ...FACTORY.map((t) => t.name)]);
  return write(all);
}

module.exports = { list, save, remove, restoreDefaults, sanitize };

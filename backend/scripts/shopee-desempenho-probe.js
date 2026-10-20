#!/usr/bin/env node
// SONDA: que campos o `conversionReport` da Shopee tem além dos que o
// Desempenho já lê (affiliate-reports/shopee.js), e em que formato eles vêm?
//
// Por que a pergunta existe. A task 3 pede a aba Desempenho da Shopee no desenho
// da do ML: detalhe dos ganhos por fonte, produtos, categorias, audiências, não
// efetivadas. Pra isso a query precisa de campos novos — e o GraphQL recusa a
// query INTEIRA se um campo pedido não existe. Então o nome de cada campo é
// conferido aqui antes de entrar na query de produção.
//
// O que a sonda faz:
//   1. Introspecção: acha o tipo que o `conversionReport` devolve e lista os
//      campos do nó, do pedido e do item (com o tipo de cada um, e os valores
//      possíveis dos enums).
//   2. Busca uma página do período com TODOS os campos escalares que a
//      introspecção achou, e resume cada campo: valores distintos (os de texto
//      curto, como status e tipo de comprador) ou soma (os de dinheiro).
//
// Uso:
//   node scripts/shopee-desempenho-probe.js --user <email|userId>
//   node scripts/shopee-desempenho-probe.js            # o primeiro usuário com App ID + senha
//   node scripts/shopee-desempenho-probe.js --user <email> --dias 60
//   node scripts/shopee-desempenho-probe.js --user <email> --amostra   # + um item cru inteiro
//   node scripts/shopee-desempenho-probe.js --sistema   # a conta do sistema (Admin › Shopee)
//
// Só LÊ: não escreve no banco e não imprime App ID nem senha.
require("../config/loadEnv");

const TIMEOUT_MS = 20000;

function flag(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}

async function resolveUsuario(arg) {
  if (!arg) return null;
  if (arg.includes("@")) {
    const u = await require("../auth").findByEmail(arg);
    return u?.id || null;
  }
  return arg;
}

// O primeiro usuário com credencial completa (App ID + senha): só esse modo lê
// o relatório.
async function primeiroComSenha() {
  const rows = await require("../db").prisma().affiliateConfig.findMany({ select: { userId: true, data: true } });
  const r = rows.find(x => x.data?.shopee?.appId && x.data?.shopee?.appSecret);
  return r ? r.userId : null;
}

async function post(affiliate, creds, query) {
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000);
  const { UA } = require("../scraping/scraper");
  const res = await fetch(affiliate.SHOPEE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": affiliate.signShopeeRequest({ ...creds, timestamp, payload }),
      "User-Agent": UA,
    },
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`HTTP ${res.status}`);
  if (Array.isArray(json.errors) && json.errors.length) {
    const e = json.errors[0];
    throw new Error(`${e?.extensions?.code || "?"}: ${e?.extensions?.message || e?.message}`);
  }
  return json.data;
}

// O tipo "de verdade" atrás de NON_NULL/LIST.
function nomeDoTipo(t) {
  let x = t;
  while (x && !x.name && x.ofType) x = x.ofType;
  return x ? { name: x.name, kind: x.kind } : { name: null, kind: null };
}

const TIPO_REF = "type{name kind ofType{name kind ofType{name kind ofType{name kind}}}}";

// Campos de um tipo, com o tipo "de verdade" de cada um. Guardado por nome.
const _tipos = {};
async function camposDoTipo(affiliate, creds, nome) {
  if (!_tipos[nome]) {
    const data = await post(affiliate, creds, `{__type(name:"${nome}"){fields{name ${TIPO_REF}}}}`);
    _tipos[nome] = (data?.__type?.fields || []).map(f => ({ campo: f.name, ...nomeDoTipo(f.type) }));
  }
  return _tipos[nome];
}

// Imprime o tipo e desce pelos campos objeto; devolve a seleção GraphQL com
// todos os escalares.
async function explora(affiliate, creds, tipo, nivel = 0) {
  const campos = await camposDoTipo(affiliate, creds, tipo);
  console.log(`\n${"  ".repeat(nivel)}${tipo}:`);
  for (const f of campos) {
    let valores = "";
    if (f.kind === "ENUM") {
      const e = await post(affiliate, creds, `{__type(name:"${f.name}"){enumValues{name}}}`);
      valores = ` = ${(e?.__type?.enumValues || []).map(v => v.name).join(" | ")}`;
    }
    console.log(`${"  ".repeat(nivel)}  ${f.campo}: ${f.name} (${f.kind})${valores}`);
  }
  const partes = [];
  for (const f of campos) {
    if (f.kind === "OBJECT") {
      if (nivel < 3) partes.push(`${f.campo}{${await explora(affiliate, creds, f.name, nivel + 1)}}`);
    } else {
      partes.push(f.campo);
    }
  }
  return partes.join(" ");
}

function janela(dias) {
  const fim = Math.floor(Date.now() / 1000);
  return { inicio: fim - dias * 86400, fim };
}

function resumeCampo(valores) {
  const presentes = valores.filter(v => v !== null && v !== undefined && v !== "");
  if (!presentes.length) return "sempre vazio";
  const numericos = presentes.every(v => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)));
  const distintos = [...new Set(presentes.map(v => (typeof v === "object" ? JSON.stringify(v) : String(v))))];
  if (numericos && distintos.length > 8) {
    const soma = presentes.reduce((a, v) => a + parseFloat(v), 0);
    return `${presentes.length}/${valores.length} preenchidos · soma ${soma.toFixed(4)} · ex.: ${distintos.slice(0, 3).join(", ")}`;
  }
  const lista = distintos.slice(0, 12).map(v => (v.length > 60 ? `${v.slice(0, 57)}…` : v));
  return `${presentes.length}/${valores.length} preenchidos · ${distintos.length} distintos: ${lista.join(" | ")}${distintos.length > 12 ? " | …" : ""}`;
}

async function main() {
  const args = process.argv.slice(2);
  await require("../config").warmup();
  const affiliate = require("../scraping/affiliate");
  await affiliate.warmup();

  let creds;
  if (args.includes("--sistema")) {
    const c = affiliate.getScraperShopeeCreds();
    if (!c?.appId || !c?.appSecret) {
      console.error("[sonda] a conta Shopee do sistema não está configurada (env ou Admin › Shopee).");
      process.exit(1);
    }
    creds = { appId: c.appId, appSecret: c.appSecret };
    console.log("[sonda] conta do sistema");
  } else {
    const userId = (await resolveUsuario(flag(args, "--user"))) || (flag(args, "--user") ? null : await primeiroComSenha());
    if (!userId) {
      console.error("uso: node scripts/shopee-desempenho-probe.js --user <email|userId> | --sistema  (nenhum usuário com App ID + senha achado)");
      process.exit(1);
    }
    const { appId, appSecret } = affiliate.readShopeeConfig(userId);
    if (!appId || !appSecret) {
      console.error(`[sonda] o usuário ${userId} não tem App ID + senha da Shopee.`);
      process.exit(1);
    }
    creds = { appId, appSecret };
    console.log(`[sonda] usuário ${userId}`);
  }

  // ── 1. Introspecção ───────────────────────────────────────────────────────
  const raiz = await post(affiliate, creds, `{__schema{queryType{fields{name ${TIPO_REF}}}}}`);
  const campoRaiz = (raiz?.__schema?.queryType?.fields || []).find(f => f.name === "conversionReport");
  if (!campoRaiz) throw new Error("conversionReport não está no schema");
  const tipoRaiz = nomeDoTipo(campoRaiz.type).name;

  console.log(`\n=== Introspecção (conversionReport → ${tipoRaiz}) ===`);
  const sel = await explora(affiliate, creds, tipoRaiz);

  // ── 2. Uma página com todos os escalares ──────────────────────────────────
  const dias = Number(flag(args, "--dias")) || 30;
  const { inicio, fim } = janela(dias);
  const query = `{conversionReport(purchaseTimeStart:${inicio},purchaseTimeEnd:${fim},limit:100){${sel}}}`;
  const data = await post(affiliate, creds, query);
  const nodes = data?.conversionReport?.nodes || [];
  console.log(`\n=== Dados: ${nodes.length} conversões nos últimos ${dias} dias (1 página, até 100) ===`);
  if (!nodes.length) return;

  const pedidos = nodes.flatMap(n => n.orders || []);
  const itens = pedidos.flatMap(o => o.items || []);
  const bloco = (titulo, lista) => {
    console.log(`\n${titulo} (${lista.length}):`);
    const chaves = [...new Set(lista.flatMap(x => Object.keys(x || {})))].filter(k => !["orders", "items"].includes(k));
    for (const k of chaves) console.log(`  ${k}: ${resumeCampo(lista.map(x => x?.[k]))}`);
  };
  bloco("Conversão", nodes);
  bloco("Pedido", pedidos);
  bloco("Item", itens);

  if (args.includes("--amostra")) {
    console.log("\n=== Amostra: o primeiro item cru ===");
    console.log(JSON.stringify(itens[0], null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("[sonda] falhou:", err.message);
    process.exit(1);
  });

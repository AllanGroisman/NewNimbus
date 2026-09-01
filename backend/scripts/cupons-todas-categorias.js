// OBSOLETO desde a task 28 — mantido só como registro do que aconteceu.
//
// As duas chaves que este script conserta (`groupings` e `limitPerGrouping`) não
// existem mais na config: a etapa 1 agora varre a lista GERAL e as verticais só
// carimbam a categoria (`categorias`, `carimbarCategorias`). E o `readConfig`
// passou a descartar na LEITURA qualquer chave que o DEFAULT_CONFIG não conheça —
// que é a correção de raiz do problema abaixo, e o motivo de este script não ter
// mais o que fazer. Rodá-lo hoje grava chaves que ninguém lê.
//
// ── o que ele consertava ────────────────────────────────────────────────
//
// One-shot: destrava a rodada de cupons que ficou presa numa categoria só.
//
// Contexto (task 26): a config da rodada mora em `app_config['ml-cupons-config']`
// e, num dado momento, alguém gravou `groupings: ["tb_vertical"]` — "Brinquedos,
// Hobbies e Bebês". O default do código é `[]` (todas), mas o valor salvo sempre
// vence (`readConfig` faz `{...DEFAULT_CONFIG, ...raw}`), e não havia tela nenhuma
// que escrevesse `groupings`: o painel re-gravava o valor escondido a cada
// "salvar". Resultado: meses puxando cupom só de brinquedos.
//
// A tela agora tem o seletor de categorias, então isto aqui só limpa o que ficou
// para trás. Precisa ser script porque cada ambiente tem o seu banco: rodar em dev
// não conserta a VPS.
//
// O que faz:
//   - `groupings` → []            (varrer TODAS as categorias, uma de cada vez)
//   - `limitPerGrouping` → 100    (o teto passou a ser por categoria: ~10
//                                  verticais × 500 seriam ~170 páginas abertas
//                                  na mesma conta que o Hub usa)
//
// USO (rodar no host, dentro de backend/):
//   node scripts/cupons-todas-categorias.js            # dry-run (só mostra)
//   node scripts/cupons-todas-categorias.js --apply    # grava
//
// É idempotente: rodar de novo não muda nada.

const { prisma, disconnect } = require("../db");

const APPLY = process.argv.includes("--apply");
const CHAVE = "ml-cupons-config";
const LIMITE_NOVO = 100;

async function main() {
  const db = prisma();
  const linha = await db.appConfig.findUnique({ where: { key: CHAVE } });

  if (!linha) {
    console.log(`Não existe linha '${CHAVE}' — a rodada já usa os defaults do código (todas as categorias).`);
    return;
  }

  const antes = linha.value && typeof linha.value === "object" ? linha.value : {};
  const groupings = Array.isArray(antes.groupings) ? antes.groupings : [];
  console.log(`Config atual:
  groupings        = ${JSON.stringify(groupings)}${groupings.length ? "  ← presa nesta(s) categoria(s)" : "  (já é todas)"}
  limitPerGrouping = ${antes.limitPerGrouping ?? "(default)"}`);

  const precisa = groupings.length > 0 || Number(antes.limitPerGrouping) > LIMITE_NOVO;
  if (!precisa) {
    console.log("\nNada a fazer.");
    return;
  }

  const depois = { ...antes, groupings: [], limitPerGrouping: Math.min(Number(antes.limitPerGrouping) || LIMITE_NOVO, LIMITE_NOVO) };
  console.log(`\nVai virar:
  groupings        = []
  limitPerGrouping = ${depois.limitPerGrouping}`);

  if (!APPLY) {
    console.log("\n[dry-run] Rode com --apply pra gravar.");
    return;
  }

  await db.appConfig.update({ where: { key: CHAVE }, data: { value: depois } });
  console.log("\n[apply] gravado. A próxima rodada varre todas as categorias.");
  // O backend cacheia `app_config` em memória (config/pg.js), então o processo que
  // está no ar só enxerga isto no próximo refresh ou reinício.
  console.log("Reinicie o backend (ou espere o refresh do app_config) para valer no processo em execução.");
}

main()
  .catch((err) => {
    console.error("Falhou:", err);
    process.exitCode = 1;
  })
  .finally(() => disconnect());

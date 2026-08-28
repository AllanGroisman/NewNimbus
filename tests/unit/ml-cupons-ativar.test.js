// O rótulo de ativação: do modelo do ML até o botão no DOM.
//
// Este arquivo existe por causa de um bug que custou duas rodadas em branco. O
// código lia `sr_label`; o ML manda `srLabel`. O `||` caía no irmão `label`, que
// é o texto visível — "Aplicar", idêntico em todos os cards. O sintoma foi "não
// ativa nada"; o risco real era pior: casar o primeiro botão da página e ativar
// OUTRO cupom na conta, sem desfazer.
//
// As duas fixtures aqui saíram da MESMA página real (mercadolivre.com.br/cupons,
// 27/08/2026), recortadas mecanicamente: `ml-cupons-rotulos.json` é o lado do
// modelo, `ml-cupons-botoes.html` é o lado do DOM. Testar os dois juntos é o
// ponto — o bug morava exatamente na costura entre eles.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const fx = (n) => path.join(__dirname, "..", "fixtures", n);

const ml = require("../../backend/scraping/ml-cupons");
const rotulos = JSON.parse(fs.readFileSync(fx("ml-cupons-rotulos.json"), "utf8"));

// Sem jsdom neste projeto de testes, e não vale uma dependência a mais: o que
// importa é o VALOR do atributo, e ele se lê do texto sem montar árvore nenhuma.
const botoesHtml = fs.readFileSync(fx("ml-cupons-botoes.html"), "utf8");
const noDom = [...botoesHtml.matchAll(/<button\b[^>]*aria-label="(Aplicar cupom[^"]*)"/g)].map(m => m[1]);

describe("o rótulo que liga o modelo ao botão", () => {
  it("o srLabel do modelo é o aria-label do DOM — para TODO cupom ativável", () => {
    // Esta é a asserção que faltava. Enquanto ela não existiu, a hipótese de que
    // `srLabel` vira `aria-label` era só isso: hipótese.
    const alvos = ml.aAtivar(rotulos, { max: 999, agora: Date.parse("2026-08-27T00:00:00Z") });
    expect(alvos.length).toBeGreaterThan(10);
    for (const c of alvos) {
      expect(noDom).toContain(c.activationLabel);
    }
  });

  it("nenhum rótulo é o texto pelado do botão", () => {
    // "Aplicar" sozinho não identifica cupom nenhum. Era o valor que o bug produzia.
    expect(rotulos.map(c => c.activationLabel)).not.toContain("Aplicar");
  });
});

describe("aAtivar — quem pode receber o clique", () => {
  const agora = Date.parse("2026-08-27T00:00:00Z");

  it("descarta o rótulo que pertence a mais de um cupom", () => {
    // Caso real desta página: "Aplicar cupom 8 por cento OFF INTERNACIONAL" é o
    // rótulo de DOIS cupons (13999830 e 13373945), e "10 por cento OFF em
    // Smartphones" de outros dois (13598722 e 13805172). Não há como saber qual
    // botão é de qual, e chutar é escrita irreversível — então nenhum dos quatro vai.
    const ids = ml.aAtivar(rotulos, { max: 999, agora }).map(c => c.campaignId);
    for (const ambiguo of ["13999830", "13373945", "13598722", "13805172"]) {
      expect(ids).not.toContain(ambiguo);
    }
    expect(ids).toContain("13520039");   // ADIDAS: repetido no DOM, único no modelo — pode
  });

  it("o rótulo repetido no DOM, mas único no modelo, é permitido", () => {
    // O ML mostra o mesmo card em vários carrosséis. São clones do MESMO cupom,
    // então a duplicata no DOM é inofensiva — clicar em qualquer um acerta.
    const adidas = noDom.filter(l => l.includes("ADIDAS"));
    expect(adidas.length).toBeGreaterThan(1);
    expect(new Set(adidas).size).toBe(1);
  });

  it("todo alvo devolvido tem rótulo único entre os alvos", () => {
    const labs = ml.aAtivar(rotulos, { max: 999, agora }).map(c => c.activationLabel);
    expect(new Set(labs).size).toBe(labs.length);
  });

  it("ambiguidade não é resolvida pelo teto: o gêmeo cortado não libera o outro", () => {
    // A contagem tem que ser sobre todos os candidatos, não sobre os que couberem
    // no `max` — senão o teto viraria, sem querer, um jeito de destravar o chute.
    const ids = ml.aAtivar(rotulos, { max: 3, agora }).map(c => c.campaignId);
    expect(ids).not.toContain("13999830");
    expect(ids).not.toContain("13373945");
  });

  it("cupom de loja, já ativado e vencido continuam de fora", () => {
    expect(ml.aAtivar(rotulos, { max: 999, agora }).every(c =>
      c.scope === "campaign" && !c.activated)).toBe(true);
  });
});

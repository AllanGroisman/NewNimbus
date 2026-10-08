// A prévia do editor de modelos (frontend/src/data/messageTemplate.js) é uma cópia
// do renderTemplate do envio (backend/scheduler.js). Se as duas divergem, a prévia
// mostra uma mensagem que nunca sai — foi o que aconteceu antes (sem centavos,
// cupom escondido na campanha de busca). Este teste roda as duas sobre os mesmos
// itens × modelos e exige saída idêntica.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { renderMessageTemplate, previewItem } from "../../frontend/src/data/messageTemplate.js";
import {
  DEFAULT_MESSAGE_TEMPLATE, CLASSIC_MESSAGE_TEMPLATE, LEGACY_DEFAULT_MESSAGE_TEMPLATE,
} from "../../frontend/src/data/mockData.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const scheduler = require(path.resolve(__dirname, "..", "..", "backend", "scheduler.js"));

const MODELOS = {
  padrao: DEFAULT_MESSAGE_TEMPLATE,
  classico: CLASSIC_MESSAGE_TEMPLATE,
  legado: LEGACY_DEFAULT_MESSAGE_TEMPLATE,
  todas: "{produto}|{preco}|{preco_com_cupom}|{preco_antigo}|{desconto}|{economia}\n{loja} {vendas} {avaliacao} {frete}\n{cupom} {desconto_cupom} {economia_cupom}\n{link} {todos} {xyz}",
  so_preco_com_cupom: "{produto}\n\n💸 {preco_com_cupom}\n\n\n🛒 {link}",
  preco_caido: "Por {preco} ({desconto} OFF)\nCom cupom {preco_com_cupom}\n{link}",
  mesma_linha: "{preco} / {preco_com_cupom}\n🎟️ {cupom}",
  vazio: "",
};

const ITENS = {
  completo: previewItem(),
  sem_promo: previewItem({ promo: false }),
  sem_cupom: previewItem({ cupom: false }),
  nada: previewItem({ promo: false, cupom: false }),
  shopee_sem_desconto: { name: "Fone", price: 49.9, originalPrice: null, discount: 0, soldCount: 3200, store: "Shopee", freeShipping: false, link: "https://s.shopee.com.br/x" },
  ml_pilula: { name: "Panela", price: 58, originalPrice: null, discount: 42, sold: "+1 mil vendidos", store: "Mercado Livre", link: "https://meli.la/x" },
  palavra_sem_regra: { name: "Livro", price: 30, originalPrice: 40, coupon: "AMZ10", store: "Amazon", link: "https://amzn.to/x" },
  preco_quebrado: { name: "Cabo", price: 19.999, originalPrice: 19.999, rating: 4.75, link: "L" },
  vazio: {},
};

describe("prévia do editor = mensagem enviada", () => {
  for (const [nomeModelo, modelo] of Object.entries(MODELOS)) {
    for (const [nomeItem, item] of Object.entries(ITENS)) {
      it(`${nomeModelo} × ${nomeItem}`, () => {
        expect(renderMessageTemplate(modelo, item)).toBe(scheduler.renderTemplate(modelo, item));
      });
    }
  }

  it("o modelo padrão com o item de exemplo completo sai como esperado", () => {
    expect(scheduler.renderTemplate(DEFAULT_MESSAGE_TEMPLATE, previewItem())).toBe([
      "🔥 *Smartphone Samsung Galaxy A55 256GB*",
      "",
      "De ~R$ 2.499,00~",
      "💰 Por *R$ 1.899,00*",
      "📉 24% OFF",
      "🎟️ Cupom: *GALAXY10*",
      "✅ Com cupom: *R$ 1.709,10*",
      "🚚 Frete grátis",
      "📦 1,2 mil vendidos",
      "",
      "🛒 https://merc.li/abc123",
    ].join("\n"));
  });

  it("o modelo padrão sem promoção e sem cupom não deixa buraco", () => {
    expect(scheduler.renderTemplate(DEFAULT_MESSAGE_TEMPLATE, previewItem({ promo: false, cupom: false }))).toBe([
      "🔥 *Smartphone Samsung Galaxy A55 256GB*",
      "",
      "💰 Por *R$ 1.899,00*",
      "🚚 Frete grátis",
      "📦 1,2 mil vendidos",
      "",
      "🛒 https://merc.li/abc123",
    ].join("\n"));
  });
});

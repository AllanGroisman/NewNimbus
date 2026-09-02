// O ID da campanha a partir do que foi colado na caixa "Trazer campanha por ID".
//
// O teste que importa é o do `_CustId_`: a URL do cupom traz DOIS números, e o
// primeiro é o vendedor. Pegar o errado não estoura nada — traz outro cupom, calado,
// depois de uma varredura da lista do ML com a conta do sistema.

import { describe, it, expect } from "vitest";
import { campanhaDoTexto } from "../data/cupomId";

describe("campanhaDoTexto", () => {
  it("o número solto, com ou sem o # que a tabela copia", () => {
    expect(campanhaDoTexto("13495993")).toBe("13495993");
    expect(campanhaDoTexto("#13495993")).toBe("13495993");
    expect(campanhaDoTexto("  13495993  ")).toBe("13495993");
  });

  it("na URL do cupom, quem manda é o coupon_campaign_id — não o _CustId_", () => {
    // A URL do próprio task 31. `2903552873` é o VENDEDOR; a campanha é `13495993`.
    expect(campanhaDoTexto("https://lista.mercadolivre.com.br/_CustId_2903552873?coupon_campaign_id=13495993"))
      .toBe("13495993");
  });

  it("o slug do _Container_ não vale como id — o parâmetro vale", () => {
    // O ML escolhe o slug (ml-cupons.js:118-122): "toys-e-babys" não diz id nenhum.
    expect(campanhaDoTexto("https://lista.mercadolivre.com.br/_Container_toys-e-babys?coupon_campaign_id=13471229"))
      .toBe("13471229");
    expect(campanhaDoTexto("https://lista.mercadolivre.com.br/_Container_toys-e-babys")).toBe(null);
  });

  it("sem o parâmetro, _Container_<números> ainda serve", () => {
    expect(campanhaDoTexto("https://lista.mercadolivre.com.br/_Container_13907402")).toBe("13907402");
    // O sufixo depois do traço é do ML, e não faz parte do id.
    expect(campanhaDoTexto("https://lista.mercadolivre.com.br/_Container_14063164-326431003")).toBe("14063164");
  });

  it("número curto demais é engano de quem digitou, não campanha", () => {
    // As campanhas do ML têm oito dígitos. Aceitar "12" custaria uma varredura da
    // lista de cupons com a conta do sistema para não achar nada.
    expect(campanhaDoTexto("12")).toBe(null);
    expect(campanhaDoTexto("#7")).toBe(null);
  });

  it("o que não é id nenhum vira null, sem inventar", () => {
    expect(campanhaDoTexto("")).toBe(null);
    expect(campanhaDoTexto(null)).toBe(null);
    expect(campanhaDoTexto("BRINQUEDOS")).toBe(null);
    expect(campanhaDoTexto("cupom de 20% off")).toBe(null);
    // Um link de PRODUTO não tem campanha nenhuma — e o MLB não é id de campanha.
    expect(campanhaDoTexto("https://produto.mercadolivre.com.br/MLB-1234567890-teste")).toBe(null);
  });
});

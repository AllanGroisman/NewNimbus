// O ID da campanha a partir do que a pessoa colou.
//
// O número da campanha chega de fora por dois caminhos: solto ("13495993", às vezes
// com o "#" que a tabela mostra) ou dentro do link do cupom. Puro de propósito — é o
// pedaço testável sem montar a tela, como os vizinhos `cupomCategorias` e
// `cupomRotulos`.
//
// Duas armadilhas moram na URL, e são a razão de isto não ser um `match(/\d+/)`:
//
//   https://lista.mercadolivre.com.br/_CustId_2903552873?coupon_campaign_id=13495993
//
// O PRIMEIRO número ali é o id do VENDEDOR, não o da campanha — pegá-lo traria o
// cupom errado, calado. E `_Container_toys-e-babys` é um slug que o ML escolhe, não
// um id (backend/scraping/ml-cupons.js:118-122). Quem manda, sempre, é o
// `coupon_campaign_id` — o mesmo campo que o backend usa para conferir se uma vitrine
// é mesmo a que se pediu (backend/scraping/ml-vitrine-landing.js:assinaturaDaVitrine).

// Quatro dígitos é o piso de quando o número está sendo DEDUZIDO (digitado, ou lido
// do caminho da URL): as campanhas do ML têm oito, e um "12" solto quase sempre é
// engano de quem digitou — engano que custaria uma varredura da lista de cupons com
// a conta do sistema. No `coupon_campaign_id` não há piso nenhum: ali o ML está
// dizendo o id com todas as letras, não há o que deduzir.
const DEDUZIDO = /^\d{4,}$/;

export function campanhaDoTexto(texto) {
  const t = String(texto || "").trim();
  if (!t) return null;

  // O número solto, com ou sem o "#" que a linha da tabela copia.
  const digitado = t.replace(/^#\s*/, "");
  if (DEDUZIDO.test(digitado)) return digitado;

  try {
    const u = new URL(t);
    const param = u.searchParams.get("coupon_campaign_id");
    if (param && /^\d+$/.test(param)) return param;
    // Sem o parâmetro, `_Container_<números>` ainda serve — mas só quando o que vem
    // depois é número: o slug (`_Container_toys-e-babys`) não diz id nenhum.
    const doCaminho = u.pathname.match(/_Container_(\d{4,})/i)?.[1];
    if (doCaminho) return doCaminho;
  } catch { /* não é URL — cai no null lá embaixo */ }

  return null;
}

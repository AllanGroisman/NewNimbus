# Nimbus — cupons no meu Chrome

## O que ela faz

Ela executa, numa aba do **seu** Chrome, as etapas de cupom do Mercado Livre que a
tela de admin pedir:

| Comando | Quem pede | O que faz |
| --- | --- | --- |
| `lista` | Admin › Cupom › Cupons do ML → “Puxar cupons no meu Chrome” | Abre uma página da lista de cupons e devolve o modelo dela. Clica em “Aplicar” nos cupons que o **servidor** escolher. |
| `raspar` | “no meu Chrome” de cada linha, e “Colher todas as vitrines” | Abre a vitrine do cupom, percorre as páginas e devolve os produtos. |
| `palavra` | Admin › Cupom › Descobrir palavra e Repasse | Digita a palavra no “Inserir código do cupom” e devolve o que o ML respondeu. |
| `checkout` | Admin › Cupom › Testar cupom (modo checkout) | Leva o produto ao checkout e aplica o código. **Nunca finaliza compra.** |
| `props` | diagnóstico | Lê o modelo (JSON) de uma página do ML. |

## Por que ela existe

O Mercado Livre responde CAPTCHA para **navegador automatizado**. As sondas do
projeto mostraram que isso acontece **mesmo fora da VPS** — não é o IP da máquina,
é o Puppeteer subindo Chrome. Numa aba do seu Chrome, com a sua sessão, as mesmas
páginas são só páginas.

E a página do admin, sozinha, não consegue ler o conteúdo de uma aba do Mercado
Livre: o navegador proíbe (mesma-origem). Extensão é a única peça com essa
permissão — é só para isso que ela existe.

## A regra que segura o desenho

> A extensão **colhe e executa**. Quem interpreta e decide é o servidor.

Ela devolve material cru — o JSON que a página carregou, o texto das telas, os
corpos das respostas do ML — e o backend faz o resto com as funções que já existem
lá (`parseFilterProps`, `aAtivar`, `lerRespostaDeCodigo`, `classifyCouponResult`).
Nenhuma delas é copiada para cá: regra duplicada é regra que diverge.

O caso que mostra por que isso importa: numa página real, dois cupons diferentes
tinham o **mesmo** rótulo “Aplicar cupom 8 por cento OFF INTERNACIONAL”. Clicar no
palpite ativa o cupom errado, e ativar é escrita irreversível na conta. Quem sabe
distinguir é o `aAtivar`, no servidor, olhando o modelo inteiro — então ele decide
e a extensão só clica no que vier.

## O que ela NÃO faz

- **Não guarda senha nem token.** Ela colhe e entrega para a página do admin; quem
  grava no sistema é o próprio site, com a sessão que você já tem aberta.
- **Não contorna verificação.** Se o Mercado Livre pedir CAPTCHA, ela traz a aba
  para a frente e espera **você** resolver. Não tenta de novo sozinha em laço.
- **Nunca compra.** No checkout ela só clica em rótulo do tipo “Continuar” — jamais
  em pagar/confirmar — e, se o caminho passou pelo carrinho, tira o item de lá.
- **Não roda em qualquer site.** Ela só lê páginas do `mercadolivre.com.br`, e só
  conversa com o endereço do próprio sistema (ver `content_scripts` no
  `manifest.json`).

## Os arquivos

| Arquivo | O quê |
| --- | --- |
| `background.js` | A porta: recebe o comando e despacha. É onde a lista de comandos vive. |
| `aba.js` | A aba de trabalho: abrir, esperar carregar, injetar, esperar o humano no muro, fechar. |
| `props.js` | Lê o modelo do nordic (`window._n.ctx.r`) — precisa do mundo da página. |
| `lista.js` | Uma página da lista de cupons, e o clique no “Aplicar”. |
| `vitrine.js` | O laço da vitrine de um cupom. |
| `colher.js` | Lê os cards de uma página de listagem. **Gêmeo** de `backend/scraping/scraper.js:harvestMLCards`. |
| `palavra.js` | O “Inserir código do cupom”, com um espião de XHR para pegar a resposta do ML. |
| `checkout.js` | O caminho até a tela do cupom no checkout. Porte de `backend/scraping/ml-coupon.js`. |
| `ponte.js` | O único ponto de contato com a página do admin (`postMessage`). |

## Instalar (uma vez)

1. Abra `chrome://extensions`
2. Ligue o **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** → escolha esta pasta (`extension/`)
4. Recarregue a aba do sistema. Os botões “no meu Chrome” ficam ativos.

Entre no Mercado Livre normalmente no mesmo Chrome — é a sua sessão que a aba usa.

## Se um botão continuar cinza

A tela pergunta à extensão **quais comandos** ela entende, então um botão cinza
costuma ser uma cópia antiga instalada. Nesse caso: ↻ na extensão e F5 na aba.

- A extensão está ligada em `chrome://extensions`?
- O endereço do sistema está em `content_scripts.matches` no `manifest.json`? Se
  você abre o admin por outro domínio (ngrok, por exemplo), acrescente-o ali e
  clique em recarregar (↻) na extensão.
- Depois de mexer no `manifest.json`, sempre: ↻ na extensão **e** F5 na aba.

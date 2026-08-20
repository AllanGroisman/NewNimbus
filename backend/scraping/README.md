# scraping/

Tudo relacionado a **pegar produtos das lojas** e **transformar links em links de afiliado**.

## Arquivos

- **`scraper.js`** — usa Puppeteer pra navegar nas páginas de ofertas de Mercado Livre, Amazon e Shopee e extrair os produtos. Define as constantes `CATEGORIES` (eletrônicos, casa, etc) e `STORES` (`ml`, `amazon`, `shopee`). No ML, `scrapeML` combina duas fontes — vitrine pública (`harvestMLVitrine`) e Hub de Afiliados — na ordem escolhida pelo admin.
- **`admin.js`** — o "admin-scraper": roda o `scraper.js` em loop, no intervalo configurado pelo admin, e dá `upsert` dos produtos no `catalog/`. Tem rotas `/api/admin/scraper/*` pra ligar, desligar e ver status.
- **`affiliate.js`** — converte URLs cruas em links de afiliado per-user e mantém cache + telemetria (último sucesso/falha por loja). Suporta:
  - **Mercado Livre**: API oficial de short link da ML (tag + cookie autenticado). Cache de 7 dias por (userId, link).
  - **Amazon**: anexa `?tag=<sua-tag>` na URL canônica `/dp/ASIN`. Extrai o ASIN com regex.
  - **Shopee**: GraphQL `open-api.affiliate.shopee.com.br` (App ID + App Secret). Cache de 7 dias.
- **`ml-hub.js`** — **Hub de Afiliados** do ML (`mercadolivre.com.br/afiliados/hub`), página que só existe logado. Confirma o acesso (`checkHubAccess`), coleta as ofertas (`scrapeHub`) e salva a página em disco (`dumpHub`). Usa a **sessão da conta do sistema** (ver abaixo), nunca o cookie de um usuário.
- **`ml-session-page.js`** — abre qualquer página do ML **com a sessão da conta do sistema**: Chrome com stealth, cookie injetado, listeners de rede instalados antes de navegar e a leitura de "o que apareceu" (`withMLSessionPage`, `snapshotPage`, `clickByText`, `clickByPattern`). Usado pelo `ml-hub.js` e pelo `ml-coupon.js` — errar a ordem (cookie ou listener depois do `goto`) não dá erro, dá página vazia sem explicação, por isso mora num lugar só.
- **`ml-coupon.js`** — testa um cupom do ML num produto (ver abaixo). `testCoupon` é o botão de Admin › Cupom; `dumpCoupon` salva o caminho inteiro em disco pra quando o ML mudar a tela.
- **`ml-cupons.js`** (plural) — a **aba de cupons** do ML (`mercadolivre.com.br/cupons`): puxa os cupons que a conta do sistema enxerga e, de cada um, os produtos da vitrine dele (ver abaixo). Nada a ver com o `ml-coupon.js`, que testa UM código no checkout. A gravação mora em `backend/coupons/` (`pg.js` = tabelas, `sync.js` = a rodada).
- **`affiliate-store/`** — façade (`index.js` + `pg.js`) pro storage per-user das configs de afiliado. Persiste em `affiliate_config` (Prisma) com cache em memória write-through. Expõe `getRaw(userId)`, `setRaw(userId, value)`, `clear(userId)`, `listShopeeConfigs()`, `warmup()`.

## Gating por afiliado

Se uma campanha usa Mercado Livre **ou Shopee** mas o afiliado não está configurado, o `scheduler.js` (função `affiliateGate` / `groupPausedByAffiliate`) pausa o grupo: não scrape, não envia. Amazon **não pausa** — cai pro link cru quando a tag está ausente.

Se o cookie do ML estiver presente mas expirado, o sistema cai pro link cru (diferente de "nunca configurou", que pausa).

No frontend, `groupUsesML()` em `data/constants.js` ajuda a renderizar o banner pra UI.

## Cuidado: sincronia com o frontend

`scraper.js` define `CATEGORIES` e `STORES`. O frontend tem cópias dessas listas em `frontend/src/data/constants.js`. **Adicionar uma categoria nova exige mexer nos dois lugares** — não há geração automática.

## Override por env var (dev / admin-scraper)

As envs `ML_AFFILIATE_TAG` + `ML_AFFILIATE_COOKIE`, `AMAZON_AFFILIATE_TAG`, `SHOPEE_AFFILIATE_APP_ID` + `SHOPEE_AFFILIATE_APP_SECRET` continuam funcionando como **override GLOBAL** (sobrescrevem qualquer config persistida). Quando setadas, o `affiliate.writeXxxConfig` rejeita escritas — pra mexer pela UI é preciso desligar as envs.

O admin-scraper (que roda fora de userId) usa env vars OU pega creds Shopee do primeiro usuário configurado via `affiliate.getScraperShopeeCreds()` → `affiliate-store.listShopeeConfigs()`.

## Sessão ML da conta do sistema (Hub de Afiliados)

**Duas coisas diferentes, de donos diferentes — não misture:**

| | onde fica | de quem é | pra que serve |
|---|---|---|---|
| cookie do cliente | `affiliate_config.ml.cookie` (por usuário) | do cliente | gerar link curto com a TAG dele |
| sessão do sistema | `app_config` chave `scraper-ml-admin` | nossa | abrir páginas que só existem logado (Hub) |

`affiliate.getScraperMLSession()` resolve a sessão do sistema: env **`ML_SCRAPER_COOKIE`** → sessão salva no admin → `null`. **De propósito não existe fallback pro cookie de nenhum usuário** — raspar com a conta de um cliente sem ele saber não é aceitável (o Shopee tem esse fallback por herança).

Onde se mexe: **Admin › Mercado Livre**, card "Conta do Mercado Livre do sistema" (salvar / testar acesso / apagar). Rotas: `GET|PUT|DELETE /api/admin/scraper/ml/session` e `POST /api/admin/scraper/ml/session/test`. O cookie nunca sai da API inteiro — só tamanho e prévia.

### Como a coleta do Hub funciona

O Hub **não é raspado do HTML**. A própria página busca as ofertas numa API interna
(`/affiliate-program/api/hub/search`) que devolve os cards prontos em JSON (formato
"polycard"): MLB do produto, URL, título, imagem, preço, preço anterior, "60% OFF",
`alt_text` de nota/vendas no mesmo formato da vitrine (por isso `polycardToProduct`
reusa `parseMLReviewCompacted`), selo "MAIS VENDIDO" e a comissão ("GANHOS 12%").

Chamar essa API por fora **não funciona** (GET → 404, POST → 403: falta o CSRF e os
cabeçalhos que o ML monta no navegador). Então `scrapeHub` abre o Hub no Chrome com
a sessão do sistema e **escuta as respostas** que a página busca sozinha, rolando
pra carregar mais (18 cards por resposta, teto de 15 rolagens).

O filtro por categoria é aplicado **clicando na interface** (o ML não aceita filtro
por URL): `HUB_CATEGORIES` mapeia as nossas 10 categorias para o `{ id, label }` do
menu do Hub. Se o clique não pegar, a coleta segue sem filtro e o log avisa —
degrada, não quebra.

O Hub **não é uma loja nova**: os produtos saem como `store: "Mercado Livre"` e o
`scrapeML` junta os dois conjuntos com `mergeNewProducts`, deduplicando pela chave
do catálogo (o MLB), porque o mesmo item aparece nos dois lugares com URLs
diferentes. Extras do Hub (`hub`, `commission`, `extraCommission`, `bestSeller`,
`mlItemId`) vão pro `payload` jsonb do catálogo. Hub fora do ar não derruba a coleta
da vitrine pública.

### As duas fontes e a ordem entre elas

O ML tem **duas fontes**: a vitrine pública (`harvestMLVitrine`, a coleta de
sempre) e o Hub. Quais estão ligadas e qual vem primeiro ficam em `app_config`
chave **`ml-scraper-sources`** = `{ vitrine, hub, priority }` (default: as duas
ligadas, prioridade `hub`) — chave separada da sessão do sistema de propósito,
senão apagar o cookie apagaria junto a preferência da vitrine. Quem tinha o
`hubEnabled` antigo (que morava dentro de `scraper-ml-admin`) herda o valor na
primeira leitura.

`affiliate.orderedMLSources()` devolve as fontes ativas já na ordem. O `scrapeML`
percorre essa ordem: a primeira coleta com alvo `limit`, filtra, ordena por
desconto e entra; a segunda só é chamada com o que **faltar** — se a primeira já
encheu a cota, a segunda nem abre navegador. Uma fonte que falhar (sessão
expirada, layout mudado) é logada e pulada; a outra segue.

Liga/desliga e prioridade: card "De onde vêm as ofertas" em Admin › Mercado Livre
(`GET|PUT /api/admin/scraper/ml/sources`). Desligar as duas é recusado — pra parar
o ML inteiro, use o admin-scraper.

Pra inspecionar o Hub quando algo parecer errado:

```
node scripts/ml-hub-dump.js                    # → backend/logs/ml-hub/<timestamp>/
node scripts/ml-hub-dump.js --category casa    # aplica o filtro antes de capturar
```

Grava `hub.html`, `hub.png`, `hub-xhr.json` (as respostas cruas da API),
`hub-cards.json` (os produtos já convertidos — é o que mostra na hora se o formato
mudou) e `hub-meta.json` (inclui as categorias que o Hub oferece hoje, pra conferir
o `HUB_CATEGORIES`). O cookie não vai pros arquivos.

## Testar cupom do ML (Admin › Cupom)

Existem **dois cupons diferentes** e o `ml-coupon.js` responde pelos dois:

1. O que a **loja oferece na própria página** (o "clipado"): aparece na PDP e dá pra
   ler sem sair do lugar. É o que o `scraper.js` joga fora de propósito — "10% com
   cupom" não pode virar o desconto do item (`extractDiscount`).
2. O **código escrito na legenda do grupo líder** (`repasse/capture.js:extractCoupon`).
   Esse não existe em lugar nenhum da página: a única forma de saber se ele vale pra
   aquele produto é levar o item ao **checkout** e aplicar o código lá.

Por isso a ferramenta tem dois modos — `leitura` (só a PDP) e `checkout` (leva até a
tela de pagamento). **A compra nunca é finalizada**: o fluxo para antes de pagar, o
navegador é fechado no `finally` e, se o caminho tiver passado pelo carrinho (plano B
quando o "Comprar agora" não aparece), o item é tirado de lá na saída.

O checkout é uma SPA, então o veredito bom vem da **resposta JSON** que a página
busca ao aplicar o cupom — o texto na tela é o segundo palpite. O sinal mais forte de
todos é o **total do pedido cair**: `classifyCouponResult` confia nisso antes de
qualquer frase, e "cupom aplicado" sem queda no total vira `indeterminado`, não
aprovação.

Desfechos: `valido`, `invalido`, `expirado`, `usado`, `nao-aplicavel`,
`minimo-nao-atingido`, `login`, `verificacao`, `captcha`, `indeterminado`.
**`indeterminado` é um desfecho legítimo** — quando o ML muda a tela, dizer "não deu
pra saber" é a resposta certa; fingir veredito aqui vira cupom morto indo pro grupo
lá na frente.

`login` e `verificacao` são coisas diferentes e a saída de cada uma é outra:

- `login` (`/gz/login`, "acesse sua conta") = a sessão venceu → **cole um cookie
  novo** em Admin › Mercado Livre.
- `verificacao` (`/gz/account-verification`) = o cookie está bom, a **conta** é que
  ficou de castigo por parecer robô → abra o ML no navegador com a conta do sistema,
  conclua a verificação e espere um pouco. Testes seguidos aumentam esse atrito, e é
  a **mesma conta do Hub** — se aparecer aqui, confira se o Hub ainda entra.

O caminho até o cupom, visto por dentro (18/08): **Escolha a forma de entrega →
Escolha quando sua compra chegará → Escolha como pagar**. O cupom mora na última, e
são **dois momentos**: um link "Inserir código do cupom" — que fica no **"Resumo da
compra"**, na coluna da direita, logo abaixo do frete, e não na lista de meios de
pagamento — e abre um **popup**, onde
se digita e se confirma em "Inserir" (outros layouts dizem "Adicionar"/"Aplicar"; a
regex de confirmar é ancorada, pra não casar com a linha que só abre o popup). Por
isso `openCouponField` espera até 12s
depois do clique (1,5s fotografava a tela velha) e sobe até 4 ancestrais atrás de
quem escuta o clique — o texto costuma estar num `<span>` no fundo da árvore, que
não escuta nada.

Os dois totais (antes/depois) são lidos **na mesma tela**, a do cupom. Ler o "antes"
na tela de entrega e o "depois" na de pagamento compara números diferentes (com e sem
frete), e uma queda dessas viraria "cupom válido" sem cupom nenhum ter entrado.

Nessa tela o resumo **não escreve "Total"**: escreve **"Você pagará"**, e mostra dois
valores lado a lado — o riscado (antes do desconto) e o que se paga. `extractCheckoutTotal`
entende os dois rótulos e fica com o **último** valor do par; lendo o riscado, o total
"não mudaria" nem com o cupom pegando, e sem o rótulo novo o antes/depois vinha `null`
justamente na única tela onde o cupom entra.

Do checkout até a tela do cupom, `advanceToCouponStep` só clica em "Continuar"
(regex **ancorada**, é o que garante que nada encoste em pagar/confirmar) e vai
anotando a **trilha**: tela por tela, o que marcou, o que clicou e por que parou.
Essa trilha aparece no resultado do admin — "Escolha a forma de entrega → Como você
quer pagar?" diz onde consertar; "parei depois de 4 passos" não dizia nada.
Cuidado com "Continuar **comprando**": é o link de voltar pra loja, não de avançar.

Um passo só conta como andado quando a **tela muda de verdade** (`waitForStepChange`,
comparando uma foto do texto da página). O botão "Continuar" fica desabilitado
enquanto o ML recalcula frete: clicar nele não faz nada, e sem essa verificação a
sonda gastava os 6 passos batendo na primeira tela e ainda relatava "andei 6 telas".
`clickByPattern` também ignora elementos `disabled`/`aria-disabled` pelo mesmo motivo.
Nas duas primeiras telas o endereço e a data já vêm escolhidos — mas nem sempre:
num teste o checkout abriu com **nenhuma opção marcada** (o print de `passo-1` mostra
os dois rádios vazios), e é por isso que `selectFirstOption` continua existindo.

Antes de clicar em "Continuar", espera a tela **parar de se mexer** (`waitForQuiet`).
Marcar a forma de entrega dispara recálculo de frete, e clicar no meio disso derruba
o checkout do ML na tela seguinte. Quando ele cai, a tela é "Ocorreu um problema /
tente novamente" com um código (`CHS37-...`): isso é reconhecido (`readCheckoutError`),
a sonda **recarrega e tenta mais uma vez**, e se cair de novo o motivo é
`checkout-quebrou` — com o código no resultado. Antes isso saía como "não existe
botão Continuar nessa tela", que é verdade e manda consertar o lugar errado: o
problema era do ML, não da ferramenta.

**Todo teste do admin já salva print de cada etapa** em
`backend/logs/ml-coupon/<ts>/` (`pdp`, `checkout`, `passo-N` — um por tela —,
`cupom-aberto`, `apos-cupom`), e o caminho aparece no resultado. Quando o veredito
sai "indeterminado", a pergunta seguinte é sempre "o que estava na tela?": antes só
o dump respondia isso, rodado depois, quando a tela já podia estar outra. Ficam as
**5 rodadas mais novas** (`pruneRuns`) — cada uma são uns 10 MB de página cheia — e
falhar em salvar nunca derruba o teste.

Quando quebrar, rode a sonda e olhe as páginas salvas — ela salva o **HTML** junto,
que é o que serve pra escrever seletor:

```
node scripts/ml-coupon-dump.js --url <link do produto> --code <CODIGO>
node scripts/ml-coupon-dump.js --url <link do produto> --mode leitura
```

Ela grava HTML + print de cada etapa (`pdp`, `checkout`, `passo-N` — um por tela do
checkout —, `apos-cupom`), todas as respostas JSON do ML e um resumo com o veredito
em `backend/logs/ml-coupon/<ts>/`.
Como o `dumpHub`, **nunca grava o cookie**.

Um teste por vez (cada um abre um Chrome e mexe na conta do sistema; dois
simultâneos dobram a chance de CAPTCHA e brigam pelo mesmo carrinho). Rotas:
`POST /api/admin/ml-coupon/test` e `GET /api/admin/ml-coupon/history`.

## Cupons do ML (Admin › Cupom › "Cupons do ML")

A aba `mercadolivre.com.br/cupons` lista os cupons que a **conta do sistema**
enxerga (na conta de hoje, ~2.600). O objetivo é saber **quais produtos cada cupom
cobre**, pra fila do repasse poder preferir produto que já vem com desconto extra.

### A página não é raspada do DOM

Ela é renderizada pelo framework *nordic* do ML e carrega o conteúdo inteiro num
JSON dentro dela: `window._n.ctx.r.appProps.pageProps`. Dali saem duas coisas:

- `landingData` — a vitrine da aba: `groupings[]` (~6 cupons por categoria),
  `shortcuts` (as 28 categorias), `totalCouponsQuantity` e, em
  `tracking.view.eventData.bundlers`, quantos cupons cada categoria tem.
- `filteredCouponsData` — a **lista cheia**, 30 cupons por página, com
  `pagination.total` (nº de páginas).

Ler o modelo (e não os cards) é o que dá `campaign_id`, valor, mínimo, teto,
validade, tipo de ativação e a URL da vitrine sem depender de um seletor.

### Como se chega na lista cheia

O botão "Ver mais 368 cupons" **não abre modal nem busca por XHR**: ele navega
para `…/cupons/filter?all=true&<grouping>=true`. Então o scraping navega direto,
paginando com `&page=N` (`filterUrl()`), e o teto por rodada é o
`limitPerGrouping` da config. Sem `grouping`, a lista é a da conta inteira.

Dois freios: `MAX_FILTER_PAGES` (40 páginas = 1.200 cupons por categoria) e
`MAX_PAGINAS_SEM_NOVIDADE` (5). O segundo existe por causa do filtro de loja
abaixo — com ele ligado uma página inteira pode não render cupom aproveitável, e
sem esse freio a rodada varreria as 40 páginas do teto de graça. Na prática, 60
cupons de campanha custam 3-4 páginas com o filtro ligado, contra 2 sem ele.

### Cupom ativado × não ativado (a regra que decide o resto)

| | `status.id` | `action` | `code` | vitrine |
|---|---|---|---|---|
| ativado | `ACTIVE` | `link` + URL | `""` | **sim** |
| não ativado | `INACTIVE` | `button` "Aplicar" | token base64 | **não** |

A URL da vitrine tem que vir do modelo: ela usa um **slug** do ML
(`_Container_toys-e-babys?coupon_campaign_id=13471229`), não o id da campanha —
montar `_Container_<campaignId>` devolve lista vazia (testado). Por isso
`containerUrlFor()` devolve `null` quando o cupom não veio com URL, e o cupom não
ativado simplesmente **não tem produto pra raspar**: pra ver a vitrine dele seria
preciso clicar "Eu quero", e isso **ativa o cupom na conta do sistema** — escrita,
não leitura. O robô nunca faz isso.

A vitrine em si é uma listagem comum do ML, então quem lê os cards é o
`harvestMLCards` do `scraper.js`. Duas armadilhas já pagas:

- **aba nova não herda o disfarce**: `applyAmazonStealth` é por página, e sem ele
  o `lista.mercadolivre.com.br` responde "Hubo un error accediendo a esta pagina"
  em vez da lista — foi assim que uma sonda leu "0 produtos" numa vitrine que, no
  navegador, mostrava 48;
- **a paginação é `_Desde_49` no caminho**, não `?page=` (`containerPageUrl`).

### Loja × campanha (e por que o cupom de loja é descartado)

O ML mistura na mesma aba dois bichos diferentes: o cupom **de campanha** ("Em
produtos selecionados", vale numa vitrine montada pelo ML) e o cupom **de uma
loja** ("Em produtos de Tecprintrp10", vale só pros produtos daquele vendedor). O
segundo não serve pra fila do repasse e é o **mais caro** da rodada: ele é
`AUTOMATIC`, ou seja, já vem ativado e sempre tem vitrine — sempre uma página do
Chrome aberta com a conta do sistema.

`detectScope()` decide com quatro sinais, nesta ordem:

| sinal | onde | força |
|---|---|---|
| `icon === "store"` | modelo cru | é o que o **próprio ML** usa pra desenhar o card; nas fixtures bate 100% |
| `is_new_follower_coupon` | só no camelCase | cupom de "novo seguidor" é de loja por definição |
| `_CustId_<sellerId>` | URL da vitrine | campanha usa `_Container_` |
| "Em produtos de X" | subtítulo | último recurso — mas é o único sinal do cupom de loja **não ativado**, que não tem URL |

O `icon` só chega aqui porque o `camelToRaw()` passou a preservá-lo: a
`/cupons/filter` serve **só camelCase**, e é por ela que passa quase toda a
coleta — o campo estava sendo jogado fora justamente no caminho que importa. O
que sustentou a classificação fica gravado em `ml_coupons.raw`.

O descarte acontece **dentro do `crawlFilter`**, antes de o cupom entrar na
lista: assim ele nunca vira página aberta, e o `limitPerGrouping` passa a contar
**só cupom de campanha**. Liga/desliga em `skipStoreCoupons` (config da rodada,
default ligado); a sonda (`dumpCupons`) continua enxergando tudo, que é o que uma
sonda tem que fazer.

### O cupom-palavra (tipo CUPOM100)

**Os cupons dessa aba não têm palavra.** Eles são `EU_QUERO` (o cliente clica) ou
`AUTOMATIC`. O campo `code` do modelo é um **token base64 de ativação**, amarrado
à conta logada — guardado como `activationToken`, nunca mostrado como código.

A palavra existe em outro lugar: o campo **"Inserir código do cupom"** da mesma
página. Ela **não pode ser enumerada**, só testada — e o ML responde com
`response_code` (`INVALID_1`, `EXPIRED_ACTION`…) e o **`campaign_id`** da campanha
a que ela pertence. É isso que liga a palavra que veio na legenda do grupo líder
(`repasse/capture.js:extractCoupon`) à lista de produtos do cupom. O que foi
testado fica em `ml_coupon_codes` (com contador), e quando resolve, a palavra é
carimbada no `ml_coupons.code`.

### Onde os dados ficam

- `ml_coupons` — o cupom (PK `campaign_id`).
- `ml_coupon_products` — o vínculo cupom ↔ produto pelo `productKey` do catálogo.
- `ml_coupon_codes` — as palavras testadas e a resposta do ML.
- `catalog_products.couponCampaignId` — **coluna**, não payload: o upsert do
  scraping reescreve o payload inteiro (`catalog/pg.js:toRow`), então o cupom
  sumiria na rodada seguinte. Só a sincronização de cupons escreve nela, e ela
  limpa o carimbo de campanha vencida (`coupons/pg.js:syncCatalogCoupons`).

**Apagar tudo** (botão "🗑 Apagar todos" da aba, `DELETE /api/admin/ml-cupons`)
zera `ml_coupons`, `ml_coupon_products` e o carimbo do catálogo — nessa ordem,
porque `couponCampaignId` é coluna solta e não some por cascata. O que **não**
some é `ml_coupon_codes`: cada palavra ali custou um Chrome aberto com a conta do
sistema, e ela volta a carimbar o cupom na rodada seguinte
(`restampCodesFromChecks`, chamado no fim de toda rodada). A rota recusa (409) se
houver rodada correndo — apagar no meio é apagar o que ela está gravando.

Na fila do repasse isso vira `group.scraping.couponBoost` ∈ `off` (default) |
`prefer` | `only`, lido em `scheduler.js:couponMode`. `only` vira `hasCoupon` no
WHERE do catálogo; `prefer` busca 3× o lote e põe quem tem cupom na frente sem
bagunçar a ordem escolhida pela campanha.

### `{preco_com_cupom}` na mensagem

O modelo de mensagem tem a variável `{preco_com_cupom}`: o preço **já com o
desconto do cupom**. A conta é o `precoComCupom` do `coupons/price.js` — puro, sem
banco: recebe o preço e a linha de `ml_coupons` (`kind`, `value`, `minPurchase`,
`maxDiscount`, `startsAt`, `expiresAt`) e devolve o preço final ou `null`.

O `null` é o coração da coisa. Ele aparece quando o cupom venceu, quando ainda não
começou, quando o produto está **abaixo da compra mínima** ou quando o `kind` veio
`unknown`/`desconhecido` — e nesses casos o `{preco_com_cupom}` sai **igual ao
`{preco}`**, sem apagar linha e sem "—". Anunciar um desconto que o ML não daria é
o cliente clicando e pagando mais caro; preço normal em silêncio é a resposta
certa. O teto (`maxDiscount`) entra como `Math.min` no desconto, não no preço.

Quem chama é o `sendItem` (`scheduler.js`), no **envio**, não no refill: o item
fica dias em `group.queue` e o cupom vence nesse meio-tempo, então guardar
valor/validade no payload da fila seria promessa velha. `couponRuleForItem` lê o
cupom na hora, nesta ordem — a **palavra** do item (`findCouponByCode`, que é o
caso do repasse e do cupom digitado à mão na fila), depois `couponCampaignId`,
depois `couponsForKeys` pela chave do produto — e nada disso roda fora do Mercado
Livre, porque cupom do ML não desconta produto da Amazon nem da Shopee (uma palavra
igual nas duas lojas anunciaria um preço que não existe). O terceiro passo não é
redundância:
`couponCampaignId` só é preenchido quando `couponBoost` ≠ `off`, e `off` é o
default — sem ele a variável nunca calcularia nada na campanha comum.

### A sonda

```
node scripts/ml-cupons-dump.js
node scripts/ml-cupons-dump.js --grouping tb_vertical --limit 60
node scripts/ml-cupons-dump.js --container 13471229
node scripts/ml-cupons-dump.js --code BRINQUEDOS
```

Grava em `backend/logs/ml-coupons/<ts>/`: `cupons.html`/`cupons.png`,
`cupons-model.json` (o landingData cru), `filter-props.json` + `filter.html` (a
lista cheia), `cupons-parsed.json` (já convertido), `cupons-xhr.json` (tudo que a
página buscou), `container-items.json` (a vitrine de um cupom) e
`cupons-meta.json` com o veredito e as contagens. Como o `dumpHub`, **nunca grava
o cookie** — e nunca ativa cupom.

Rotas: `GET/PUT /api/admin/ml-cupons/config`, `POST /api/admin/ml-cupons/run`
(responde 202 — a rodada dura minutos e o front acompanha pelo
`GET /api/admin/ml-cupons/status`), `POST /api/admin/ml-cupons/run/cancel`,
`GET /api/admin/ml-cupons`, `GET /api/admin/ml-cupons/:campaignId/produtos`,
`POST /api/admin/ml-cupons/:campaignId/sync-produtos`,
`POST /api/admin/ml-cupons/code`, `GET /api/admin/ml-cupons/codes` e
`DELETE /api/admin/ml-cupons` (apagar todos; 409 se houver rodada correndo).

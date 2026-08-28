# Coletor de vitrine — a extensão

## O que ela faz

Quando você clica em **“raspar no meu Chrome”** na tela *Admin › Cupom › Cupons do
ML*, ela abre a vitrine daquele cupom numa aba em segundo plano, lê os produtos,
percorre as páginas seguintes e devolve a lista para a tela — que grava no sistema
com o seu login normal.

## Por que ela existe

A vitrine de um cupom (`lista.mercadolivre.com.br/_Container_…`) responde CAPTCHA
para navegador automatizado. As sondas do projeto mostraram que isso acontece
**mesmo fora da VPS** — não é o IP da máquina, é o Puppeteer subindo Chrome. Numa
aba do seu Chrome, com a sua sessão, a página é só uma página.

E a página do admin, sozinha, não consegue ler o conteúdo de uma aba do Mercado
Livre: o navegador proíbe (mesma-origem). Extensão é a única peça com essa
permissão — é só para isso que ela existe.

## O que ela NÃO faz

- **Não guarda senha nem token.** Ela colhe e entrega para a página do admin; quem
  grava no sistema é o próprio site, com a sessão que você já tem aberta.
- **Não contorna verificação.** Se o Mercado Livre pedir CAPTCHA, ela traz a aba
  para a frente e espera **você** resolver. Não tenta de novo sozinha em laço.
- **Não roda em qualquer site.** Ela só lê páginas do `mercadolivre.com.br`, e só
  conversa com o endereço do próprio sistema (ver `content_scripts` no
  `manifest.json`).

## Instalar (uma vez)

1. Abra `chrome://extensions`
2. Ligue o **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** → escolha esta pasta (`extension/`)
4. Recarregue a aba do sistema. O botão “raspar no meu Chrome” fica ativo.

Entre no Mercado Livre normalmente no mesmo Chrome — é a sua sessão que a aba usa.

## Se o botão continuar cinza

- A extensão está ligada em `chrome://extensions`?
- O endereço do sistema está em `content_scripts.matches` no `manifest.json`? Se
  você abre o admin por outro domínio (ngrok, por exemplo), acrescente-o ali e
  clique em recarregar (↻) na extensão.
- Depois de mexer no `manifest.json`, sempre: ↻ na extensão **e** F5 na aba.

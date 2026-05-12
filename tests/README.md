# tests/

Bateria automatizada de testes do Nimbus. Roda o backend inteiro em memória (sem subir porta) e usa um WhatsApp fake (mock) pra não enviar mensagens de verdade.

## Como rodar

Da raiz do projeto:

```bat
test.bat
```

Ou direto:

```bash
cd tests
npm install     # primeira vez
npm test        # roda tudo
npm run test:unit         # só unitários (rápido)
npm run test:integration  # só integração
npm run test:journey      # só jornada completa
npm run test:watch        # roda em watch mode
```

A suite leva ~20s no total, ~83 testes.

## Pastas

- **`unit/`** — testes de funções puras (sem IO). Ex.: `productKey` do catálogo, extração de ASIN.
- **`integration/`** — testes do backend rodando de verdade (Express + storage JSON em tmpdir + mocks de WhatsApp). Sobem o app via `supertest`. Cobrem auth, state, catalog, scheduler, affiliate.
- **`journey/`** — uma jornada completa: registro → afiliado → catálogo → campanha → refill → envio → reset. É o teste de "tudo junto".
- **`helpers/`** — utilidades dos testes:
  - `env.js` — seta `NODE_ENV=test`, cria um `NIMBUS_DATA_DIR` temporário, etc. **Importar primeiro em qualquer teste**.
  - `wa-mock.js` — instala um mock no lugar do módulo `backend/whatsapp` antes do server carregar. Toda chamada de envio fica registrada em `calls` pra os testes inspecionarem.
  - `app.js` — helper único que importa o backend já configurado pra teste.
  - `fixtures.js` — geradores de objetos de teste (produto, grupo, etc).

## O que NÃO está coberto

- Scraping real (Puppeteer abrindo browser).
- WhatsApp real (Baileys conectando).
- UI do React (não há teste visual).

## Dica pra iniciante

Se você mexer no backend e algo quebrar, rode `test.bat` antes de subir. É a melhor rede de proteção. Se um teste passar localmente mas falhar depois, geralmente é problema de estado entre arquivos — o `env.js` cria diretório isolado por worker pra evitar isso, mas ainda dá ruim quando o mock do WhatsApp não é resetado entre testes (`resetWa()` no `beforeEach`).

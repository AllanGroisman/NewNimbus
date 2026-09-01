// Testar uma PALAVRA de cupom, pelo caminho que estiver disponível.
//
// Existem dois, e a escolha entre eles é a razão deste arquivo existir:
//
//   1. a extensão, numa aba do Chrome do próprio admin — o ML responde CAPTCHA
//      para navegador automatizado, então este é o caminho que funciona;
//   2. o servidor (`POST /ml-cupons/code`), que abre o próprio Chrome — continua
//      existindo para quando ninguém está com a extensão instalada.
//
// Duas telas pedem isso (Descobrir palavra e Repasse). A regra de qual caminho
// tentar mora aqui e não nelas: duas cópias divergiriam, e a diferença apareceria
// como "a mesma palavra responde coisas diferentes dependendo da aba".
//
// Em qualquer um dos caminhos, quem LÊ a resposta do ML é o servidor. A extensão
// devolve os corpos crus que a página buscou; o veredito sai da mesma função pura
// nos dois casos (`ml-cupons.js:lerRespostaDeCodigo`).
import { coletorEntende, testarPalavraNoChrome } from "./coletor";
import { adminMlCuponsTestWord, adminMlCuponsLocalPalavra } from "./api";

export async function testarPalavra(word, { force = false, source = "admin", onProgresso } = {}) {
  const code = String(word || "").trim().toUpperCase();
  if (!code) throw new Error("Escreva a palavra do cupom.");

  if (await coletorEntende("palavra")) {
    const colhido = await testarPalavraNoChrome(code, { onProgresso });

    // O ML pediu verificação na aba do admin. Cair para o servidor aqui seria
    // insistir com a mesma conta por um caminho que apanha MAIS — o navegador
    // automatizado é justamente o que ele barra.
    if (colhido.muro) {
      throw new Error(colhido.motivo || "O Mercado Livre pediu verificação — resolva na aba que abriu e tente de novo.");
    }

    if (colhido.respostas?.length) {
      const r = await adminMlCuponsLocalPalavra({
        word: code, respostas: colhido.respostas, bodyText: colhido.bodyText || "", source, force,
      });
      return { ...(r.result || {}), via: "extensao" };
    }
    // Sem muro e sem resposta: a página mudou de forma (não achou o campo, por
    // exemplo). Aí vale tentar o servidor, que lê a página por outro caminho.
  }

  const r = await adminMlCuponsTestWord(code, force, source);
  return { ...(r.result || {}), via: "servidor" };
}

// Carregador de ambiente por MODO. Fonte única da ordem de carga do dotenv.
//
// Modos:
//   prod  (default) — usa só o backend/.env (valores compartilhados + produção).
//   ngrok           — sobrepõe o .env com backend/.env.ngrok (domínio ngrok,
//                     prefixo de backup próprio, etc.).
//
// O modo é escolhido pela env NIMBUS_MODE, setada pelos scripts de boot
// (deploy/start_normal.sh = prod, deploy/ngrok_start.sh = ngrok).
//
// override:true em ambas as cargas garante que os VALORES DO ARQUIVO sempre
// vençam env herdado/persistido pelo PM2 — boot determinístico mesmo alternando
// entre modos sem stop.sh.

const path = require("path");
const dotenv = require("dotenv");

const dir = path.join(__dirname, "..");

// quiet:true silencia as dicas que o dotenv v17 imprime no stdout — senão
// poluem logs do PM2 e a captura da URL efetiva no start.sh.
// Base compartilhada + defaults de PRODUÇÃO.
dotenv.config({ path: path.join(dir, ".env"), override: true, quiet: true });

const mode = (process.env.NIMBUS_MODE || "prod").toLowerCase();
if (mode !== "prod") {
  // .env.<mode> (ex.: .env.ngrok). Se não existir, dotenv só no-opa.
  dotenv.config({ path: path.join(dir, `.env.${mode}`), override: true, quiet: true });
}

module.exports = { mode };

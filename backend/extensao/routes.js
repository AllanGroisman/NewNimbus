// Admin › Extensão — entrega a extensão "Nimbus — cupons no meu Chrome" (pasta
// `extension/` na raiz) para o admin instalar ou atualizar pelo próprio sistema.
//
// "Instalar direto" não existe: fora da Chrome Web Store o Chrome só aceita
// extensão carregada sem compactação, e ela não se atualiza sozinha. O que dá é
// baixar o zip, extrair por cima da pasta de antes e clicar ↻.
//
// Tanto o zip quanto a versão saem da pasta NA HORA, sem cache nem etapa de
// empacotamento: o backend roda no host e enxerga o checkout, então um
// `git pull` já é a "publicação" da versão nova.
//
// Tudo autenticado: a tela baixa com fetch + Bearer (não com <a href>), então
// o arquivo não precisa da chave por query que o Downloader usa.
const express = require("express");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const auth = require("../auth");
const httpErrors = require("../infra/httpErrors");

const EXT_DIR = path.join(__dirname, "..", "..", "extension");

const router = express.Router();
router.use(auth.requireAuth, auth.requireAdmin);

function lerManifest() {
  const m = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  return { nome: m.name || null, versao: m.version || null };
}

router.get("/info", (req, res) => {
  try {
    res.json(lerManifest());
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/extensao/info" });
  }
});

router.get("/zip", (req, res) => {
  let versao;
  try {
    versao = lerManifest().versao;
  } catch (err) {
    return httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/extensao/zip" });
  }
  res.attachment(`nimbus-extensao-${versao || "atual"}.zip`);
  const zip = archiver("zip", { zlib: { level: 9 } });
  zip.on("error", (err) => res.destroy(err));
  zip.pipe(res);
  // Arquivos na raiz do zip: o "Extrair tudo" do Windows já cria a pasta com o
  // nome do arquivo, e um nível a mais faria o "Carregar sem compactação"
  // apontar para a pasta errada (sem manifest.json).
  zip.directory(EXT_DIR, false);
  zip.finalize();
});

module.exports = router;
module.exports.EXT_DIR = EXT_DIR;

// Cifra dos dumps antes de saírem da máquina.
//
// Os dumps contêm tudo: hashes de senha, e-mails, credenciais de afiliado e a
// tabela baileys_auth (sessões de WhatsApp). Eles são enviados pro Backblaze B2
// e pro Google Drive — dois lugares fora do nosso controle, protegidos só por
// chaves de API. Cifrar aqui significa que vazar o bucket não vaza os dados.
//
// A cifra é aplicada só na saída: o dump local continua .sql.gz normal, porque
// ele vive na mesma máquina que o banco (cifrar lá, com a chave ao lado, não
// acrescentaria nada) e porque os scripts de restauração local dependem do
// formato atual.
//
// BACKUP_ENC_KEY = 32 bytes em hex. Sem a variável, o envio segue em claro
// (comportamento anterior) e o chamador avisa.
//
// ATENÇÃO: sem a chave, os arquivos cifrados na nuvem são irrecuperáveis.
// Guarde uma cópia fora do servidor — se o servidor for embora, a chave vai
// junto e o backup deixa de servir pra exatamente o caso que ele existe.

const crypto = require("crypto");

// Cabeçalho identifica o formato e permite detectar arquivo cifrado sem depender
// só da extensão.
const MAGIC = Buffer.from("NIMBUSENC1");
const IV_LEN = 12;
const TAG_LEN = 16;

const ENC_SUFFIX = ".enc";

function getKey() {
  const raw = String(process.env.BACKUP_ENC_KEY || "").trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(`BACKUP_ENC_KEY inválida: ${buf.length} bytes, esperado 32 (64 chars hex)`);
  }
  return buf;
}

function isEnabled() {
  return getKey() !== null;
}

// Layout: MAGIC | IV(12) | TAG(16) | ciphertext
function encryptBuffer(plain) {
  const key = getKey();
  if (!key) throw new Error("BACKUP_ENC_KEY não definida");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

function looksEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function decryptBuffer(enc) {
  const key = getKey();
  if (!key) throw new Error("Arquivo cifrado, mas BACKUP_ENC_KEY não está definida");
  if (!looksEncrypted(enc)) throw new Error("Arquivo não está no formato cifrado do Nimbus");
  let off = MAGIC.length;
  const iv = enc.subarray(off, off += IV_LEN);
  const tag = enc.subarray(off, off += TAG_LEN);
  const ct = enc.subarray(off);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  // .final() lança se o conteúdo foi adulterado — GCM autentica, não só cifra.
  return Buffer.concat([d.update(ct), d.final()]);
}

module.exports = { ENC_SUFFIX, isEnabled, encryptBuffer, decryptBuffer, looksEncrypted };

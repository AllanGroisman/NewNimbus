// Telefone — validação e normalização.
//
// O telefone é obrigatório desde o cadastro: é o único canal fora do e-mail
// para falar com o dono da conta, e num sistema de WhatsApp ele precisa ser um
// CELULAR de verdade. Guardamos SÓ os dígitos COM o 55 na frente
// (5511999999999), que é o formato que whatsapp/local.js consome em
// jidFromPhone e o que a UI assume ao renderizar `+${phone}`.
//
// O mesmo algoritmo está espelhado em frontend/src/data/phone.js, para o campo
// avisar o usuário antes de bater no servidor. Se mudar aqui, mude lá.

// DDDs que existem de fato. A lista pega erro de digitação que um regex
// genérico (\d{2}) deixaria passar — é o equivalente, aqui, ao dígito
// verificador do CPF.
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// Mesma semântica do normalizePhone de whatsapp/local.js: só tira o que não é
// dígito, sem julgar o resultado. Quem valida é isValidPhone.
function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

// Devolve 55 + DDD + 9 dígitos, ou "" se não for um celular brasileiro.
// Aceita as quatro formas que a pessoa digita: "(11) 99999-9999",
// "11999999999", "5511999999999" e "+55 11 99999-9999".
function toStoredPhone(value) {
  let d = normalizePhone(value);
  // Tira o 55 do país só quando o que sobra tem cara de celular — senão um
  // número que começa com DDD 55 (Rio Grande do Sul) perderia o DDD.
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 11) return "";
  if (!DDDS.has(Number(d.slice(0, 2)))) return "";
  // Nono dígito: celular no Brasil começa com 9. Fixo é recusado de propósito —
  // o número existe para virar uma conversa de WhatsApp.
  if (d[2] !== "9") return "";
  return `55${d}`;
}

function isValidPhone(value) {
  return toStoredPhone(value) !== "";
}

// 5511999999999 → (11) 99999-9999. Para mostrar de volta pro dono e nas telas
// de admin, que senão exibem a string crua com o 55 colado.
function formatPhone(value) {
  const stored = toStoredPhone(value);
  if (!stored) return normalizePhone(value);
  const d = stored.slice(2);
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// ── Telefone de uma conta de WhatsApp (≠ telefone de cadastro) ──────────────
//
// Mais frouxo que o toStoredPhone acima, DE PROPÓSITO. Aquele existe pro cadastro
// ("todo cliente tem um celular") e exige o nono dígito. Aqui o número precisa
// bater EXATAMENTE com a conta que o WhatsApp conhece, e existem contas antigas
// com 8 dígitos ativas até hoje — 555596168060 é uma delas, é a que quebrou o
// primeiro teste do código de pareamento. Acrescentar um 9 que a conta não tem
// gera um código perfeitamente válido para um número que não existe.
//
// Mesma regra do looksLikePhoneUser de scripts/fix-lid-sessions.js (55 + DDD +
// 8|9 dígitos), aqui aplicada ao que a pessoa digita.
function toWhatsappPhone(value) {
  let d = normalizePhone(value);
  if ((d.length === 13 || d.length === 12) && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return "";
  if (!DDDS.has(Number(d.slice(0, 2)))) return "";
  // Celular de 9 dígitos começa com 9; o de 8 começa em 6-9 (as faixas móveis).
  // Fixo continua recusado: não vira conversa de WhatsApp.
  if (d.length === 11 && d[2] !== "9") return "";
  if (d.length === 10 && !"6789".includes(d[2])) return "";
  return `55${d}`;
}

function isWhatsappPhone(value) {
  return toWhatsappPhone(value) !== "";
}

// 555596168060 → (55) 9616-8060 | 5511999999999 → (11) 99999-9999
function formatWhatsappPhone(value) {
  const stored = toWhatsappPhone(value);
  if (!stored) return normalizePhone(value);
  const d = stored.slice(2);
  const meio = d.length === 11 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, meio)}-${d.slice(meio)}`;
}

module.exports = {
  normalizePhone, toStoredPhone, isValidPhone, formatPhone,
  toWhatsappPhone, isWhatsappPhone, formatWhatsappPhone,
};

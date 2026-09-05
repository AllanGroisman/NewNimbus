// Implementação Postgres do módulo auth.
//   - Usuários numa tabela com unique constraint em email (race-free).
//   - syncRole roda como UPDATE direto se necessário.
//   - JWT secret persistido em AppConfig (key "jwt_secret"); env JWT_SECRET tem prioridade.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../db");
const appConfig = require("../config");
const mailer = require("./mailer");
const emails = require("../notifications/email");
const { normalizeCpf, isValidCpf, maskCpf } = require("../utils/cpf");
const { toStoredPhone, isValidPhone } = require("../utils/phone");
// Só os módulos puros de billing: `../billing` puxaria provision/notify, que
// requerem este arquivo de volta.
const billingLimits = require("../billing/limits");
const enforce = require("../billing/enforce");
const stripe = require("../billing/stripe");

// Limites e regras de input padronizadas (compartilhadas com o frontend via copy).
const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 254;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;

// Custo do bcrypt. Hash guarda o próprio custo, então subir aqui não invalida as
// senhas já gravadas — elas continuam conferindo, e são regravadas com o custo
// novo na próxima troca.
//
// Em teste o custo cai pro mínimo: 12 rounds levam ~485 ms por senha e quase
// todo teste de integração cria um usuário, o que fazia do bcrypt o item mais
// caro da suíte inteira. Com 4 rounds são ~3 ms, e o que os testes verificam
// (hash grava, compare confere) continua idêntico. Mesmo critério já usado nos
// rate limiters, que também viram no-op sob NODE_ENV=test.
const BCRYPT_ROUNDS = process.env.NODE_ENV === "test" ? 4 : 12;

const EMAIL_VERIFY_TTL_MS    = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS  = 60 * 60 * 1000;     // 1h
const RESEND_COOLDOWN_MS     = 2 * 60 * 1000;       // 2 min entre reenvios
const EMAIL_CHANGE_TTL_MS    = 60 * 60 * 1000;      // 1h — igual ao reset de senha

// Janela de silêncio dos avisos de segurança: trocar a senha três vezes seguidas
// não deve render três e-mails iguais. Vale por (usuário, tipo de aviso).
const SECURITY_EMAIL_THROTTLE_MS = 10 * 60 * 1000;  // 10 min

function validatePassword(password) {
  const s = String(password || "");
  if (s.length < MIN_PASSWORD_LEN) {
    throw new Error(`Senha precisa ter ao menos ${MIN_PASSWORD_LEN} caracteres`);
  }
  if (s.length > MAX_PASSWORD_LEN) {
    throw new Error(`Senha não pode ter mais que ${MAX_PASSWORD_LEN} caracteres`);
  }
  if (!/[a-z]/.test(s)) throw new Error("Senha precisa ter ao menos uma letra minúscula");
  if (!/[A-Z]/.test(s)) throw new Error("Senha precisa ter ao menos uma letra maiúscula");
  if (!/[0-9]/.test(s)) throw new Error("Senha precisa ter ao menos um número");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || "").trim().toLowerCase());
}

// Beta fechado: admin pode desligar novos cadastros. Flag global em AppConfig
// (key "registration-blocked", { blocked: bool }), lida do cache síncrono.
function isRegistrationBlocked() {
  return appConfig.get("registration-blocked")?.blocked === true;
}

// Barra criação de conta quando o cadastro está bloqueado. Emails em
// ADMIN_EMAILS sempre passam (pra você nunca ficar travado pra fora).
function assertRegistrationAllowed(email) {
  if (isRegistrationBlocked() && !isAdminEmail(email)) {
    const err = new Error("Cadastro temporariamente indisponível. Estamos em beta fechado.");
    err.code = "registration_blocked";
    throw err;
  }
}

// Conta admin garantida no boot: cria se não existir, e mantém role=admin.
// Configurada via env DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD.
//
// A senha é usada SÓ na criação. Antes, ela era re-aplicada a cada boot, o que
// tornava impossível trocar a senha do admin pela interface — a troca voltava no
// próximo restart, e a senha efetiva era sempre a que estava no .env.
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || "").trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "";
const DEFAULT_ADMIN_NAME = process.env.DEFAULT_ADMIN_NAME || "Admin";

async function seedDefaultAdmin() {
  if (!DEFAULT_ADMIN_EMAIL) return;

  const existing = await findByEmail(DEFAULT_ADMIN_EMAIL);

  if (existing) {
    // Só garante o role — a senha em uso é a que o admin definiu, não a do .env.
    if (existing.role === "admin") return;
    await prisma().user.update({
      where: { id: existing.id },
      data: { role: "admin" },
    });
    invalidateUser(existing.id);
    console.log(`[auth] seed: admin ${DEFAULT_ADMIN_EMAIL} — role restaurado`);
    return;
  }

  // Daqui pra baixo é só o bootstrap da primeira instalação (admin não existe).
  if (!DEFAULT_ADMIN_PASSWORD) {
    console.warn(`[auth] seed: admin ${DEFAULT_ADMIN_EMAIL} não existe e DEFAULT_ADMIN_PASSWORD está vazia — pulando`);
    return;
  }
  try {
    validatePassword(DEFAULT_ADMIN_PASSWORD);
  } catch (err) {
    console.warn(`[auth] seed pulado: DEFAULT_ADMIN_PASSWORD fraca — ${err.message}`);
    return;
  }

  await prisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name: DEFAULT_ADMIN_NAME,
      email: DEFAULT_ADMIN_EMAIL,
      phone: "",
      passwordHash: await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS),
      role: "admin",
      emailVerified: true,
    },
  }).catch(err => {
    if (err.code === "P2002") return; // race com outro processo (worker)
    throw err;
  });
  console.log(`[auth] seed: admin ${DEFAULT_ADMIN_EMAIL} criado`);
}

let _jwtSecret = process.env.JWT_SECRET || null;
// Sessão expira por inatividade: token curto renovado enquanto há atividade
// (sliding session). O frontend chama /api/auth/refresh a cada atividade (com
// throttle); ficando ocioso, o token vence e a próxima request cai em 401.
const TOKEN_TTL = "2h";

// Carrega (ou gera+persiste) o JWT secret na tabela AppConfig.
// Chamar no boot ANTES de qualquer sign/verify. Idempotente.
async function warmup() {
  if (_jwtSecret) return;
  const row = await prisma().appConfig.findUnique({ where: { key: "jwt_secret" } });
  if (row && typeof row.value === "string" && row.value.length > 0) {
    _jwtSecret = row.value;
    return;
  }
  const secret = crypto.randomBytes(48).toString("hex");
  await prisma().appConfig.upsert({
    where: { key: "jwt_secret" },
    create: { key: "jwt_secret", value: secret },
    update: {},
  });
  _jwtSecret = secret;
}

// Garante que a conta admin definida em DEFAULT_ADMIN_* exista e esteja sincronizada.
// Chamada no boot do server.js e do worker.js.
async function bootSeed() {
  await seedDefaultAdmin();
}

function getJwtSecret() {
  if (!_jwtSecret) throw new Error("[auth] JWT secret não inicializado — chame auth.warmup() no boot");
  return _jwtSecret;
}

function publicUser(u) {
  if (!u) return null;
  // Tokens de e-mail ficam de fora: quem os tem em mãos verifica a conta,
  // reseta a senha ou confirma a troca de e-mail — não têm por que trafegar
  // no /me. pendingEmail (só o endereço) fica, é o que a tela de conta mostra.
  const {
    passwordHash, emailVerifyToken, passwordResetToken, pendingEmailToken, ...rest
  } = u;
  if (!rest.role) rest.role = "user";
  // CPF nunca volta inteiro pro cliente: quem digitou já sabe o número, e o
  // mascarado basta pra pessoa reconhecer o próprio documento. cpfRequired é o
  // que faz o painel pedir o CPF de quem tem conta anterior à regra.
  rest.cpfRequired = !rest.cpf && rest.role !== "admin";
  rest.cpf = rest.cpf ? maskCpf(rest.cpf) : null;
  // Telefone é obrigatório desde o cadastro. phoneRequired marca quem ficou de
  // fora da regra (conta antiga, conta criada pelo Google, conta provisionada
  // sem o número) — o painel pede na entrada, deixando pular; o checkout não.
  // Não é mascarado como o CPF: Configurações e o admin já mostram o número.
  rest.phoneRequired = !isValidPhone(rest.phone) && rest.role !== "admin";
  return rest;
}

// Cache pequeno pra requireAuth (chamado em toda request) não bater no DB sempre.
const _userCache = new Map(); // id → { user, ts }
const USER_TTL = 30_000;
function cacheUser(u) { if (u) _userCache.set(u.id, { user: u, ts: Date.now() }); }
function invalidateUser(id) { _userCache.delete(id); }
function getCachedUser(id) {
  const e = _userCache.get(id);
  if (e && Date.now() - e.ts < USER_TTL) return e.user;
  return null;
}

async function findByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return prisma().user.findUnique({ where: { email: e } });
}

async function findById(id) {
  return prisma().user.findUnique({ where: { id } });
}

// CPF é gravado só com dígitos, então a busca normaliza antes de comparar.
async function findByCpf(cpf) {
  const digits = normalizeCpf(cpf);
  if (digits.length !== 11) return null;
  return prisma().user.findUnique({ where: { cpf: digits } });
}

// Grava o CPF de uma conta que ainda não tem (contas anteriores à regra, ou
// criadas por um pagamento em que o documento não chegou). Não sobrescreve:
// trocar de CPF é mudar de dono, e isso passa pelo admin.
async function setCpf(userId, cpf) {
  const digits = normalizeCpf(cpf);
  if (!isValidCpf(digits)) {
    const err = new Error("CPF inválido");
    err.code = "invalid_cpf";
    throw err;
  }
  const user = await findById(userId);
  if (!user) throw new Error("Usuário não encontrado");
  if (user.cpf) {
    if (user.cpf === digits) return publicUser(user);
    const err = new Error("Esta conta já tem um CPF cadastrado. Fale com o suporte para alterar.");
    err.code = "cpf_locked";
    throw err;
  }

  const updated = await prisma().user.update({
    where: { id: userId },
    data: { cpf: digits },
  }).catch(err => {
    if (err.code === "P2002") {
      const e = new Error("Já existe uma conta com este CPF.");
      e.code = "cpf_taken";
      throw e;
    }
    throw err;
  });
  invalidateUser(userId);
  cacheUser(updated);
  return publicUser(updated);
}

// Grava o telefone de uma conta que ainda não tem um válido. Ao contrário do
// CPF, NÃO é write-once: número de celular troca de dono, e o campo já é
// editável em Configurações — travar aqui só criaria caso de suporte.
async function setPhone(userId, phone) {
  const stored = toStoredPhone(phone);
  if (!stored) {
    const err = new Error("Informe um telefone válido (DDD + celular)");
    err.code = "invalid_phone";
    throw err;
  }
  const updated = await prisma().user.update({
    where: { id: userId },
    data: { phone: stored },
  }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  cacheUser(updated);
  return publicUser(updated);
}

// Sync com cache pra requireAuth (sync) — versão async da consulta original.
async function findByIdFresh(id) {
  const u = await findById(id);
  cacheUser(u);
  return u;
}

async function syncRole(user) {
  if (!user) return user;
  const expected = isAdminEmail(user.email) ? "admin" : (user.role === "admin" ? "admin" : "user");
  if (user.role !== expected && (expected === "admin" || !user.role)) {
    user.role = expected;
    await prisma().user.update({ where: { id: user.id }, data: { role: expected } });
    invalidateUser(user.id);
  } else if (!user.role) {
    user.role = "user";
  }
  return user;
}

async function register({ name, email, password, phone }) {
  email = normalizeEmail(email);
  name = String(name || "").trim();
  password = String(password || "");

  if (!name) throw new Error("Nome obrigatório");
  if (name.length > MAX_NAME_LEN) throw new Error(`Nome não pode ter mais que ${MAX_NAME_LEN} caracteres`);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email inválido");
  if (email.length > MAX_EMAIL_LEN) throw new Error(`Email não pode ter mais que ${MAX_EMAIL_LEN} caracteres`);
  // Telefone obrigatório: conta nova não nasce mais sem canal de WhatsApp.
  const storedPhone = toStoredPhone(phone);
  if (!storedPhone) {
    const err = new Error("Informe um telefone válido (DDD + celular)");
    err.code = "invalid_phone";
    throw err;
  }
  validatePassword(password);

  assertRegistrationAllowed(email);

  const existing = await findByEmail(email);
  if (existing) throw new Error("Já existe uma conta com este email");

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const verifyToken = newToken();
  const user = await prisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name,
      email,
      phone: storedPhone,
      passwordHash,
      role: isAdminEmail(email) ? "admin" : "user",
      emailVerified: false,
      emailVerifyToken: verifyToken,
      emailVerifyExpires: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    },
  });

  // Envio do email (atualmente só loga link no console). Se falhar, conta
  // já foi criada — usuário pode pedir reenvio.
  mailer.sendVerificationEmail({ to: email, name, token: verifyToken })
    .catch(err => console.error("[auth] sendVerificationEmail:", err.message));

  return publicUser(user);
}

async function login({ email, password }) {
  email = normalizeEmail(email);
  password = String(password || "");
  const user = await findByEmail(email);
  if (!user) throw new Error("Email ou senha incorretos");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error("Email ou senha incorretos");
  if (user.suspended) {
    const err = new Error("Conta suspensa. Entre em contato com o suporte.");
    err.code = "account_suspended";
    throw err;
  }
  if (user.emailVerified === false) {
    const err = new Error("Email ainda não verificado. Confira sua caixa de entrada.");
    err.code = "email_not_verified";
    throw err;
  }
  await syncRole(user);
  cacheUser(user);
  const token = signToken(user);
  return { token, user: publicUser(user) };
}

// Confirma email a partir do token enviado por email. Retorna { token, user }
// (auto-login) pra UX fluida. Idempotente: se já estava verificado, devolve sucesso.
async function verifyEmail({ token }) {
  if (!token || typeof token !== "string") throw new Error("Token inválido");
  const user = await prisma().user.findUnique({ where: { emailVerifyToken: token } });
  if (!user) throw new Error("Link de verificação inválido ou já usado");
  if (user.emailVerifyExpires && user.emailVerifyExpires.getTime() < Date.now()) {
    throw new Error("Link de verificação expirado — peça um novo");
  }
  const updated = await prisma().user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpires: null,
    },
  });
  invalidateUser(user.id);
  await syncRole(updated);
  cacheUser(updated);
  const jwtToken = signToken(updated);
  return { token: jwtToken, user: publicUser(updated) };
}

// Gera um novo token de verificação e dispara email. Idempotente — não revela
// se a conta existe ou não (sempre devolve ok).
async function resendVerification({ email }) {
  email = normalizeEmail(email);
  if (!email) return { ok: true };
  const user = await findByEmail(email);
  if (!user || user.emailVerified) return { ok: true };

  // Cooldown: deriva quando o último email foi enviado a partir de emailVerifyExpires.
  // lastSentAt = emailVerifyExpires - EMAIL_VERIFY_TTL_MS
  if (user.emailVerifyExpires) {
    const lastSentAt = user.emailVerifyExpires.getTime() - EMAIL_VERIFY_TTL_MS;
    const elapsed = Date.now() - lastSentAt;
    if (elapsed < RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      const err = new Error(`Aguarde ${retryAfterSeconds}s antes de solicitar outro email.`);
      err.code = "resend_cooldown";
      err.retryAfterSeconds = retryAfterSeconds;
      throw err;
    }
  }

  const verifyToken = newToken();
  await prisma().user.update({
    where: { id: user.id },
    data: {
      emailVerifyToken: verifyToken,
      emailVerifyExpires: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    },
  });
  mailer.sendVerificationEmail({ to: email, name: user.name, token: verifyToken })
    .catch(err => console.error("[auth] sendVerificationEmail:", err.message));
  return { ok: true };
}

// Solicita reset de senha — sempre devolve ok (não revela se email existe).
async function requestPasswordReset({ email }) {
  email = normalizeEmail(email);
  if (!email) return { ok: true };
  const user = await findByEmail(email);
  if (!user) return { ok: true };
  const resetToken = newToken();
  await prisma().user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: resetToken,
      passwordResetExpires: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  });
  mailer.sendPasswordResetEmail({ to: email, name: user.name, token: resetToken })
    .catch(err => console.error("[auth] sendPasswordResetEmail:", err.message));
  return { ok: true };
}

// Aplica nova senha a partir de token de reset. Token vira inválido após uso.
// Auto-login no final (já que a pessoa provou ser dona do email).
async function resetPassword({ token, newPassword }) {
  if (!token || typeof token !== "string") throw new Error("Token inválido");
  validatePassword(newPassword);
  const user = await prisma().user.findUnique({ where: { passwordResetToken: token } });
  if (!user) throw new Error("Link de reset inválido ou já usado");
  if (user.passwordResetExpires && user.passwordResetExpires.getTime() < Date.now()) {
    throw new Error("Link de reset expirado — peça um novo");
  }
  const updated = await prisma().user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS),
      passwordResetToken: null,
      passwordResetExpires: null,
      // Reset implica que a pessoa controla o email — verifica também.
      emailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpires: null,
      // Derruba as sessões abertas: quem tiver roubado um token perde o acesso
      // no reset, em vez de continuar renovando indefinidamente.
      tokenVersion: { increment: 1 },
    },
  });
  invalidateUser(user.id);
  await syncRole(updated);
  cacheUser(updated);
  emails.sendAsync(
    "password_reset_done",
    { to: updated.email, name: updated.name, userId: updated.id },
    { throttleMs: SECURITY_EMAIL_THROTTLE_MS },
  );
  const jwtToken = signToken(updated);
  return { token: jwtToken, user: publicUser(updated) };
}

// Login via Google ID token. Verifica o token contra o endpoint oficial do Google
// (tokeninfo) — valida assinatura, expiração e audience contra GOOGLE_CLIENT_ID.
// Se o usuário não existir, cria automaticamente com passwordHash random
// (Google-only: não consegue entrar por senha, só por Google).
// Se já existir (registro tradicional por email), apenas faz login.
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();

async function loginWithGoogle({ idToken }) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("Login Google não configurado no servidor (GOOGLE_CLIENT_ID ausente)");
  }
  if (!idToken || typeof idToken !== "string") {
    throw new Error("ID token Google ausente");
  }

  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  let res, info;
  try {
    res = await fetch(url);
    info = await res.json();
  } catch (err) {
    throw new Error("Falha ao validar token Google: " + err.message);
  }
  if (!res.ok) {
    throw new Error("Token Google inválido: " + (info?.error_description || info?.error || res.statusText));
  }

  if (info.aud !== GOOGLE_CLIENT_ID) {
    throw new Error("Token Google emitido para outro app (audience inválida)");
  }
  if (info.exp && Number(info.exp) * 1000 < Date.now()) {
    throw new Error("Token Google expirado");
  }
  if (info.email_verified !== true && info.email_verified !== "true") {
    throw new Error("Email Google não verificado");
  }

  const email = String(info.email || "").trim().toLowerCase();
  const name = String(info.name || info.given_name || email.split("@")[0] || "Usuário").trim();
  if (!email) throw new Error("Token Google sem email");

  let user = await findByEmail(email);
  if (!user) {
    // Conta nova via Google entra no bloqueio de cadastro (usuário já existente
    // continua logando normalmente).
    assertRegistrationAllowed(email);
    // Cria conta nova — passwordHash random (Google-only).
    const randomPass = crypto.randomBytes(32).toString("hex");
    user = await prisma().user.create({
      data: {
        id: crypto.randomUUID(),
        name,
        email,
        phone: "",
        passwordHash: await bcrypt.hash(randomPass, BCRYPT_ROUNDS),
        role: isAdminEmail(email) ? "admin" : "user",
        // Google já validou o email — pula verificação.
        emailVerified: true,
      },
    }).catch(async err => {
      if (err.code === "P2002") return findByEmail(email); // race
      throw err;
    });
  }

  // Se já tinha conta mas não estava verificada, Google attesta — marca verificada.
  if (user && user.emailVerified === false) {
    user = await prisma().user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyToken: null, emailVerifyExpires: null },
    });
    invalidateUser(user.id);
  }
  await syncRole(user);
  cacheUser(user);
  const token = signToken(user);
  return { token, user: publicUser(user), created: !user.createdAt || (Date.now() - new Date(user.createdAt).getTime() < 5000) };
}

// Janela do link "defina sua senha" mandado pra quem assinou pela landing.
// Maior que o reset normal (1h) porque este e-mail é a única credencial da
// pessoa até ela criar a senha — 1h é pouco pra quem paga e fecha o navegador.
const SETUP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Cria (ou recupera) a conta de quem pagou ANTES de ter cadastro — o caminho
// landing → Stripe → sistema. Difere de register() em três pontos, todos
// justificados pelo pagamento já aprovado:
//   - não passa por assertRegistrationAllowed: quem pagou entra mesmo com o
//     beta fechado, senão a pessoa é cobrada e fica sem acesso;
//   - nasce com emailVerified=true — pagar com cartão naquele e-mail já é
//     prova de posse mais forte que o clique no link de verificação;
//   - senha aleatória (mesma ideia da conta criada pelo Google), com um token
//     de "defina sua senha" pro e-mail de boas-vindas.
// Idempotente: e-mail que já tem conta é devolvido como está (created=false).
async function createPaidUser({ email, name, cpf, phone }) {
  email = normalizeEmail(email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email inválido");
  const displayName = String(name || "").trim().slice(0, MAX_NAME_LEN)
    || email.split("@")[0];
  // CPF veio da metadata do checkout. Se estiver ausente ou torto, a conta
  // nasce sem ele e o sistema pede na primeira entrada — a assinatura foi paga
  // e não pode ficar sem dono por causa de um campo.
  const digits = isValidCpf(cpf) ? normalizeCpf(cpf) : null;
  // Mesma regra do CPF para o telefone: veio torto da metadata, a conta nasce
  // sem ele e o painel pede depois. Pagamento aprovado não pode virar conta
  // inexistente por causa de um campo.
  const storedPhone = toStoredPhone(phone);

  const existing = await findByEmail(email);
  if (existing) {
    // Conta que já existe pode estar sem CPF (é anterior à regra, ou o
    // pagamento anterior não trouxe um) — este checkout preenche a lacuna.
    const fill = {};
    if (existing.emailVerified === false) {
      // Conta que existia mas nunca confirmou o e-mail: o pagamento confirma.
      Object.assign(fill, { emailVerified: true, emailVerifyToken: null, emailVerifyExpires: null });
    }
    if (digits && !existing.cpf) fill.cpf = digits;
    if (storedPhone && !isValidPhone(existing.phone)) fill.phone = storedPhone;
    if (!Object.keys(fill).length) return { user: existing, created: false, setPasswordToken: null };

    const updated = await prisma().user.update({
      where: { id: existing.id },
      data: fill,
    }).catch(async err => {
      // O CPF foi tomado por outra conta no meio do caminho: grava o resto.
      if (err.code === "P2002" && fill.cpf) {
        delete fill.cpf;
        if (!Object.keys(fill).length) return existing;
        return prisma().user.update({ where: { id: existing.id }, data: fill });
      }
      throw err;
    });
    invalidateUser(existing.id);
    cacheUser(updated);
    return { user: updated, created: false, setPasswordToken: null };
  }

  const setPasswordToken = newToken();
  const randomPass = crypto.randomBytes(32).toString("hex");
  let user = await prisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name: displayName,
      email,
      phone: storedPhone,
      ...(digits ? { cpf: digits } : {}),
      passwordHash: await bcrypt.hash(randomPass, BCRYPT_ROUNDS),
      role: isAdminEmail(email) ? "admin" : "user",
      emailVerified: true,
      passwordResetToken: setPasswordToken,
      passwordResetExpires: new Date(Date.now() + SETUP_PASSWORD_TTL_MS),
    },
  }).catch(async err => {
    // Race com o webhook (ou com um segundo clique): a conta já existe.
    if (err.code === "P2002") {
      const byEmail = await findByEmail(email);
      if (byEmail) return byEmail;
      // Colidiu no CPF, não no e-mail. O pagamento está feito, então a conta
      // nasce sem CPF em vez de ficar sem existir — o duplicado é resolvido
      // depois, no aviso que o painel dá pra quem está sem documento.
      return prisma().user.create({
        data: {
          id: crypto.randomUUID(),
          name: displayName,
          email,
          phone: storedPhone,
          passwordHash: await bcrypt.hash(randomPass, BCRYPT_ROUNDS),
          role: isAdminEmail(email) ? "admin" : "user",
          emailVerified: true,
          passwordResetToken: setPasswordToken,
          passwordResetExpires: new Date(Date.now() + SETUP_PASSWORD_TTL_MS),
        },
      });
    }
    throw err;
  });

  const created = user?.passwordResetToken === setPasswordToken;
  cacheUser(user);
  return { user, created, setPasswordToken: created ? setPasswordToken : null };
}

// Emite sessão pra um usuário já autenticado por outro meio (hoje: resgate do
// checkout público, onde a prova é o id da Checkout Session paga).
async function issueSession(user) {
  await syncRole(user);
  cacheUser(user);
  return { token: signToken(user), user: publicUser(user) };
}

// Fonte única do formato do token. `tv` carrega a versão de sessão do usuário —
// requireAuth compara com a do banco e recusa se não bater, que é o mecanismo de
// expulsar sessões antigas em troca de senha, reset e suspensão.
function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, tv: user.tokenVersion ?? 0 },
    getJwtSecret(),
    { expiresIn: TOKEN_TTL, algorithm: "HS256" }
  );
}

function verifyToken(token) {
  // algorithms fixo: sem isso a lib aceita qualquer algoritmo que o próprio
  // token declarar, o que abre confusão de algoritmo se o segredo mudar de tipo.
  try { return jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }); }
  catch { return null; }
}

// Emite um token novo com o TTL padrão. Usado pela rota /api/auth/refresh para
// deslizar a janela de sessão enquanto o usuário está ativo (mesma assinatura
// de token usada em login()).
function reissueToken(user) {
  return signToken(user);
}

// Sobe a versão de sessão: todos os tokens já emitidos pro usuário param de
// valer na próxima request. Devolve o usuário atualizado.
async function bumpTokenVersion(userId) {
  const updated = await prisma().user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
  invalidateUser(userId);
  return updated;
}

// requireAuth precisa ser sync na assinatura externa — express middleware.
// Async internamente: aceitamos esse custo pra evitar mudar todas as rotas.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "Não autorizado" });

  const cached = getCachedUser(payload.sub);
  const handle = (user) => {
    if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
    if (user.suspended) return res.status(403).json({ error: "Conta suspensa.", code: "account_suspended" });
    // Token emitido antes da última troca de senha / reset / suspensão.
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Sessão encerrada. Entre novamente.", code: "session_revoked" });
    }
    syncRole(user)
      .then(() => {
        req.user = publicUser(user);
        next();
      })
      .catch(err => {
        console.error("[auth] syncRole:", err.message);
        req.user = publicUser(user);
        next();
      });
  };

  if (cached) {
    handle(cached);
  } else {
    findByIdFresh(payload.sub)
      .then(handle)
      .catch(err => {
        console.error("[auth] findById:", err.message);
        res.status(500).json({ error: "Erro de autenticação" });
      });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso restrito a administradores" });
  }
  next();
}

async function updateProfile(userId, updates) {
  const data = {};
  if (updates.name !== undefined) data.name = String(updates.name).trim();
  // Telefone passa pela mesma régua do cadastro — este era o ponto por onde
  // entrava qualquer texto no campo.
  if (updates.phone !== undefined) {
    const stored = toStoredPhone(updates.phone);
    if (!stored) {
      const err = new Error("Informe um telefone válido (DDD + celular)");
      err.code = "invalid_phone";
      throw err;
    }
    data.phone = stored;
  }
  const user = await prisma().user.update({ where: { id: userId }, data }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  return publicUser(user);
}

async function changePassword(userId, { currentPassword, newPassword }) {
  validatePassword(newPassword);
  const user = await findById(userId);
  if (!user) throw new Error("Usuário não encontrado");
  const ok = await bcrypt.compare(String(currentPassword || ""), user.passwordHash);
  if (!ok) throw new Error("Senha atual incorreta");
  const updated = await prisma().user.update({
    where: { id: userId },
    // tokenVersion sobe junto: trocar a senha encerra as outras sessões abertas.
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS),
      tokenVersion: { increment: 1 },
    },
  });
  invalidateUser(userId);
  cacheUser(updated);
  emails.sendAsync(
    "password_changed",
    { to: updated.email, name: updated.name, userId: updated.id },
    { throttleMs: SECURITY_EMAIL_THROTTLE_MS },
  );
  // Token novo pra quem trocou continuar logado — só as OUTRAS sessões caem.
  return { token: signToken(updated) };
}

// ── Troca de email ──────────────────────────────────────────────────────
// O email é a identidade de login, então a troca é em dois tempos: aqui só
// estaciona o endereço novo e manda o link PARA ELE. Enquanto ninguém clicar,
// o login continua no email antigo — errar a digitação não tranca ninguém
// fora da conta. Pede a senha atual porque uma sessão esquecida aberta não
// pode bastar pra levar a conta embora.
async function requestEmailChange(userId, { password, newEmail }) {
  const email = normalizeEmail(newEmail);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email inválido");
  const user = await findById(userId);
  if (!user) throw new Error("Usuário não encontrado");
  const ok = await bcrypt.compare(String(password || ""), user.passwordHash);
  if (!ok) {
    const err = new Error("Senha incorreta");
    err.code = "invalid_password";
    throw err;
  }
  if (email === normalizeEmail(user.email)) throw new Error("Este já é o email da sua conta");
  const existing = await findByEmail(email);
  if (existing) {
    // Não é vazamento: quem chegou aqui provou a senha da própria conta.
    const err = new Error("Já existe uma conta com este email");
    err.code = "email_taken";
    throw err;
  }

  const token = newToken();
  await prisma().user.update({
    where: { id: userId },
    data: {
      pendingEmail: email,
      pendingEmailToken: token,
      pendingEmailExpires: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
    },
  });
  invalidateUser(userId);
  await mailer.sendEmailChangeEmail({ to: email, name: user.name, token, currentEmail: user.email });
  // Aviso ao endereço ANTIGO: quem confirma é o novo, mas quem precisa ficar
  // sabendo — e reagir, se não foi ele — é o dono do endereço atual.
  emails.sendAsync(
    "email_change_requested",
    { to: user.email, name: user.name, userId, newEmail: email },
    { dedupeKey: `email_change_requested:${userId}:${token}` },
  );
  return { ok: true, pendingEmail: email };
}

// Efetiva a troca. Chamado pelo link do email novo, sem exigir sessão: o token
// é a prova, e quem trocou de email pode muito bem estar em outro navegador.
async function confirmEmailChange(token) {
  if (!token || typeof token !== "string") throw new Error("Link inválido");
  const user = await prisma().user.findUnique({ where: { pendingEmailToken: token } });
  if (!user) throw new Error("Link de troca de email inválido ou já usado");

  const clearPending = { pendingEmail: null, pendingEmailToken: null, pendingEmailExpires: null };
  if (user.pendingEmailExpires && user.pendingEmailExpires.getTime() < Date.now()) {
    await prisma().user.update({ where: { id: user.id }, data: clearPending });
    invalidateUser(user.id);
    throw new Error("Link expirado — peça a troca de email novamente");
  }
  const email = normalizeEmail(user.pendingEmail);
  if (!email) throw new Error("Link de troca de email inválido ou já usado");

  const updated = await prisma().user.update({
    where: { id: user.id },
    data: {
      email,
      // Clicar no link já é a prova de que o endereço existe e é dela.
      emailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpires: null,
      ...clearPending,
      // A identidade mudou: as sessões abertas (inclusive a que pediu a troca)
      // caem e a pessoa volta pelo login já com o email novo.
      tokenVersion: { increment: 1 },
    },
  }).catch(err => {
    if (err.code === "P2002") {
      // Alguém tomou o endereço entre o pedido e o clique.
      const e = new Error("Já existe uma conta com este email");
      e.code = "email_taken";
      throw e;
    }
    throw err;
  });
  invalidateUser(user.id);
  // ADMIN_EMAILS é por endereço — trocar de email pode dar (ou tirar) o admin.
  await syncRole(updated);
  cacheUser(updated);
  emails.sendAsync(
    "email_changed",
    { to: user.email, name: updated.name, userId: user.id, newEmail: email },
    { dedupeKey: `email_changed:${user.id}:${token}` },
  );
  return { ok: true, user: publicUser(updated), previousEmail: user.email };
}

// Define a PRIMEIRA senha de quem nunca escolheu uma — hoje só as contas
// criadas pelo pagamento (createPaidUser), que nascem com senha aleatória.
// Não pede a senha atual (a pessoa não tem uma), então a autorização é a
// sessão já aberta MAIS o token de definição de senha ainda pendente: assim
// que a senha existe, este caminho fecha e a troca volta a ser changePassword.
async function setInitialPassword(userId, newPassword) {
  validatePassword(newPassword);
  const user = await findById(userId);
  if (!user) throw new Error("Usuário não encontrado");
  if (!user.passwordResetToken) {
    throw new Error("Esta conta já tem senha — use a troca de senha informando a atual");
  }
  const updated = await prisma().user.update({
    where: { id: userId },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS),
      // Queima o token do e-mail de boas-vindas: o link não vale mais.
      passwordResetToken: null,
      passwordResetExpires: null,
      emailVerified: true,
      tokenVersion: { increment: 1 },
    },
  });
  invalidateUser(userId);
  cacheUser(updated);
  return { token: signToken(updated), user: publicUser(updated) };
}

// Versão async — server.js precisará adaptar pra await em algumas rotas admin.
// Mantemos a sincrona "findById" interna com cache pra requireAuth.

// O admin precisa da linha CRUA da assinatura — `maskCrossMode` existe pra
// proteger o app do usuário, e aplicá-la aqui esconderia justamente o caso que o
// admin precisa enxergar. Em vez de mascarar, anexamos o veredito: qual plano
// vale agora e se a linha é de outro modo do Stripe (a que aparecia como um
// "Pro" verde enquanto o resto do sistema tratava a conta como free).
function decorateSubscription(sub) {
  if (!sub) return null;
  return {
    ...sub,
    // "user" de propósito: effectivePlanId devolve business pra qualquer admin,
    // e aqui a pergunta é o que a ASSINATURA vale, não o que o cargo concede.
    effectivePlanId: billingLimits.effectivePlanId(sub, "user"),
    graceEndsAt: billingLimits.graceEndsAt(sub),
    // Cortesia do admin (trial manual): a lista e a ficha mostram o selo a partir
    // daqui em vez de refazer conta de data no navegador. `effectivePlanId` acima
    // já reflete a cortesia quando ela é o que vale.
    manualTrialActive: billingLimits.manualTrialActive(sub),
    manualTrialDaysLeft: billingLimits.manualTrialDaysLeft(sub),
    crossMode: sub.stripeMode && sub.stripeMode !== stripe.mode() ? sub.stripeMode : null,
  };
}

// Uma campanha só está de fato ativa quando o dono não a pausou E o plano não a
// pausou. `_count.groups` sozinho contava as duas pausadas junto com as vivas —
// era isso que fazia a aba de usuários prometer atividade que não existia.
function summarizeGroups(groups, planPaused) {
  let active = 0, repasse = 0;
  for (const g of groups || []) {
    if (g.scraping?.kind === "repasse") repasse++;
    if (g.paused) continue;
    if (enforce.isGroupPlanPaused(planPaused, g.id)) continue;
    active++;
  }
  return { active, repasse };
}

async function listUsers() {
  const users = await prisma().user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      subscription: true,
      state:   { select: { planPaused: true } },
      groups:  { select: { id: true, paused: true, scraping: true } },
      numbers: { select: { id: true, label: true, phone: true } },
    },
  });
  // Status ao vivo das sessões, uma leitura só pra lista inteira (SCAN no Redis
  // ou o Map em memória) — sem isso seria um round-trip por usuário.
  let sessionsByUser = {};
  try { sessionsByUser = await require("../whatsapp").listAllSessions(); }
  catch { /* o status é acessório: a lista não pode cair porque o WhatsApp caiu */ }

  return users.map(u => {
    // Os includes entram no spread do publicUser — tirar aqui evita devolver o
    // array de campanhas inteiro em cada linha da lista.
    const { subscription, state, groups, numbers, ...row } = u;
    const { active, repasse } = summarizeGroups(groups, state?.planPaused);
    const sessions = sessionsByUser[u.id] || [];
    const byNumberId = new Map(sessions.map(s => [String(s.numberId), s]));
    return {
      ...publicUser(row),
      subscription: decorateSubscription(subscription),
      // Os telefones vêm na própria lista: identificar de qual número se trata
      // era o único motivo pra abrir a ficha de um usuário por vez.
      numbers: numbers.map(n => {
        const live = byNumberId.get(String(n.id));
        return {
          id: n.id,
          label: n.label,
          phone: n.phone,
          status: live?.status || "offline",
          stuck: live?.stuck || false,
        };
      }),
      counts: {
        groups: groups.length,
        activeGroups: active,
        repasseGroups: repasse,
        numbers: numbers.length,
        // Conta NÚMEROS do painel que estão conectados, não sessões. Uma sessão
        // provisória órfã (id `Date.now()` de um QR abandonado) tem sessão sem
        // linha em whatsapp_numbers e inflava o card "Operando" do admin.
        connectedNumbers: numbers.filter(
          n => byNumberId.get(String(n.id))?.status === "connected",
        ).length,
      },
    };
  });
}

async function deleteUser(userId) {
  await prisma().user.delete({ where: { id: userId } }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  return true;
}

async function adminSetPassword(userId, newPassword) {
  validatePassword(newPassword);
  const updated = await prisma().user.update({
    where: { id: userId },
    // Admin resetando a senha de alguém encerra as sessões daquela pessoa —
    // é o caminho usado quando se suspeita que a conta foi comprometida.
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS),
      tokenVersion: { increment: 1 },
    },
  }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  // O dono da conta precisa saber que a senha dele mudou sem ele ter pedido —
  // é isso que separa um atendimento de suporte de um sequestro de conta.
  emails.sendAsync(
    "admin_password_set",
    { to: updated.email, name: updated.name, userId },
    { throttleMs: SECURITY_EMAIL_THROTTLE_MS },
  );
  return true;
}

async function setUserRole(userId, role) {
  if (role !== "admin" && role !== "user") throw new Error("Role inválida");
  const user = await prisma().user.update({ where: { id: userId }, data: { role } }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  return publicUser(user);
}

async function adminVerifyEmail(userId) {
  const user = await prisma().user.update({
    where: { id: userId },
    data: { emailVerified: true, emailVerifyToken: null, emailVerifyExpires: null },
  }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  return publicUser(user);
}

async function adminSetSuspended(userId, suspended) {
  const user = await prisma().user.update({
    where: { id: userId },
    // Ao suspender, sobe a versão de sessão: o cache de usuário do requireAuth
    // tem 30s de validade e é por processo, então sem isso a conta suspensa
    // continuaria passando por até meio minuto.
    data: {
      suspended,
      suspendedAt: suspended ? new Date() : null,
      ...(suspended ? { tokenVersion: { increment: 1 } } : {}),
    },
  }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
  if (suspended) {
    // suspendedAt na chave: uma segunda suspensão (depois de reativar) é outro
    // evento e merece outro aviso; repetir a mesma suspensão não.
    emails.sendAsync(
      "account_suspended",
      { to: user.email, name: user.name, userId },
      { dedupeKey: `account_suspended:${userId}:${user.suspendedAt?.toISOString?.() || ""}` },
    );
  } else {
    emails.sendAsync(
      "account_reactivated",
      { to: user.email, name: user.name, userId },
      { throttleMs: SECURITY_EMAIL_THROTTLE_MS },
    );
  }
  return publicUser(user);
}

async function adminResendVerification(userId) {
  const user = await prisma().user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Usuário não encontrado");
  if (user.emailVerified) throw new Error("Email já verificado");
  const verifyToken = newToken();
  await prisma().user.update({
    where: { id: userId },
    data: { emailVerifyToken: verifyToken, emailVerifyExpires: new Date(Date.now() + EMAIL_VERIFY_TTL_MS) },
  });
  mailer.sendVerificationEmail({ to: user.email, name: user.name, token: verifyToken })
    .catch(err => console.error("[auth] adminResendVerification:", err.message));
  return { ok: true };
}

module.exports = {
  warmup,
  bootSeed,
  seedDefaultAdmin,
  register,
  login,
  loginWithGoogle,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  resetPassword,
  requireAuth,
  requireAdmin,
  verifyToken,
  reissueToken,
  updateProfile,
  changePassword,
  requestEmailChange,
  confirmEmailChange,
  setInitialPassword,
  findById,
  findByEmail,
  findByCpf,
  setCpf,
  setPhone,
  // Exportado pros testes forjarem o estado de uma conta anterior à regra
  // (escrita direta no banco precisa derrubar o cache do requireAuth).
  invalidateUser,
  createPaidUser,
  issueSession,
  publicUser,
  listUsers,
  deleteUser,
  adminSetPassword,
  setUserRole,
  adminVerifyEmail,
  adminSetSuspended,
  adminResendVerification,
  isAdminEmail,
  isRegistrationBlocked,
  // Limites/regras exportados pra ficar uma fonte só.
  MAX_NAME_LEN,
  MAX_EMAIL_LEN,
  MIN_PASSWORD_LEN,
  MAX_PASSWORD_LEN,
};

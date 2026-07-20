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

// Limites e regras de input padronizadas (compartilhadas com o frontend via copy).
const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 254;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;

const EMAIL_VERIFY_TTL_MS    = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS  = 60 * 60 * 1000;     // 1h
const RESEND_COOLDOWN_MS     = 2 * 60 * 1000;       // 2 min entre reenvios

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

// Conta admin garantida no boot: força email + senha + role=admin.
// Configurada via env DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD.
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || "").trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "";
const DEFAULT_ADMIN_NAME = process.env.DEFAULT_ADMIN_NAME || "Admin";

async function seedDefaultAdmin() {
  if (!DEFAULT_ADMIN_EMAIL || !DEFAULT_ADMIN_PASSWORD) return;
  if (DEFAULT_ADMIN_PASSWORD.length < 6) {
    console.warn("[auth] DEFAULT_ADMIN_PASSWORD < 6 chars — seed pulado");
    return;
  }

  const existing = await findByEmail(DEFAULT_ADMIN_EMAIL);

  if (existing) {
    const samePassword = await bcrypt.compare(DEFAULT_ADMIN_PASSWORD, existing.passwordHash);
    if (samePassword && existing.role === "admin") return;
    await prisma().user.update({
      where: { id: existing.id },
      data: {
        passwordHash: samePassword ? existing.passwordHash : await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10),
        role: "admin",
      },
    });
    invalidateUser(existing.id);
    console.log(`[auth] seed: admin ${DEFAULT_ADMIN_EMAIL} sincronizado`);
    return;
  }

  await prisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name: DEFAULT_ADMIN_NAME,
      email: DEFAULT_ADMIN_EMAIL,
      phone: "",
      passwordHash: await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10),
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
  const { passwordHash, ...rest } = u;
  if (!rest.role) rest.role = "user";
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

async function register({ name, email, password }) {
  email = normalizeEmail(email);
  name = String(name || "").trim();
  password = String(password || "");

  if (!name) throw new Error("Nome obrigatório");
  if (name.length > MAX_NAME_LEN) throw new Error(`Nome não pode ter mais que ${MAX_NAME_LEN} caracteres`);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email inválido");
  if (email.length > MAX_EMAIL_LEN) throw new Error(`Email não pode ter mais que ${MAX_EMAIL_LEN} caracteres`);
  validatePassword(password);

  assertRegistrationAllowed(email);

  const existing = await findByEmail(email);
  if (existing) throw new Error("Já existe uma conta com este email");

  const passwordHash = await bcrypt.hash(password, 10);
  const verifyToken = newToken();
  const user = await prisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name,
      email,
      phone: "",
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
  const token = jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), { expiresIn: TOKEN_TTL });
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
  const jwtToken = jwt.sign({ sub: updated.id, email: updated.email }, getJwtSecret(), { expiresIn: TOKEN_TTL });
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
      passwordHash: await bcrypt.hash(String(newPassword), 10),
      passwordResetToken: null,
      passwordResetExpires: null,
      // Reset implica que a pessoa controla o email — verifica também.
      emailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpires: null,
    },
  });
  invalidateUser(user.id);
  await syncRole(updated);
  cacheUser(updated);
  const jwtToken = jwt.sign({ sub: updated.id, email: updated.email }, getJwtSecret(), { expiresIn: TOKEN_TTL });
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
        passwordHash: await bcrypt.hash(randomPass, 10),
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
  const token = jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), { expiresIn: TOKEN_TTL });
  return { token, user: publicUser(user), created: !user.createdAt || (Date.now() - new Date(user.createdAt).getTime() < 5000) };
}

function verifyToken(token) {
  try { return jwt.verify(token, getJwtSecret()); }
  catch { return null; }
}

// Emite um token novo com o TTL padrão. Usado pela rota /api/auth/refresh para
// deslizar a janela de sessão enquanto o usuário está ativo (mesma assinatura
// de token usada em login()).
function reissueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), { expiresIn: TOKEN_TTL });
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
  if (updates.phone !== undefined) data.phone = String(updates.phone).trim();
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
  await prisma().user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
  });
  invalidateUser(userId);
  return true;
}

// Versão async — server.js precisará adaptar pra await em algumas rotas admin.
// Mantemos a sincrona "findById" interna com cache pra requireAuth.

async function listUsers() {
  const users = await prisma().user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      subscription: { select: { planId: true, status: true } },
      _count: { select: { groups: true, numbers: true } },
    },
  });
  return users.map(u => ({
    ...publicUser(u),
    subscription: u.subscription || null,
    _count: u._count,
  }));
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
  await prisma().user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
  }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
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
    data: { suspended, suspendedAt: suspended ? new Date() : null },
  }).catch(err => {
    if (err.code === "P2025") throw new Error("Usuário não encontrado");
    throw err;
  });
  invalidateUser(userId);
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
  reissueToken,
  updateProfile,
  changePassword,
  findById,
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

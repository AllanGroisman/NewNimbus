// Implementação Postgres do módulo auth.
//   - Usuários numa tabela com unique constraint em email (race-free).
//   - syncRole roda como UPDATE direto se necessário.
//   - JWT secret persistido em AppConfig (key "jwt_secret"); env JWT_SECRET tem prioridade.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../db");

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || "").trim().toLowerCase());
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
    },
  }).catch(err => {
    if (err.code === "P2002") return; // race com outro processo (worker)
    throw err;
  });
  console.log(`[auth] seed: admin ${DEFAULT_ADMIN_EMAIL} criado`);
}

let _jwtSecret = process.env.JWT_SECRET || null;
const TOKEN_TTL = "30d";

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

async function register({ name, email, password, phone }) {
  email = String(email || "").trim().toLowerCase();
  name = String(name || "").trim();
  password = String(password || "");

  if (!name) throw new Error("Nome obrigatório");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email inválido");
  if (password.length < 6) throw new Error("Senha precisa ter ao menos 6 caracteres");

  const existing = await findByEmail(email);
  if (existing) throw new Error("Já existe uma conta com este email");

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name,
      email,
      phone: phone ? String(phone).trim() : "",
      passwordHash,
      role: isAdminEmail(email) ? "admin" : "user",
    },
  });
  return publicUser(user);
}

async function login({ email, password }) {
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  const user = await findByEmail(email);
  if (!user) throw new Error("Email ou senha incorretos");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error("Email ou senha incorretos");
  await syncRole(user);
  cacheUser(user);
  const token = jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), { expiresIn: TOKEN_TTL });
  return { token, user: publicUser(user) };
}

function verifyToken(token) {
  try { return jwt.verify(token, getJwtSecret()); }
  catch { return null; }
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
  if (String(newPassword || "").length < 6) throw new Error("Nova senha precisa ter ao menos 6 caracteres");
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
  const users = await prisma().user.findMany({ orderBy: { createdAt: "asc" } });
  return users.map(publicUser);
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
  if (String(newPassword || "").length < 6) throw new Error("Senha precisa ter ao menos 6 caracteres");
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

module.exports = {
  warmup,
  bootSeed,
  seedDefaultAdmin,
  register,
  login,
  requireAuth,
  requireAdmin,
  updateProfile,
  changePassword,
  findById,
  publicUser,
  listUsers,
  deleteUser,
  adminSetPassword,
  setUserRole,
  isAdminEmail,
};

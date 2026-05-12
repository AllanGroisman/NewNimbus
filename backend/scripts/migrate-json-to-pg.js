// Migra todos os dados JSON em backend/data/ para o Postgres via Prisma.
// Idempotente: pode ser rodado várias vezes (upsert nas tabelas chave).
//
// Pré-requisitos:
//   1) Postgres rodando (docker compose up -d).
//   2) DATABASE_URL definida em backend/.env.
//   3) `npx prisma migrate deploy` (ou `npx prisma migrate dev`) já rodado.
//
// Uso:
//   cd backend && node scripts/migrate-json-to-pg.js [--dry-run]

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const DRY_RUN = process.argv.includes("--dry-run");
const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_DIR = path.join(DATA_DIR, "state");

const prisma = new PrismaClient();

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (err) {
    console.warn(`[migrate] arquivo corrompido (${file}): ${err.message}`);
    return null;
  }
}

async function migrateUsers() {
  const users = readJSON(path.join(DATA_DIR, "users.json")) || [];
  console.log(`[migrate] users: ${users.length} a importar`);
  if (DRY_RUN) return;

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        email: String(u.email || "").trim().toLowerCase(),
        name: u.name || "",
        phone: u.phone || null,
        passwordHash: u.passwordHash || "",
        role: u.role || "user",
        createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
      },
      update: {
        email: String(u.email || "").trim().toLowerCase(),
        name: u.name || "",
        phone: u.phone || null,
        passwordHash: u.passwordHash || "",
        role: u.role || "user",
      },
    });
  }
  console.log(`[migrate] users: ok`);
}

async function migrateAppConfig() {
  const affiliate = readJSON(path.join(DATA_DIR, "affiliate.json"));
  const scraperConfig = readJSON(path.join(DATA_DIR, "scraper-config.json"));

  console.log(`[migrate] app-config: affiliate=${affiliate ? "sim" : "vazio"}, scraper-config=${scraperConfig ? "sim" : "vazio"}`);
  if (DRY_RUN) return;

  if (affiliate) {
    await prisma.appConfig.upsert({
      where: { key: "affiliate" },
      create: { key: "affiliate", value: affiliate },
      update: { value: affiliate },
    });
  }
  if (scraperConfig) {
    await prisma.appConfig.upsert({
      where: { key: "scraper-config" },
      create: { key: "scraper-config", value: scraperConfig },
      update: { value: scraperConfig },
    });
  }
  console.log(`[migrate] app-config: ok`);
}

async function migrateCatalog() {
  const data = readJSON(path.join(DATA_DIR, "catalog.json"));
  if (!data || !data.products) {
    console.log(`[migrate] catalog: vazio`);
    return;
  }
  const entries = Object.values(data.products);
  console.log(`[migrate] catalog: ${entries.length} produtos`);
  if (DRY_RUN) return;

  const INDEXED = new Set(["key", "name", "link", "img", "price", "originalPrice", "discount", "store", "category", "rating", "sold", "firstSeenAt", "lastSeenAt"]);

  let i = 0;
  const BATCH = 50;
  while (i < entries.length) {
    const slice = entries.slice(i, i + BATCH);
    await Promise.all(slice.map(p => {
      const cat = typeof p.category === "string" ? p.category : (p.category?.id || null);
      const payload = {};
      for (const [k, v] of Object.entries(p)) {
        if (!INDEXED.has(k) && v !== undefined) payload[k] = v;
      }
      const data = {
        key: p.key,
        name: p.name || "",
        link: p.link || "",
        img: p.img || null,
        price: p.price ?? null,
        originalPrice: p.originalPrice ?? null,
        discount: p.discount ?? null,
        store: p.store || null,
        category: cat,
        rating: p.rating ?? null,
        sold: p.sold || null,
        payload,
        firstSeenAt: p.firstSeenAt ? new Date(p.firstSeenAt) : new Date(),
        lastSeenAt: p.lastSeenAt ? new Date(p.lastSeenAt) : new Date(),
      };
      return prisma.catalogProduct.upsert({
        where: { key: p.key },
        create: data,
        update: data,
      });
    }));
    i += BATCH;
    process.stdout.write(`\r[migrate] catalog: ${Math.min(i, entries.length)}/${entries.length}`);
  }
  process.stdout.write(`\n`);
  console.log(`[migrate] catalog: ok`);
}

async function migrateUserStates() {
  if (!fs.existsSync(STATE_DIR)) {
    console.log(`[migrate] states: diretório não existe`);
    return;
  }
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"));
  console.log(`[migrate] states: ${files.length} usuários`);

  for (const f of files) {
    const userId = f.replace(/\.json$/, "");
    const state = readJSON(path.join(STATE_DIR, f));
    if (!state) continue;

    // Confirma que o user existe — senão ignora (state órfão).
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      console.warn(`[migrate] state ${userId}: usuário não existe em users.json — pulando`);
      continue;
    }

    if (DRY_RUN) {
      const groupCount = (state.groups || []).length;
      const histTotal = (state.groups || []).reduce((a, g) => a + (g.history || []).length, 0);
      console.log(`[migrate] state ${userId}: ${groupCount} grupos, ${histTotal} histórico (dry-run)`);
      continue;
    }

    // user_state (settings)
    await prisma.userState.upsert({
      where: { userId },
      create: { userId, settings: state.settings || {}, updatedAt: state.updatedAt ? new Date(state.updatedAt) : new Date() },
      update: { settings: state.settings || {} },
    });

    // groups + sub-tabelas
    for (const g of (state.groups || [])) {
      const id = BigInt(g.id);
      const cfg = {
        userId,
        name: String(g.name || ""),
        messageTemplate: String(g.messageTemplate || ""),
        paused: !!g.paused,
        categories: g.categories ?? [],
        whatsappGroupIds: g.whatsappGroupIds ?? [],
        schedule: g.schedule ?? {},
        scraping: g.scraping ?? {},
        sentToday: g.sentToday || 0,
        sentWeek: g.sentWeek || 0,
        weekData: Array.isArray(g.weekData) && g.weekData.length === 7 ? g.weekData : [0, 0, 0, 0, 0, 0, 0],
        lastSend: g.lastSend || "—",
        avgDiscount: g.avgDiscount || "—",
      };
      await prisma.group.upsert({
        where: { id },
        create: { id, ...cfg },
        update: cfg,
      });

      // queue: limpa e regrava (idempotente)
      await prisma.groupQueueItem.deleteMany({ where: { groupId: id } });
      const queue = Array.isArray(g.queue) ? g.queue : [];
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const key = item.key || item.id;
        if (!key) continue;
        await prisma.groupQueueItem.create({
          data: { groupId: id, productKey: String(key), position: i, payload: item },
        });
      }

      // pending
      await prisma.groupPendingItem.deleteMany({ where: { groupId: id } });
      const pending = Array.isArray(g.pending) ? g.pending : [];
      for (const item of pending) {
        const key = item.key || item.id;
        if (!key) continue;
        await prisma.groupPendingItem.create({
          data: { groupId: id, productKey: String(key), payload: item },
        });
      }

      // history (últimos 200)
      await prisma.groupHistory.deleteMany({ where: { groupId: id } });
      const history = Array.isArray(g.history) ? g.history.slice(0, 200) : [];
      for (const h of history) {
        await prisma.groupHistory.create({
          data: {
            groupId: id,
            productKey: String(h.key || ""),
            name: String(h.name || ""),
            link: String(h.link || ""),
            img: h.img || null,
            store: h.store || null,
            price: h.price ?? null,
            originalPrice: h.originalPrice ?? null,
            discount: h.discount ?? null,
            sentAt: h.sentAt ? new Date(h.sentAt) : new Date(),
            groupCount: h.groupCount || 1,
          },
        });
      }
    }

    // whatsapp_groups
    await prisma.whatsappGroup.deleteMany({ where: { userId } });
    for (const w of (state.whatsappGroups || [])) {
      if (!w.id) continue;
      const { id, numberId, jid, name, ...rest } = w;
      await prisma.whatsappGroup.create({
        data: {
          id: String(id),
          userId,
          numberId: String(numberId || ""),
          jid: String(jid || id),
          name: String(name || ""),
          metadata: rest,
        },
      });
    }

    // numbers
    await prisma.whatsappNumber.deleteMany({ where: { userId } });
    for (const n of (state.numbers || [])) {
      if (!n.id) continue;
      const { id, label, phone, ...rest } = n;
      await prisma.whatsappNumber.create({
        data: {
          id: String(id),
          userId,
          label: label || null,
          phone: phone || null,
          metadata: rest,
        },
      });
    }

    console.log(`[migrate] state ${userId}: ok (${(state.groups || []).length} grupos)`);
  }
}

(async () => {
  console.log(`[migrate] iniciando ${DRY_RUN ? "(dry-run)" : ""}`);
  console.log(`[migrate] DATABASE_URL=${process.env.DATABASE_URL?.replace(/:[^@]+@/, ":***@") || "(não definido)"}`);

  try {
    await migrateUsers();
    await migrateAppConfig();
    await migrateCatalog();
    await migrateUserStates();
    console.log(`[migrate] FIM ${DRY_RUN ? "(nenhuma mudança escrita — dry-run)" : ""}`);
  } catch (err) {
    console.error(`[migrate] FALHOU:`, err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();

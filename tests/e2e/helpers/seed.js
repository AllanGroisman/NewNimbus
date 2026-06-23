// Seed de dados pro E2E: catálogo (pros fluxos de scraper/catálogo) e leitura
// READ-ONLY das credenciais reais de afiliado do DB de dev (autorizado pelo dono
// da conta). Nunca escreve no DB de dev.

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { backend, prismaFor } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const require = createRequire(import.meta.url);
const { mlProduct, amazonProduct, shopeeProduct } =
  require(path.join(repoRoot, "tests", "helpers", "fixtures.js"));

// Popula o catálogo do banco de E2E com N produtos de cada loja.
export async function seedCatalog(n = 6) {
  const { catalog } = backend();
  const products = [];
  for (let i = 1; i <= n; i++) {
    products.push(mlProduct(i), amazonProduct(i), shopeeProduct(i));
  }
  await catalog.upsertProducts(products);
  return products;
}

export async function clearCatalog() {
  const { catalog } = backend();
  await catalog.clearAll();
}

// Lê (read-only) as credenciais de afiliado salvas na conta real (DB de dev).
// Retorna { ml?, amazon?, shopee? } ou null se indisponível → spec dá soft-skip.
export async function getRealAffiliateCreds() {
  const devUrl = process.env.E2E_DEV_DATABASE_URL;
  const email = process.env.E2E_ADMIN_EMAIL;
  if (!devUrl || !email) return null;
  const db = prismaFor(devUrl);
  try {
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return null;
    const row = await db.affiliateConfig.findUnique({
      where: { userId: user.id },
      select: { data: true },
    });
    return row?.data || null;
  } catch {
    return null;
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

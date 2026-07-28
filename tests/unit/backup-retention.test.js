// Testes da retenção GFS dos backups remotos (função pura, sem servidor):
// tudo das últimas 48h fica; depois 1 por dia até 30 dias; resto cai.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { computeRemoteKeep, parseStamp } = require(
  path.resolve(__dirname, "..", "..", "backend", "scripts", "backup-retention.js")
);

// "now" fixo: 15/07/2026 12:00:00 local
const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime();

// Nome de dump N horas antes de NOW.
function nameAt(hoursAgo) {
  const d = new Date(NOW - hoursAgo * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `db-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.sql.gz`;
}

describe("backup-retention — parseStamp", () => {
  it("parseia o timestamp do nome canônico", () => {
    const t = parseStamp("db-20260715-103000.sql.gz");
    expect(t).toBe(new Date(2026, 6, 15, 10, 30, 0).getTime());
  });

  it("nome fora do padrão → null", () => {
    expect(parseStamp("outro-arquivo.sql.gz")).toBeNull();
    expect(parseStamp("db-2026-completo.sql.gz")).toBeNull();
  });
});

describe("backup-retention — computeRemoteKeep", () => {
  it("mantém todos os snapshots dentro da janela de 48h", () => {
    const names = [nameAt(1), nameAt(12), nameAt(47)];
    const { keep, drop } = computeRemoteKeep(names, NOW);
    expect(keep).toEqual(expect.arrayContaining(names));
    expect(drop).toEqual([]);
  });

  it("fora da janela sobrevive só o mais recente de cada dia", () => {
    // 3 dumps do mesmo dia, ~3 dias atrás (72h/78h/84h)
    const newest = nameAt(72);
    const mid = nameAt(78);
    const oldest = nameAt(84);
    const { keep, drop } = computeRemoteKeep([newest, mid, oldest], NOW);
    expect(keep).toContain(newest);
    expect(drop).toEqual(expect.arrayContaining([mid, oldest]));
  });

  it("descarta o que passou de 30 dias", () => {
    const ok = nameAt(29 * 24);
    const velho = nameAt(31 * 24);
    const { keep, drop } = computeRemoteKeep([ok, velho], NOW);
    expect(keep).toContain(ok);
    expect(drop).toContain(velho);
  });

  it("lista vazia → nada a manter nem apagar", () => {
    expect(computeRemoteKeep([], NOW)).toEqual({ keep: [], drop: [] });
  });

  it("nomes fora do padrão nunca são deletados", () => {
    const { keep, drop } = computeRemoteKeep(["manual-backup.sql.gz", nameAt(40 * 24)], NOW);
    expect(keep).toContain("manual-backup.sql.gz");
    expect(drop).not.toContain("manual-backup.sql.gz");
  });

  it("respeita janelas customizadas (hourlyWindowH / retainDays)", () => {
    const dentroJanela = nameAt(5);
    const foraJanela = nameAt(10);      // > 6h, dia atual → vira candidato diário
    const expirado = nameAt(8 * 24);    // > 7 dias
    const { keep, drop } = computeRemoteKeep(
      [dentroJanela, foraJanela, expirado],
      NOW,
      { hourlyWindowH: 6, retainDays: 7 }
    );
    expect(keep).toContain(dentroJanela);
    expect(keep).toContain(foraJanela); // único do dia — sobrevive como diário
    expect(drop).toContain(expirado);
  });
});

-- Tutoriais editáveis pelo admin (task 102).
--
-- Até aqui as 4 seções e os 13 tutoriais viviam hardcoded em
-- frontend/src/pages/Tutoriais.jsx: publicar um vídeo ou corrigir um título
-- exigia deploy. Estas duas tabelas passam a ser a fonte da página, e a tela
-- Admin › Editar Tutoriais escreve nelas.
--
-- O INSERT no fim semeia exatamente o conteúdo que estava no JSX — mesmos
-- títulos, durações, ícones e ORDEM. Os slugs são críticos: as páginas de
-- afiliado fazem deep-link por eles (TUTORIAL_IDS no front), então mudar
-- 'afiliado-ml' & cia. quebra os botões "ver tutorial" daquelas telas.
--
-- Tudo IF NOT EXISTS / ON CONFLICT DO NOTHING pra ser idempotente: rodar de
-- novo num banco que já tem os tutoriais (e já com edições do admin) não pode
-- sobrescrever nada.

CREATE TABLE IF NOT EXISTS "tutorial_sections" (
  "id"          TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "icon"        TEXT NOT NULL DEFAULT '▶',
  "sort"        INTEGER NOT NULL DEFAULT 0,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tutorial_sections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tutorial_sections_slug_key" ON "tutorial_sections"("slug");
CREATE INDEX IF NOT EXISTS "tutorial_sections_sort_idx" ON "tutorial_sections"("sort");

CREATE TABLE IF NOT EXISTS "tutorials" (
  "id"         TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "slug"       TEXT NOT NULL,
  "title"      TEXT NOT NULL,
  "duration"   TEXT NOT NULL DEFAULT '',
  "content"    TEXT NOT NULL DEFAULT '',
  "video_url"  TEXT NOT NULL DEFAULT '',
  "sort"       INTEGER NOT NULL DEFAULT 0,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tutorials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tutorials_slug_key" ON "tutorials"("slug");
CREATE INDEX IF NOT EXISTS "tutorials_section_id_sort_idx" ON "tutorials"("section_id", "sort");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tutorials_section_id_fkey') THEN
    ALTER TABLE "tutorials"
      ADD CONSTRAINT "tutorials_section_id_fkey"
      FOREIGN KEY ("section_id") REFERENCES "tutorial_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Seed: o conteúdo que estava no JSX. `content` e `video_url` nascem vazios —
-- os tutoriais continuam marcados "Em breve" na tela até o admin preencher.
INSERT INTO "tutorial_sections" ("id", "slug", "title", "description", "icon", "sort") VALUES
  (gen_random_uuid()::text, 'comecando', 'Começando', 'Configure sua conta e crie sua primeira campanha', '▶', 0),
  (gen_random_uuid()::text, 'afiliados', 'Configurar afiliados (gerar comissão)', 'Sem afiliado configurado, a campanha fica pausada — links não geram comissão.', '◆', 1),
  (gen_random_uuid()::text, 'campanhas', 'Gerenciar campanhas', 'Filtros, fila, agendamento e templates de mensagem', '◎', 2),
  (gen_random_uuid()::text, 'conta', 'Conta e cobrança', 'Plano, pagamento e recuperação de senha', '★', 3)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "tutorials" ("id", "section_id", "slug", "title", "duration", "sort")
SELECT gen_random_uuid()::text, s."id", v."slug", v."title", v."duration", v."sort"
FROM (VALUES
  ('comecando', 'criar-conta',            'Criar conta e verificar email',                '2 min', 0),
  ('comecando', 'conectar-whatsapp',      'Conectar um número de WhatsApp',               '3 min', 1),
  ('comecando', 'primeira-campanha',      'Criar sua primeira campanha',                  '5 min', 2),
  ('afiliados', 'afiliado-ml',            'Configurar afiliado do Mercado Livre',         '4 min', 0),
  ('afiliados', 'afiliado-amazon',        'Configurar afiliado da Amazon',                '3 min', 1),
  ('afiliados', 'afiliado-shopee',        'Configurar afiliado da Shopee',                '5 min', 2),
  ('campanhas', 'buscar-catalogo',        'Buscar produtos do catálogo',                  '3 min', 0),
  ('campanhas', 'adicionar-link-manual',  'Adicionar link manualmente (URL)',             '2 min', 1),
  ('campanhas', 'filtros-catalogo',       'Filtros avançados do catálogo',                '4 min', 2),
  ('campanhas', 'templates-mensagem',     'Personalizar templates de mensagem',           '3 min', 3),
  ('campanhas', 'agendamento',            'Configurar janelas de envio',                  '3 min', 4),
  ('conta',     'trocar-plano',           'Mudar de plano ou cancelar',                   '2 min', 0),
  ('conta',     'reset-senha',            'Recuperar/trocar senha',                       '1 min', 1)
) AS v("sectionSlug", "slug", "title", "duration", "sort")
JOIN "tutorial_sections" s ON s."slug" = v."sectionSlug"
ON CONFLICT ("slug") DO NOTHING;

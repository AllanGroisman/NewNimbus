-- Task 12: fazer os produtos do sistema carregarem os cupons que valem neles.
--
-- Medido em 19/09/2026: 4.035 produtos no catálogo, UM com cupom carimbado. Os
-- vínculos que existiam eram todos 'amostra', e quase nenhum casava com o
-- catálogo — os produtos dos cupons simplesmente não estavam lá. A leitura da
-- vitrine pela landing de afiliado (sem navegador, ~2 s) funcionava, mas só no
-- botão de UM cupom. Estas colunas sustentam as duas varreduras em lote
-- (coupons/landing-sweep.js e coupons/enrich-samples.js).

-- Quando a varredura pela landing tentou este cupom, e se deu. Sem o carimbo, o
-- cupom cuja landing não traz produto (campanha acabando, link que cai no perfil
-- do afiliado) voltaria para a fila em TODA rodada, empurrando os outros pra trás.
ALTER TABLE "ml_coupons" ADD COLUMN IF NOT EXISTS "landingTriedAt" TIMESTAMP(3);
ALTER TABLE "ml_coupons" ADD COLUMN IF NOT EXISTS "landingOk" BOOLEAN;
ALTER TABLE "ml_coupons" ADD COLUMN IF NOT EXISTS "landingMessage" TEXT;

-- Quando se tentou transformar esta AMOSTRA (só o MLB, sem nome nem preço) em
-- produto de catálogo. Mesmo motivo: anúncio pausado não pode ser buscado de novo
-- a cada rodada.
ALTER TABLE "ml_coupon_products" ADD COLUMN IF NOT EXISTS "enrichTriedAt" TIMESTAMP(3);

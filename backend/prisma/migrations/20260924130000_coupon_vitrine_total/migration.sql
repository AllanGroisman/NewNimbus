-- Quantos produtos a vitrine de cada cupom diz ter (o total da busca do ML), lido
-- pela extensão na etapa 2. É o "200" do "45/200" da tabela de cupons.
ALTER TABLE "ml_coupons" ADD COLUMN "vitrineTotal" INTEGER;
ALTER TABLE "ml_coupons" ADD COLUMN "vitrineTotalAt" TIMESTAMP(3);

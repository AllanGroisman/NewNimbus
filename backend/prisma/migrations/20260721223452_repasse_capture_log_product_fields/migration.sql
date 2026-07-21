-- AlterTable
ALTER TABLE "repasse_capture_log" ADD COLUMN     "discount" INTEGER,
ADD COLUMN     "originalPrice" DOUBLE PRECISION,
ADD COLUMN     "price" DOUBLE PRECISION,
ADD COLUMN     "productImg" TEXT,
ADD COLUMN     "sold" INTEGER;

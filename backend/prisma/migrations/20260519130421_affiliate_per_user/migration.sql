-- CreateTable
CREATE TABLE "affiliate_config" (
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_config_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "affiliate_config" ADD CONSTRAINT "affiliate_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

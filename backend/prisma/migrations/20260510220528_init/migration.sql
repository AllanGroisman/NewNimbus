-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_state" (
    "userId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_state_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" BIGINT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "messageTemplate" TEXT NOT NULL DEFAULT '',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "categories" JSONB NOT NULL DEFAULT '[]',
    "whatsappGroupIds" JSONB NOT NULL DEFAULT '[]',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "scraping" JSONB NOT NULL DEFAULT '{}',
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentWeek" INTEGER NOT NULL DEFAULT 0,
    "weekData" JSONB NOT NULL DEFAULT '[0,0,0,0,0,0,0]',
    "lastSend" TEXT NOT NULL DEFAULT '—',
    "avgDiscount" TEXT NOT NULL DEFAULT '—',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_history" (
    "id" BIGSERIAL NOT NULL,
    "groupId" BIGINT NOT NULL,
    "productKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "img" TEXT,
    "store" TEXT,
    "price" DOUBLE PRECISION,
    "originalPrice" DOUBLE PRECISION,
    "discount" INTEGER,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "groupCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "group_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_queue" (
    "id" BIGSERIAL NOT NULL,
    "groupId" BIGINT NOT NULL,
    "productKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_pending" (
    "id" BIGSERIAL NOT NULL,
    "groupId" BIGINT NOT NULL,
    "productKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_pending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_groups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "numberId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "whatsapp_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "phone" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_products" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "img" TEXT,
    "price" DOUBLE PRECISION,
    "originalPrice" DOUBLE PRECISION,
    "discount" INTEGER,
    "store" TEXT,
    "category" TEXT,
    "rating" DOUBLE PRECISION,
    "sold" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "groups_userId_idx" ON "groups"("userId");

-- CreateIndex
CREATE INDEX "groups_paused_idx" ON "groups"("paused");

-- CreateIndex
CREATE INDEX "group_history_groupId_sentAt_idx" ON "group_history"("groupId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "group_history_groupId_productKey_idx" ON "group_history"("groupId", "productKey");

-- CreateIndex
CREATE INDEX "group_queue_groupId_position_idx" ON "group_queue"("groupId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "group_queue_groupId_productKey_key" ON "group_queue"("groupId", "productKey");

-- CreateIndex
CREATE INDEX "group_pending_groupId_idx" ON "group_pending"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "group_pending_groupId_productKey_key" ON "group_pending"("groupId", "productKey");

-- CreateIndex
CREATE INDEX "whatsapp_groups_userId_idx" ON "whatsapp_groups"("userId");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_userId_idx" ON "whatsapp_numbers"("userId");

-- CreateIndex
CREATE INDEX "catalog_products_category_discount_idx" ON "catalog_products"("category", "discount" DESC);

-- CreateIndex
CREATE INDEX "catalog_products_store_idx" ON "catalog_products"("store");

-- CreateIndex
CREATE INDEX "catalog_products_lastSeenAt_idx" ON "catalog_products"("lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "catalog_products_discount_idx" ON "catalog_products"("discount" DESC);

-- AddForeignKey
ALTER TABLE "user_state" ADD CONSTRAINT "user_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_history" ADD CONSTRAINT "group_history_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_queue" ADD CONSTRAINT "group_queue_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_pending" ADD CONSTRAINT "group_pending_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

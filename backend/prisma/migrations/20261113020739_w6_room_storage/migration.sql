-- CreateTable
CREATE TABLE "Room" (
    "roomId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "RoomQuotaDaily" (
    "id" SERIAL NOT NULL,
    "quotaKey" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "committed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomQuotaDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Room_status_idx" ON "Room"("status");

-- CreateIndex
CREATE INDEX "Room_updatedAt_idx" ON "Room"("updatedAt");

-- CreateIndex
CREATE INDEX "RoomQuotaDaily_quotaKey_periodKey_idx" ON "RoomQuotaDaily"("quotaKey", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "RoomQuotaDaily_quotaKey_periodKey_key" ON "RoomQuotaDaily"("quotaKey", "periodKey");

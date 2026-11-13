-- CreateTable
CREATE TABLE "RoomQuota" (
    "key" TEXT NOT NULL,
    "held" INTEGER NOT NULL DEFAULT 0,
    "committed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomQuota_pkey" PRIMARY KEY ("key")
);

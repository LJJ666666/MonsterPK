-- AlterTable
ALTER TABLE "Save" ADD COLUMN "authority" TEXT;

-- CreateTable
CREATE TABLE "IntentLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "nonce" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "IntentLog_userId_slot_createdAt_idx" ON "IntentLog"("userId", "slot", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntentLog_userId_slot_nonce_key" ON "IntentLog"("userId", "slot", "nonce");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Save" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'unknown',
    "clientId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Save_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Save" ("data", "id", "slot", "updatedAt", "userId") SELECT "data", "id", "slot", "updatedAt", "userId" FROM "Save";
DROP TABLE "Save";
ALTER TABLE "new_Save" RENAME TO "Save";
CREATE UNIQUE INDEX "Save_userId_slot_key" ON "Save"("userId", "slot");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

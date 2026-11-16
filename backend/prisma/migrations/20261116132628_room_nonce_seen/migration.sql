-- CreateTable
CREATE TABLE "RoomNonceSeen" (
    "id" SERIAL NOT NULL,
    "roomId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomNonceSeen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomNonceSeen_roomId_idx" ON "RoomNonceSeen"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomNonceSeen_roomId_seat_nonce_key" ON "RoomNonceSeen"("roomId", "seat", "nonce");

-- AddForeignKey
ALTER TABLE "RoomNonceSeen" ADD CONSTRAINT "RoomNonceSeen_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("roomId") ON DELETE CASCADE ON UPDATE CASCADE;

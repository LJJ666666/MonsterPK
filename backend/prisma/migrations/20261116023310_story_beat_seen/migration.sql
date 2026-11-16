-- CreateTable
CREATE TABLE "StoryBeatSeen" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "beatId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryBeatSeen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoryBeatSeen_userId_seenAt_idx" ON "StoryBeatSeen"("userId", "seenAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoryBeatSeen_userId_beatId_key" ON "StoryBeatSeen"("userId", "beatId");

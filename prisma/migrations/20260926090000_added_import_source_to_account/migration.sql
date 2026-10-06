-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "importSourceId" TEXT;

-- CreateIndex
CREATE INDEX "Account_importSourceId_idx" ON "Account"("importSourceId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "ImportSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

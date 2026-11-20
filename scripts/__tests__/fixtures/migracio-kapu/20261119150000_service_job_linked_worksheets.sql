-- Kártya 5b366f5d: egy már létező munkalap hivatkozása a karbantartási lapon (nem áthelyezés). Egy munkalap egy laphoz (UNIQUE worksheetId).
-- A két új eseményfajta külön utasítás; az új érték ugyanebben a tranzakcióban nem használt.
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ServiceJobEventKind" ADD VALUE 'WORKSHEET_LINKED';
ALTER TYPE "ServiceJobEventKind" ADD VALUE 'WORKSHEET_UNLINKED';

-- CreateTable
CREATE TABLE "ServiceJobLinkedWorksheet" (
    "id" TEXT NOT NULL,
    "serviceJobId" TEXT NOT NULL,
    "worksheetId" TEXT NOT NULL,
    "linkedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceJobLinkedWorksheet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceJobLinkedWorksheet_worksheetId_key" ON "ServiceJobLinkedWorksheet"("worksheetId");

-- CreateIndex
CREATE INDEX "ServiceJobLinkedWorksheet_serviceJobId_createdAt_idx" ON "ServiceJobLinkedWorksheet"("serviceJobId", "createdAt");

-- AddForeignKey
ALTER TABLE "ServiceJobLinkedWorksheet" ADD CONSTRAINT "ServiceJobLinkedWorksheet_serviceJobId_fkey" FOREIGN KEY ("serviceJobId") REFERENCES "ServiceJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceJobLinkedWorksheet" ADD CONSTRAINT "ServiceJobLinkedWorksheet_worksheetId_fkey" FOREIGN KEY ("worksheetId") REFERENCES "Worksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;


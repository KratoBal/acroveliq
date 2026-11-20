-- CreateEnum
CREATE TYPE "StripePayoutStatus" AS ENUM ('COMPLETED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "StripeLineStatus" AS ENUM ('RESOLVED', 'NEEDS_REVIEW', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "StripeResolutionSource" AS ENUM ('PAYMENT_INTENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "StripeSyncRunStatus" AS ENUM ('RUNNING', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "StripePayout" (
    "id" TEXT NOT NULL,
    "stripePayoutId" TEXT NOT NULL,
    "status" "StripePayoutStatus" NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "arrivalDate" DATE NOT NULL,
    "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
    "automatic" BOOLEAN NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "unresolvedLineCount" INTEGER NOT NULL,
    "grossTotal" DECIMAL(19,4) NOT NULL,
    "refundTotal" DECIMAL(19,4) NOT NULL,
    "feeTotal" DECIMAL(19,4) NOT NULL,
    "netTotal" DECIMAL(19,4) NOT NULL,
    "ordersTruncated" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripePayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeTransactionLine" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "stripeTransactionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reportingCategory" TEXT,
    "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "fee" DECIMAL(19,4) NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "paymentIntentId" TEXT,
    "chargeId" TEXT,
    "refundId" TEXT,
    "webshopOrderIds" TEXT[],
    "orderNumbers" TEXT[],
    "orderTotal" DECIMAL(19,4),
    "invoiceNumbers" TEXT[],
    "status" "StripeLineStatus" NOT NULL,
    "resolutionSource" "StripeResolutionSource",
    "errorCode" TEXT,
    "manualApprovedByUserId" TEXT,
    "manualApprovedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeTransactionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeSyncRun" (
    "id" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" "StripeSyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" "SyncRunTrigger" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "payoutsSeen" INTEGER NOT NULL DEFAULT 0,
    "payoutsNew" INTEGER NOT NULL DEFAULT 0,
    "payoutsReresolved" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripePayout_stripePayoutId_key" ON "StripePayout"("stripePayoutId");

-- CreateIndex
CREATE INDEX "StripePayout_arrivalDate_idx" ON "StripePayout"("arrivalDate");

-- CreateIndex
CREATE INDEX "StripePayout_status_idx" ON "StripePayout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StripeTransactionLine_stripeTransactionId_key" ON "StripeTransactionLine"("stripeTransactionId");

-- CreateIndex
CREATE INDEX "StripeTransactionLine_payoutId_idx" ON "StripeTransactionLine"("payoutId");

-- CreateIndex
CREATE INDEX "StripeTransactionLine_paymentIntentId_idx" ON "StripeTransactionLine"("paymentIntentId");

-- CreateIndex
CREATE INDEX "StripeTransactionLine_status_idx" ON "StripeTransactionLine"("status");

-- CreateIndex
CREATE INDEX "StripeTransactionLine_stripeCreatedAt_idx" ON "StripeTransactionLine"("stripeCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StripeSyncRun_activeKey_key" ON "StripeSyncRun"("activeKey");

-- CreateIndex
CREATE INDEX "StripeSyncRun_startedAt_idx" ON "StripeSyncRun"("startedAt");

-- AddForeignKey
ALTER TABLE "StripeTransactionLine" ADD CONSTRAINT "StripeTransactionLine_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "StripePayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeTransactionLine" ADD CONSTRAINT "StripeTransactionLine_manualApprovedByUserId_fkey" FOREIGN KEY ("manualApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


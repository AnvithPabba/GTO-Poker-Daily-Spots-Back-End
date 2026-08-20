-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "actor" TEXT,
    "operation" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAudit_targetId_createdAt_idx" ON "AdminAudit"("targetId", "createdAt");
CREATE INDEX "AdminAudit_operation_createdAt_idx" ON "AdminAudit"("operation", "createdAt");

-- CreateTable
CREATE TABLE "SecurityAlertWatch" (
    "sessionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "openAlerts" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL,

    PRIMARY KEY ("sessionId", "repoFullName"),
    CONSTRAINT "SecurityAlertWatch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);


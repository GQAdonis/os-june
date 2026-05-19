-- AlterTable
ALTER TABLE "CalendarConnection" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "CalendarConnection" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "CalendarConnection" ADD COLUMN "refreshToken" TEXT;

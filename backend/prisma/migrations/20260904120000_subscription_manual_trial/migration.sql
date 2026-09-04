-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "manualTrialPlanId" TEXT,
ADD COLUMN     "manualTrialStartedAt" TIMESTAMP(3),
ADD COLUMN     "manualTrialEndsAt" TIMESTAMP(3),
ADD COLUMN     "manualTrialEndedAt" TIMESTAMP(3),
ADD COLUMN     "manualTrialGrantedBy" TEXT,
ADD COLUMN     "manualTrialNote" TEXT;

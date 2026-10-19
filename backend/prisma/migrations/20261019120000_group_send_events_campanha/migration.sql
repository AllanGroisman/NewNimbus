-- Visão geral da campanha (task 14): envios por campanha e período.
CREATE INDEX "group_send_events_userId_campaignId_at_idx" ON "group_send_events"("userId", "campaignId", "at");

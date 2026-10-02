-- PLAN: snapshot de lectura, no ejecutar SQL a ciegas. Usa preparar-db-crm.js tras backup.
CREATE TABLE public."pending_cloud_receipts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "wa_message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_at" TIMESTAMP(3) NOT NULL,
    "error_code" INTEGER,
    "error_detalle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_cloud_receipts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE public."messages" ADD COLUMN "cloud_phone_number_id" TEXT;
ALTER TABLE public."messages" ALTER COLUMN "createdAt" SET NOT NULL;
CREATE INDEX "vendors_tenant_id_idx" ON public."vendors"("tenant_id");
CREATE INDEX "campaigns_tenant_id_idx" ON public."campaigns"("tenant_id");
CREATE INDEX "leads_tenant_id_idx" ON public."leads"("tenant_id");
CREATE UNIQUE INDEX "conversations_leadId_campaignId_key" ON public."conversations"("leadId", "campaignId");
CREATE INDEX "pending_cloud_receipts_tenant_id_phone_number_id_idx" ON public."pending_cloud_receipts"("tenant_id", "phone_number_id");
CREATE UNIQUE INDEX "pending_cloud_receipts_phone_number_id_wa_message_id_key" ON public."pending_cloud_receipts"("phone_number_id", "wa_message_id");
ALTER TABLE public."campaigns" ADD CONSTRAINT "campaigns_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES public."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."triggers" ADD CONSTRAINT "triggers_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."flow_steps" ADD CONSTRAINT "flow_steps_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."leads" ADD CONSTRAINT "leads_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."leads" ADD CONSTRAINT "leads_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."messages" ADD CONSTRAINT "messages_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES public."leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."pending_cloud_receipts" ADD CONSTRAINT "pending_cloud_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES public."tenant_settings"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."media_assets" ADD CONSTRAINT "media_assets_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."lead_state" ADD CONSTRAINT "lead_state_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."lead_state" ADD CONSTRAINT "lead_state_vendor_active_id_fkey" FOREIGN KEY ("vendor_active_id") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."turn_trace" ADD CONSTRAINT "turn_trace_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."turn_trace" ADD CONSTRAINT "turn_trace_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES public."conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."call_events" ADD CONSTRAINT "call_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."call_events" ADD CONSTRAINT "call_events_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES public."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."commitments" ADD CONSTRAINT "commitments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."commitments" ADD CONSTRAINT "commitments_call_event_id_fkey" FOREIGN KEY ("call_event_id") REFERENCES public."call_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE public."followup_queue" ADD CONSTRAINT "followup_queue_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."crm_notifications" ADD CONSTRAINT "crm_notifications_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES public."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."crm_notifications" ADD CONSTRAINT "crm_notifications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public."channels" ADD CONSTRAINT "channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES public."tenant_settings"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

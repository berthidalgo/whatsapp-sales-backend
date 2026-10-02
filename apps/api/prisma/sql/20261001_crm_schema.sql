-- Contrato CRM 20261001: esquema completo sin datos comerciales.
-- Bootstrap en BD vacía; upgrades mediante preparar-db-crm.js (nunca ejecutar a ciegas en producción).
-- CreateTable
CREATE TABLE public."vendors" (
    "id" SERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VENDOR',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "instanciaEvolution" TEXT,
    "whatsappNumber" TEXT,
    "pin" TEXT DEFAULT '0000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."campaigns" (
    "id" SERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "vendorId" INTEGER NOT NULL,
    "botPrompt" TEXT,
    "config" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."triggers" (
    "id" SERIAL NOT NULL,
    "texto" TEXT NOT NULL,
    "campaignId" INTEGER NOT NULL,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."flow_steps" (
    "id" SERIAL NOT NULL,
    "orden" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "mensaje" TEXT NOT NULL,
    "followupHrs" INTEGER,
    "campaignId" INTEGER NOT NULL,

    CONSTRAINT "flow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."leads" (
    "id" SERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "campaignId" INTEGER,
    "vendorId" INTEGER,
    "pasoActual" INTEGER NOT NULL DEFAULT 0,
    "ultimoMensaje" TIMESTAMP(6),
    "notificado" BOOLEAN NOT NULL DEFAULT false,
    "estado" TEXT NOT NULL DEFAULT 'NUEVO',
    "nombreDetectado" TEXT,
    "productoDetectado" TEXT,
    "wa_jid" TEXT,
    "addressing_mode" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "archived_reason" TEXT,
    "archived_by" INTEGER,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."conversations" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "campaignId" INTEGER,
    "vendorId" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "lastBotMessageAt" TIMESTAMP(3),
    "lastLeadMessageAt" TIMESTAMP(3),
    "reactivationCount" INTEGER NOT NULL DEFAULT 0,
    "lastReactivationAt" TIMESTAMP(3),
    "vendorNotifiedAt" TIMESTAMP(3),
    "vendorNotificationCount" INTEGER NOT NULL DEFAULT 0,
    "reminderJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."messages" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "conversationId" INTEGER,
    "origen" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wa_message_id" TEXT,
    "cloud_phone_number_id" TEXT,
    "status" TEXT,
    "status_at" TIMESTAMP(3),
    "error_code" INTEGER,
    "error_detalle" TEXT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE public."media_assets" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "message_id" INTEGER,
    "tenant_id" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'LEAD',
    "tipo" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "storage" TEXT NOT NULL DEFAULT 'pg',
    "bytes" BYTEA,
    "url" TEXT,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."bot_config" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "nombre" TEXT,
    "msgBienvenida" TEXT,
    "msgProducto" TEXT,
    "msgExperiencia" TEXT,
    "msgPresentacion" TEXT,
    "msgObjecion" TEXT,
    "msgUrgencia" TEXT,
    "msgHandoff" TEXT,
    "nombreEmpresa" TEXT,
    "nombreProducto" TEXT,
    "updatedEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."lead_state" (
    "lead_id" INTEGER NOT NULL,
    "current_mode" TEXT NOT NULL DEFAULT 'AUTO_CONSULTIVO',
    "current_stage" TEXT NOT NULL DEFAULT 'greeting',
    "slots_filled" JSONB NOT NULL DEFAULT '{}',
    "slots_pending" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intentos_por_slot" JSONB NOT NULL DEFAULT '{}',
    "vendor_active_id" INTEGER,
    "mode_entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returning_lead_flag" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_state_pkey" PRIMARY KEY ("lead_id")
);

-- CreateTable
CREATE TABLE public."turn_trace" (
    "turn_id" UUID NOT NULL,
    "lead_id" INTEGER,
    "lead_id_archived" INTEGER,
    "conversation_id" INTEGER,
    "reset_generation" INTEGER NOT NULL DEFAULT 1,
    "data_quality" TEXT NOT NULL DEFAULT 'real_pilot',
    "lead_message" TEXT NOT NULL,
    "lead_message_type" TEXT NOT NULL DEFAULT 'text',
    "perception" JSONB NOT NULL DEFAULT '{}',
    "perception_version" TEXT,
    "state_before" JSONB NOT NULL DEFAULT '{}',
    "state_after" JSONB NOT NULL DEFAULT '{}',
    "mode_router_decision" JSONB NOT NULL DEFAULT '{}',
    "policy_decision" JSONB NOT NULL DEFAULT '{}',
    "policy_version" TEXT,
    "guardrails_evaluated" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bot_response" TEXT,
    "response_version" TEXT,
    "model_used" TEXT,
    "audit_log" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "latency_ms" INTEGER,
    "model_costs" JSONB NOT NULL DEFAULT '{}',
    "pii_redacted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_trace_pkey" PRIMARY KEY ("turn_id")
);

-- CreateTable
CREATE TABLE public."call_events" (
    "id" TEXT NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "occurred_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "outcome_tag" TEXT,
    "modalidad_acordada" TEXT,
    "fecha_proximo_evento" TIMESTAMP(3),
    "condiciones_especiales" TEXT,
    "vendor_notes" TEXT,
    "voice_note_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."commitments" (
    "id" TEXT NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "call_event_id" TEXT,
    "description" TEXT NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "fulfilled" BOOLEAN NOT NULL DEFAULT false,
    "fulfilled_at" TIMESTAMP(3),
    "reminder_sent" BOOLEAN NOT NULL DEFAULT false,
    "reminder_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."followup_queue" (
    "id" TEXT NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "context_snapshot" JSONB NOT NULL DEFAULT '{}',
    "followup_type" TEXT NOT NULL DEFAULT 'soft_reengagement',
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "executed_at" TIMESTAMP(3),
    "result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followup_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."crm_notifications" (
    "id" TEXT NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "priority" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE public."test_phones" (
    "telefono" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by" TEXT,
    "description" TEXT,

    CONSTRAINT "test_phones_pkey" PRIMARY KEY ("telefono")
);

-- CreateTable
CREATE TABLE public."tenant_settings" (
    "tenant_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "num_vendedores_pagados" INTEGER NOT NULL DEFAULT 0,
    "precio_por_vendedor_usd" DECIMAL(10,2) NOT NULL DEFAULT 20.00,
    "periodo_meses" INTEGER NOT NULL DEFAULT 6,
    "fecha_inicio" TIMESTAMPTZ(6),
    "fecha_fin" TIMESTAMPTZ(6),
    "monto_total_pagado_usd" DECIMAL(10,2),
    "estado_suscripcion" TEXT NOT NULL DEFAULT 'trial',
    "turnos_incluidos_por_vendedor_mes" INTEGER NOT NULL DEFAULT 10000,
    "turnos_consumidos_mes_actual" INTEGER NOT NULL DEFAULT 0,
    "mes_actual_inicio" TIMESTAMPTZ(6) NOT NULL DEFAULT date_trunc('month'::text, now()),
    "gemini_api_key_encrypted" TEXT,
    "byok_enabled" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE public."channels" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'evolution',
    "modo" TEXT NOT NULL DEFAULT 'nube_pura',
    "external_key" TEXT NOT NULL,
    "numero_display" TEXT,
    "credenciales" JSONB,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "es_default" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendors_tenant_id_idx" ON public."vendors"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_tenant_id_telefono_key" ON public."vendors"("tenant_id", "telefono");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_tenant_id_whatsappNumber_key" ON public."vendors"("tenant_id", "whatsappNumber");

-- CreateIndex
CREATE INDEX "campaigns_tenant_id_idx" ON public."campaigns"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_tenant_id_slug_key" ON public."campaigns"("tenant_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "flow_steps_campaignId_orden_key" ON public."flow_steps"("campaignId", "orden");

-- CreateIndex
CREATE INDEX "leads_tenant_id_idx" ON public."leads"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenant_id_telefono_key" ON public."leads"("tenant_id", "telefono");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_leadId_campaignId_key" ON public."conversations"("leadId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_wa_message_id_key" ON public."messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "messages_status_idx" ON public."messages"("status");

-- CreateIndex
CREATE INDEX "pending_cloud_receipts_tenant_id_phone_number_id_idx" ON public."pending_cloud_receipts"("tenant_id", "phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_cloud_receipts_phone_number_id_wa_message_id_key" ON public."pending_cloud_receipts"("phone_number_id", "wa_message_id");

-- CreateIndex
CREATE INDEX "media_assets_lead_id_idx" ON public."media_assets"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_external_key_key" ON public."channels"("external_key");

-- CreateIndex
CREATE INDEX "channels_tenant_id_idx" ON public."channels"("tenant_id");

-- CreateIndex
CREATE INDEX "channels_provider_activo_idx" ON public."channels"("provider", "activo");

-- AddForeignKey
ALTER TABLE public."campaigns" ADD CONSTRAINT "campaigns_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES public."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."triggers" ADD CONSTRAINT "triggers_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."flow_steps" ADD CONSTRAINT "flow_steps_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."leads" ADD CONSTRAINT "leads_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."leads" ADD CONSTRAINT "leads_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."messages" ADD CONSTRAINT "messages_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES public."leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."pending_cloud_receipts" ADD CONSTRAINT "pending_cloud_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES public."tenant_settings"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."media_assets" ADD CONSTRAINT "media_assets_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."lead_state" ADD CONSTRAINT "lead_state_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."lead_state" ADD CONSTRAINT "lead_state_vendor_active_id_fkey" FOREIGN KEY ("vendor_active_id") REFERENCES public."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."turn_trace" ADD CONSTRAINT "turn_trace_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."turn_trace" ADD CONSTRAINT "turn_trace_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES public."conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."call_events" ADD CONSTRAINT "call_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."call_events" ADD CONSTRAINT "call_events_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES public."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."commitments" ADD CONSTRAINT "commitments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."commitments" ADD CONSTRAINT "commitments_call_event_id_fkey" FOREIGN KEY ("call_event_id") REFERENCES public."call_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."followup_queue" ADD CONSTRAINT "followup_queue_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."crm_notifications" ADD CONSTRAINT "crm_notifications_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES public."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."crm_notifications" ADD CONSTRAINT "crm_notifications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES public."leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE public."channels" ADD CONSTRAINT "channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES public."tenant_settings"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;


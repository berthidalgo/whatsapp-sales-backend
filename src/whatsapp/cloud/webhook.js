// src/whatsapp/cloud/webhook.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Dos verificaciones que exige Meta para el webhook:
//   1. HANDSHAKE (GET): al registrar el webhook, Meta hace un GET con
//      hub.mode=subscribe, hub.verify_token=<lo que pusimos>, hub.challenge=<random>.
//      Debemos responder el challenge SOLO si el verify_token coincide.
//   2. FIRMA (POST): cada POST trae header X-Hub-Signature-256: sha256=<hmac>.
//      Se valida con HMAC-SHA256 del RAW body usando el app_secret → descarta
//      webhooks falsos. Requiere el body CRUDO (sin parsear) — el cableado debe
//      capturarlo (en Fastify, con un content-type parser que guarde el raw).

import crypto from 'node:crypto'
import { cloudConfig } from './config.js'

/**
 * Handshake GET de Meta. Devuelve { ok, challenge } — si ok, responder el challenge
 * en texto plano con 200; si no, 403.
 */
export function verifyWebhookChallenge(query = {}) {
  const c = cloudConfig()
  const mode = query['hub.mode']
  const token = query['hub.verify_token']
  const challenge = query['hub.challenge']
  if (mode === 'subscribe' && c.verifyToken && token === c.verifyToken) {
    return { ok: true, challenge }
  }
  return { ok: false, challenge: null }
}

/**
 * Valida la firma X-Hub-Signature-256 del POST contra el raw body.
 * @param {Buffer|string} rawBody - el cuerpo CRUDO tal cual llegó (no el parseado)
 * @param {string} signatureHeader - valor del header 'x-hub-signature-256'
 * @returns {{ok:boolean, reason:string|null}}
 */
export function verifySignature(rawBody, signatureHeader) {
  const c = cloudConfig()
  if (!c.appSecret)       return { ok: false, reason: 'no_app_secret_configured' }
  if (!signatureHeader)   return { ok: false, reason: 'no_signature_header' }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', c.appSecret)
    .update(rawBody)
    .digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
  return { ok, reason: ok ? null : 'signature_mismatch' }
}

export const CLOUD_WEBHOOK_VERSION = 'v1_handshake_signature'

// src/lib/pin.js — PIN de vendedor con hash (sep 2026)
//
// POR QUÉ: los PIN vivían en TEXTO PLANO en vendors.pin (y todo vendedor creado desde
// el CRM nacía con "0000"). Cualquiera con lectura de la BD —un backup, un dump, un
// panel de Supabase compartido— tenía la llave de todos los paneles.
//
// Formato guardado: scrypt$<salt base64>$<hash base64>. scrypt viene en node:crypto:
// sin dependencias nativas (el bcrypt que estaba en package.json nunca se usó y traía
// 2 vulnerabilidades críticas vía node-tar).
//
// MIGRACIÓN SIN VENTANA: un PIN viejo en texto plano se sigue aceptando y se re-guarda
// hasheado en el primer login correcto. No hace falta tocar la BD a mano.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

const PREFIJO = 'scrypt$'
const KEYLEN = 32

export function esHash(guardado) {
  return typeof guardado === 'string' && guardado.startsWith(PREFIJO)
}

export function hashPin(pin) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(pin), salt, KEYLEN)
  return `${PREFIJO}${salt.toString('base64')}$${hash.toString('base64')}`
}

function igualesTiempoConstante(a, b) {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Verifica un PIN contra lo guardado (hash scrypt o texto plano heredado). */
export function verificarPin(pin, guardado) {
  if (pin == null || !guardado) return false
  if (!esHash(guardado)) return igualesTiempoConstante(String(pin), String(guardado))
  const [, saltB64, hashB64] = guardado.split('$')
  if (!saltB64 || !hashB64) return false
  const esperado = Buffer.from(hashB64, 'base64')
  const calculado = scryptSync(String(pin), Buffer.from(saltB64, 'base64'), esperado.length)
  return esperado.length === calculado.length && timingSafeEqual(esperado, calculado)
}

// PINs que no se aceptan como nuevos: los que prueba cualquiera primero.
const DEBILES = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1212', '0123'])

/** Reglas para un PIN NUEVO: 4 dígitos (lo que acepta la pantalla de login) y no trivial. */
export function validarPinNuevo(pin) {
  const p = String(pin ?? '')
  if (!/^\d{4}$/.test(p)) return 'el PIN debe tener exactamente 4 dígitos'
  if (DEBILES.has(p)) return 'ese PIN es demasiado fácil de adivinar'
  return null
}

/** ¿El PIN guardado es el de fábrica? (para pedirle al vendedor que lo cambie) */
export function esPinDeFabrica(pin) {
  return String(pin ?? '') === '0000'
}

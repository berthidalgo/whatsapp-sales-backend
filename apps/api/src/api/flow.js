// src/api/flow.js — Flow Builder (Hito A): sirve el flujo del cerebro como grafo.
// Hito A: devuelve el flujo MATERIALIZADO (la semilla, derivada de stage-definitions).
// Hito B (futuro): si la campaña tiene un flow guardado en `config.flow`, devolver ESE
// (source:'custom'); si no, la semilla. Por ahora siempre la semilla.
import { materializarFlujoCerebro } from '../brain/flow-materializer.js'

export async function getFlowV2(request, reply) {
  try {
    return reply.send(materializarFlujoCerebro())
  } catch (error) {
    console.error('[flow] getFlowV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener el flujo' })
  }
}

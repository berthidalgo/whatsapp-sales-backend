// FlowBuilder — Hito B: ver Y EDITAR el flujo del cerebro, por programa (campaña).
// Edita la guía/munición y el label de cada nodo (lo que el cerebro USARÁ en Hito C) y
// guarda en campaign.config (solo ADMIN/SUPERVISOR). La estructura del grafo viene del
// cerebro (materializada); el supervisor personaliza el texto por momento, por programa.
import { useMemo, useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from './api'
import { useToast } from './Toast'
import type { AuthUser, Flow, FlowNode as FNode } from '@shared/types'

function MomentNode({ data }: NodeProps) {
  const n = data as unknown as FNode & { sel?: boolean }
  return (
    <div className={`fnode fnode-${n.type}${n.sel ? ' fnode-sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="fnode-top">
        <span className="fnode-m">{n.momento}</span>
        <span className="fnode-label">{n.label}</span>
        {n.cloudOnly && <span className="fnode-cloud" title="Necesita WhatsApp Cloud API">🔒 Cloud</span>}
      </div>
      <div className="fnode-guide">{n.guidance}</div>
      {n.requiredSlots.length > 0 && (
        <div className="fnode-slots">{n.requiredSlots.map(s => <span key={s} className="fnode-slot">{s}</span>)}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = { moment: MomentNode }

export default function FlowBuilder({ user }: { user: AuthUser }) {
  const qc = useQueryClient()
  const toast = useToast()
  const puedeEditar = user.role === 'ADMIN' || user.role === 'SUPERVISOR'

  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const campaignsQ = useQuery({ queryKey: ['campaigns'], queryFn: api.campaigns })
  const flowQ = useQuery({ queryKey: ['flow', campaignId], queryFn: () => api.flow(campaignId ?? undefined) })

  // Default: el primer programa.
  useEffect(() => {
    if (campaignId == null && campaignsQ.data?.length) setCampaignId(campaignsQ.data[0].id)
  }, [campaignsQ.data, campaignId])

  // Cargar el flujo del programa en el estado editable (descarta ediciones sin guardar).
  useEffect(() => {
    if (flowQ.data) { setFlow(flowQ.data); setDirty(false); setSelId(null) }
  }, [flowQ.data])

  function editarNodo(id: string, campo: 'guidance' | 'label', valor: string) {
    setFlow(f => f ? { ...f, nodes: f.nodes.map(n => n.id === id ? { ...n, [campo]: valor } : n) } : f)
    setDirty(true)
  }

  async function guardar() {
    if (!flow || campaignId == null || saving) return
    setSaving(true)
    try {
      const r = await api.saveFlow(campaignId, flow)
      setDirty(false)
      qc.invalidateQueries({ queryKey: ['campaigns'] })   // refresca tieneFlow
      toast(`Flujo guardado (${r.nodosEditados} nodo${r.nodosEditados === 1 ? '' : 's'} editado${r.nodosEditados === 1 ? '' : 's'}).`, 'success')
    } catch { toast('No se pudo guardar el flujo.') }
    finally { setSaving(false) }
  }

  function descartar() {
    if (flowQ.data) { setFlow(flowQ.data); setDirty(false); setSelId(null) }
  }

  const { rnodes, redges } = useMemo(() => {
    if (!flow) return { rnodes: [] as Node[], redges: [] as Edge[] }
    const rnodes: Node[] = flow.nodes.map((n, i) => ({
      id: n.id, type: 'moment',
      data: { ...n, sel: n.id === selId } as unknown as Record<string, unknown>,
      position: n.id === 'returning_recognition' ? { x: 2 * 300, y: 280 } : { x: i * 300, y: 0 },
    }))
    const redges: Edge[] = flow.edges.map(e => ({
      id: e.id, source: e.from, target: e.to, label: e.condition, animated: !!e.fastTrack,
      labelStyle: { fontSize: 10, fill: '#5b6573' },
      style: e.fastTrack ? { stroke: '#d6453b', strokeWidth: 2 } : { stroke: '#b6c0cc' },
    }))
    return { rnodes, redges }
  }, [flow, selId])

  const nodoSel = flow?.nodes.find(n => n.id === selId) || null

  return (
    <div className="flow-canvas">
      <div className="flow-head">
        <div className="flow-head-row">
          <div>
            <div className="flow-title">🔀 Flujo del cerebro</div>
            <div className="flow-sub">
              {puedeEditar ? 'Click en un nodo para editar su guía. ' : 'Solo lectura (lo edita el supervisor). '}
              Aristas rojas = saltos rápidos (lead HOT).
            </div>
          </div>
          <div className="flow-actions">
            <select className="btn" value={campaignId ?? ''} onChange={e => setCampaignId(Number(e.target.value) || null)} title="Programa">
              {campaignsQ.data?.map(c => (
                <option key={c.id} value={c.id}>{c.nombre}{c.tieneFlow ? ' ✎' : ''}{c.activa ? '' : ' (inactivo)'}</option>
              ))}
            </select>
            {puedeEditar && <>
              <button className="btn btn-send" onClick={() => void guardar()} disabled={!dirty || saving}>
                {saving ? '…' : 'Guardar'}
              </button>
              <button className="btn" onClick={descartar} disabled={!dirty}>Descartar</button>
            </>}
          </div>
        </div>
      </div>

      <div className="flow-body">
        <div className="flow-rf">
          {flowQ.isLoading && <div className="empty">Cargando flujo…</div>}
          {flowQ.isError && <div className="empty">No se pudo cargar el flujo</div>}
          {flow && (
            <ReactFlow
              nodes={rnodes} edges={redges} nodeTypes={nodeTypes} fitView minZoom={0.2}
              nodesDraggable={false} onNodeClick={(_, node) => setSelId(node.id)}
              onPaneClick={() => setSelId(null)}
            >
              <Background gap={20} color="#eef1f5" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        {nodoSel && (
          <aside className="flow-edit">
            <div className="fe-top">
              <span className="fnode-m">{nodoSel.momento}</span>
              <span className="fe-stage">{nodoSel.stage}</span>
              <button className="fe-x" onClick={() => setSelId(null)} title="Cerrar">✕</button>
            </div>
            <label className="fe-label">Nombre del momento</label>
            <input className="fe-input" value={nodoSel.label} disabled={!puedeEditar}
              onChange={e => editarNodo(nodoSel.id, 'label', e.target.value)} />
            <label className="fe-label">Guía / munición (lo que el cerebro usa en este momento)</label>
            <textarea className="fe-textarea" value={nodoSel.guidance} disabled={!puedeEditar} rows={7}
              onChange={e => editarNodo(nodoSel.id, 'guidance', e.target.value)} />
            {nodoSel.requiredSlots.length > 0 && (
              <>
                <label className="fe-label">Slots requeridos (los define el cerebro)</label>
                <div className="fnode-slots">{nodoSel.requiredSlots.map(s => <span key={s} className="fnode-slot">{s}</span>)}</div>
              </>
            )}
            <div className="fe-hint">Los cambios se aplican al bot cuando se conecte la orquestación (próximo hito). Hoy se guardan como configuración del programa.</div>
          </aside>
        )}
      </div>
    </div>
  )
}

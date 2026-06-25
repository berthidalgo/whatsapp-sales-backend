// FlowBuilder — Hito A: visor (read-only) del flujo del cerebro materializado.
// Trae GET /v2/flow (el grafo derivado de stage-definitions) y lo dibuja con React Flow.
// Edición + guardar = Hito B; que el cerebro LEA el flow = Hito C (con candado de evals).
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from './api'
import type { FlowNode as FNode } from '@shared/types'

// Nodo visual de un momento del cerebro.
function MomentNode({ data }: NodeProps) {
  const n = data as unknown as FNode
  return (
    <div className={`fnode fnode-${n.type}`}>
      <Handle type="target" position={Position.Left} />
      <div className="fnode-top">
        <span className="fnode-m">{n.momento}</span>
        <span className="fnode-label">{n.label}</span>
        {n.cloudOnly && <span className="fnode-cloud" title="Necesita WhatsApp Cloud API">🔒 Cloud</span>}
      </div>
      <div className="fnode-guide">{n.guidance}</div>
      {n.requiredSlots.length > 0 && (
        <div className="fnode-slots">
          {n.requiredSlots.map(s => <span key={s} className="fnode-slot">{s}</span>)}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { moment: MomentNode }

export default function FlowBuilder() {
  const flowQ = useQuery({ queryKey: ['flow'], queryFn: api.flow })

  const { rnodes, redges } = useMemo(() => {
    const flow = flowQ.data
    if (!flow) return { rnodes: [] as Node[], redges: [] as Edge[] }
    // Layout simple: M1→M7 en línea horizontal; el nodo "Reactivado" debajo (es re-entrada).
    const rnodes: Node[] = flow.nodes.map((n, i) => ({
      id: n.id,
      type: 'moment',
      data: n as unknown as Record<string, unknown>,
      position: n.id === 'returning_recognition' ? { x: 2 * 300, y: 280 } : { x: i * 300, y: 0 },
    }))
    const redges: Edge[] = flow.edges.map(e => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.condition,
      animated: !!e.fastTrack,
      labelStyle: { fontSize: 10, fill: '#5b6573' },
      style: e.fastTrack ? { stroke: '#d6453b', strokeWidth: 2 } : { stroke: '#b6c0cc' },
    }))
    return { rnodes, redges }
  }, [flowQ.data])

  return (
    <div className="flow-canvas">
      <div className="flow-head">
        <div>
          <div className="flow-title">🔀 {flowQ.data?.name ?? 'Flujo del cerebro'}</div>
          <div className="flow-sub">
            Vista del flujo que el cerebro usa hoy · <strong>solo lectura</strong> (editar = próximo hito).
            Nodos <em>generativos</em> = el cerebro compone; las aristas rojas = saltos rápidos (lead HOT).
          </div>
        </div>
      </div>
      <div className="flow-rf">
        {flowQ.isLoading && <div className="empty">Cargando flujo…</div>}
        {flowQ.isError && <div className="empty">No se pudo cargar el flujo</div>}
        {flowQ.data && (
          <ReactFlow nodes={rnodes} edges={redges} nodeTypes={nodeTypes} fitView minZoom={0.2} nodesDraggable={false}>
            <Background gap={20} color="#eef1f5" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}

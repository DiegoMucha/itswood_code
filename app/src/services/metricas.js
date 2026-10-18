import { pedir, conRespaldo } from './api.js';
import { demo } from './demo/store.js';

/**
 * Métricas que salen de los registros de Mermín (GET /metricas, propuesta).
 * En modo ejemplo: valores rotulados "Ejemplo" + lo que pase en el chat de esta demo.
 */
export async function obtenerMetricasChat(periodo = 'todo') {
  return conRespaldo(
    () => pedir(`/metricas?periodo=${encodeURIComponent(periodo)}`),
    async () => {
      const base = { conversaciones: 42, con_pedido: 15, tiempos_seg: [3, 4, 2, 5, 3] };
      const conv = demo.conversaciones.filter((c) => c.inicio);
      const tiempos = [...base.tiempos_seg, ...conv.map((c) => c.primera_respuesta_seg).filter((t) => t != null)];
      const total = base.conversaciones + conv.length;
      const conPedido = base.con_pedido + conv.filter((c) => c.pedido_id).length;
      return {
        ejemplo: true,
        tiempo_primera_respuesta_seg: tiempos.reduce((a, b) => a + b, 0) / tiempos.length,
        tiempo_primera_respuesta_antes_min: demo.config.metricas?.tiempo_respuesta_antes_min ?? null,
        conversaciones: total,
        conversaciones_con_pedido: conPedido,
        conversion: conPedido / total,
      };
    },
    { rutaPropuesta: true },
  );
}

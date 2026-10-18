import { pedir, conRespaldo } from './api.js';
import { demo } from './demo/store.js';

// Ruta propuesta por el frontend (ver docs/API_CONTRATO.md).
export async function listarNotificaciones() {
  return conRespaldo(
    () => pedir('/notificaciones'),
    // El resumen diario solo aparece si la dueña lo tiene activado en Ajustes.
    async () => structuredClone(demo.notificaciones.filter((n) => n.tipo !== 'resumen' || demo.config.notificaciones?.resumen_diario !== false)),
    { rutaPropuesta: true },
  );
}

export async function marcarLeida(id) {
  return conRespaldo(
    () => pedir(`/notificaciones/${id}`, { method: 'PATCH', body: { leido: true } }),
    async () => {
      const n = demo.notificaciones.find((x) => x.id === id);
      if (n) n.leido = true;
      return n;
    },
    { rutaPropuesta: true },
  );
}

import { pedir, conRespaldo } from './api.js';
import { demo } from './demo/store.js';
import { calcularSegmentos, recomendaciones } from '../lib/segmentos.js';
import ventas from '../data/ventas_2026.demo.json';

// Rutas propuestas por el frontend (ver docs/API_CONTRATO.md). Sin backend: reglas locales.
export async function listarSegmentos() {
  return conRespaldo(() => pedir('/segmentos'), async () => calcularSegmentos(ventas), { rutaPropuesta: true });
}

export async function obtenerRecomendaciones(segmento) {
  return conRespaldo(
    () => pedir(`/segmentos/${segmento.id}/recomendaciones`),
    async () => recomendaciones(segmento, demo.config.negocio),
    { rutaPropuesta: true },
  );
}

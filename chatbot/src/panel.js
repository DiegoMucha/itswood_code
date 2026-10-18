'use strict';

// Respuestas de las rutas del dashboard que se calculan con las pestañas del libro (métricas, configuración,
// segmentos...). El flujo [7] lee las pestañas y llama a responderPanel; el simulador hace lo mismo.
// En n8n se concatenan antes config.js y metricas.js; en Node se cargan con require.

const PANEL_DEPS = typeof calcularMetricas === 'function'
  ? { leerConfig, calcularMetricas }
  : { ...require('./config'), ...require('./metricas') };

function panelFilas(filas) {
  return (filas || []).filter(x => x && Object.keys(x).some(k => k !== 'row_number' && String(x[k] ?? '').trim() !== ''));
}

// peticion: salida de validarPeticion. datos: { config, eventos, solicitudes, conversaciones, ventas, clientes,
// clientesFuente, productos } con las filas de cada pestaña.
function responderPanel(peticion, datos, ahora) {
  const d = {};
  for (const k of Object.keys(datos || {})) d[k] = panelFilas(datos[k]);
  const config = PANEL_DEPS.leerConfig(d.config);
  const ahoraIso = ahora || new Date().toISOString();
  switch (peticion.ruta) {
    case 'metricas': {
      const metricas = PANEL_DEPS.calcularMetricas({
        config, eventos: d.eventos, solicitudes: d.solicitudes, conversaciones: d.conversaciones, ventas: d.ventas,
        clientesBot: d.clientes, clientesFuente: d.clientesFuente, desde: peticion.desde, hasta: peticion.hasta, ahora: ahoraIso,
      });
      return { status: 200, cuerpo: { ok: true, ruta: 'metricas', ...metricas } };
    }
    default:
      return { status: 404, cuerpo: { ok: false, error: `Ruta sin respuesta de panel: ${peticion.ruta}.` } };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { responderPanel };

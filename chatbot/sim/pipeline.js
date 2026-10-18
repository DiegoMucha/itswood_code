'use strict';

// Réplica local de los flujos de n8n, nodo por nodo y en el mismo orden, usando la hoja en memoria.
// Usa los mismos archivos de src/ que se incrustan en los nodos Code.

const { procesar, COLUMNAS_CONVERSACION, COLUMNAS_CLIENTE, COLUMNAS_SOLICITUD } = require('../src/motor');
const { normalizarEntrada } = require('../src/normalizar');
const { esDuplicado, verificarCambioModo, prepararEnvios } = require('../src/pasos');
const { decidirAccionHumana } = require('../src/humano');
const { PESTANAS: T, COLUMNAS_PAUTAS } = require('../src/hojas');
const { prepararCotizaciones, identificarProveedor, registrarRespuestaProveedor, COLUMNAS_COTIZACION } = require('../src/ordenes');
const api = require('../src/api');
const { leerConfig } = require('../src/config');
const { elegirHojaFuente, prepararSync, filaErrorSync } = require('../src/sync');

function elegir(obj, columnas) { return Object.fromEntries(columnas.map(c => [c, obj[c] === undefined || obj[c] === null ? '' : obj[c]])); }

// Subflujo "ITS WOOD - Procesar mensaje".
async function procesarMensaje(mensaje, entorno) {
  const { hoja, enviar, ahora, config = {} } = entorno;
  const reloj = () => (typeof ahora === 'function' ? ahora() : ahora) || new Date().toISOString();

  if (esDuplicado(mensaje, hoja.leer(T.eventos, 'mensaje_id', mensaje.mensaje_id))) return { duplicado: true };

  hoja.guardar(T.eventos, 'mensaje_id', {
    mensaje_id: mensaje.mensaje_id, fecha: mensaje.fecha_iso, wa_id: mensaje.wa_id, conversacion_id: '',
    direccion: 'ENTRADA', tipo: mensaje.tipo, texto: mensaje.texto, media_id: mensaje.media_id, resultado: 'RECIBIDO', detalle: '',
  });

  // Un proveedor que responde no pasa por el bot de clientes: su mensaje es la respuesta de la cotización.
  const proveedor = identificarProveedor(mensaje, hoja.leer(T.proveedores));
  if (proveedor.es_proveedor) {
    const r = registrarRespuestaProveedor({ mensaje, proveedor, cotizaciones: hoja.leer(T.cotizaciones, 'proveedor_id', proveedor.proveedor_id), ahora: reloj() });
    if (r.actualizar) hoja.actualizar(T.cotizaciones, 'cotizacion_id', r.actualizar);
    hoja.guardar(T.eventos, 'mensaje_id', { mensaje_id: mensaje.mensaje_id, resultado: r.resultado, detalle: proveedor.proveedor_id });
    return { proveedor: true, ...r, enviados: [] };
  }

  const conversacion = hoja.leer(T.conversaciones, 'wa_id', mensaje.wa_id)[0] || null;
  const catalogo = hoja.leer(T.catalogo);
  const inventario = hoja.leer(T.inventario);
  const configBot = hoja.leer(T.config);
  const motor = procesar({ mensaje, conversacion, catalogo, inventario, config: configBot, ahora: reloj() });

  const verificacion = verificarCambioModo(motor, hoja.leer(T.conversaciones, 'wa_id', mensaje.wa_id));
  if (verificacion.cambio) {
    hoja.actualizar(T.conversaciones, 'wa_id', { wa_id: motor.wa_id, ultima_entrada: motor.conversacion.ultima_entrada });
    hoja.guardar(T.eventos, 'mensaje_id', { mensaje_id: mensaje.mensaje_id, resultado: 'OMITIDO_CAMBIO_MODO', detalle: `modo cambió a ${verificacion.modo_actual}` });
    return { motor, omitido: true, enviados: [] };
  }

  hoja.guardar(T.conversaciones, 'wa_id', elegir(motor.conversacion, COLUMNAS_CONVERSACION));
  if (motor.solicitud) {
    hoja.agregar(T.solicitudes, elegir(motor.solicitud, COLUMNAS_SOLICITUD));
    if (motor.pauta) hoja.agregar(T.pautas, elegir(motor.pauta, COLUMNAS_PAUTAS));
    hoja.guardar(T.clientes, 'wa_id', elegir(motor.cliente, COLUMNAS_CLIENTE));
  }
  hoja.guardar(T.eventos, 'mensaje_id', {
    mensaje_id: mensaje.mensaje_id, conversacion_id: motor.conversacion.conversacion_id, resultado: motor.resultado_evento,
  });
  for (const evento of motor.eventos || []) hoja.agregar(T.eventos, evento);

  const destinoAviso = motor.aviso_destino || config.waAvisos;
  if (motor.aviso && destinoAviso) {
    try { await enviar({ to: destinoAviso, texto: motor.aviso, aviso: true }); } catch (e) { /* el aviso no detiene la atención */ }
  }

  const envios = prepararEnvios(motor, mensaje, hoja.leer(T.conversaciones, 'wa_id', mensaje.wa_id), config.phoneNumberId);
  const enviados = [];
  for (const envio of envios) {
    const base = { fecha: reloj(), wa_id: envio.wa_id, conversacion_id: envio.conversacion_id, direccion: 'SALIDA', tipo: 'text', texto: envio.texto, media_id: '' };
    if (envio.accion !== 'enviar') {
      hoja.agregar(T.eventos, { ...base, mensaje_id: envio.mensaje_id, resultado: envio.resultado, detalle: envio.detalle });
      continue;
    }
    try {
      const r = await enviar(envio);
      hoja.agregar(T.eventos, { ...base, mensaje_id: r.messages[0].id, resultado: 'ENVIADO', detalle: `respuesta a ${envio.en_respuesta_a}` });
      enviados.push(envio.texto);
    } catch (e) {
      hoja.agregar(T.eventos, { ...base, mensaje_id: `ERR-${envio.en_respuesta_a}-${envio.orden}`, resultado: 'ERROR_ENVIO', detalle: String(e.message).slice(0, 500) });
    }
  }
  return { motor, enviados };
}

// Subflujo "ITS WOOD - Confirmar orden".
async function confirmarOrden({ solicitud_id, simular }, entorno) {
  const { hoja, enviarPlantilla, ahora, config = {} } = entorno;
  const reloj = () => (typeof ahora === 'function' ? ahora() : ahora) || new Date().toISOString();
  const r = prepararCotizaciones({
    solicitud: hoja.leer(T.solicitudes, 'solicitud_id', solicitud_id)[0] || null,
    proveedores: hoja.leer(T.proveedores),
    cotizaciones: hoja.leer(T.cotizaciones, 'solicitud_id', solicitud_id),
    catalogo: hoja.leer(T.catalogo),
    ahora: reloj(), simular, phoneNumberId: config.phoneNumberId,
  });
  if (!r.ok) return r;
  hoja.actualizar(T.solicitudes, 'solicitud_id', r.actualizar_solicitud);
  const resultados = [];
  for (const envio of r.envios) {
    const fila = elegir(envio, COLUMNAS_COTIZACION);
    if (envio.accion === 'enviar') {
      try {
        const res = await enviarPlantilla(envio);
        fila.mensaje_id = res.messages[0].id;
      } catch (e) {
        Object.assign(fila, { estado: 'ERROR_ENVIO', detalle: String(e.message).slice(0, 500) });
      }
    } else {
      fila.detalle = 'simulado: no se envió por WhatsApp';
    }
    hoja.agregar(T.cotizaciones, fila);
    resultados.push({ proveedor: envio.proveedor_nombre, estado: fila.estado });
  }
  return { ...r, resultados };
}

// Flujo "ITS WOOD - API".
async function llamarApi({ metodo, ruta, query, body }, entorno) {
  const { hoja } = entorno;
  const v = api.validarPeticion({ metodo, ruta, query, body });
  if (!v.ok) return { status: v.status, cuerpo: { ok: false, error: v.error } };
  switch (v.ruta) {
    case 'salud': return { status: 200, cuerpo: { ok: true, servicio: 'itswood-bot' } };
    case 'mensaje': {
      const antes = hoja.tablas[T.eventos].length;
      await procesarMensaje(v.mensaje, entorno);
      return api.respuestaMensaje(v.mensaje, hoja.tablas[T.eventos].slice(antes));
    }
    case 'conversacion': return api.respuestaConversacion(hoja.leer(T.conversaciones, 'wa_id', v.filtros.wa_id), v.filtros.wa_id);
    case 'solicitudes': return api.respuestaLista(v.ruta, hoja.leer(T.solicitudes), v.filtros, v.limite);
    case 'proveedores': return api.respuestaLista(v.ruta, hoja.leer(T.proveedores), v.filtros, v.limite);
    case 'cotizaciones': return api.respuestaLista(v.ruta, hoja.leer(T.cotizaciones), v.filtros, v.limite);
    case 'confirmar-orden': {
      const r = await confirmarOrden({ solicitud_id: v.solicitud_id, simular: v.simular }, entorno);
      return { status: r.status, cuerpo: r.ok ? { ok: true, resumen: r.resumen, cotizaciones: r.resultados } : { ok: false, error: r.error } };
    }
    default: return { status: 404, cuerpo: { ok: false } };
  }
}

// Flujo "Mermín - Sincronizar Drive". entorno.drive simula Drive: listar(folderId) y leer(sheetId, pestaña).
async function sincronizarDrive(entorno) {
  const { hoja, drive } = entorno;
  const reloj = () => (typeof entorno.ahora === 'function' ? entorno.ahora() : entorno.ahora) || new Date().toISOString();
  const config = leerConfig(hoja.leer(T.config));
  let r;
  if (!config.drive_folder_id) {
    r = { ok: false, errores: ['Falta conectar la carpeta de Drive (POST /config/drive).'], ahora: reloj() };
  } else {
    const fuente = elegirHojaFuente(drive.listar(config.drive_folder_id));
    const leer = pestana => (fuente ? drive.leer(fuente.id, pestana) : []);
    r = prepararSync({ hoja: fuente, productos: leer('PRODUCTOS'), clientes: leer('CLIENTES'), ventas: leer('VENTAS'), ahora: reloj() });
  }
  if (!r.ok) {
    hoja.agregar(T.errores, filaErrorSync(r));
    return r;
  }
  hoja.reemplazar(T.productos, r.productos);
  hoja.reemplazar(T.clientesFuente, r.clientes);
  hoja.reemplazar(T.ventas, r.ventas);
  for (const fila of r.config) hoja.guardar(T.config, 'clave', fila);
  return r;
}

// Flujo "ITS WOOD - Entrada WhatsApp": un webhook puede traer varios mensajes; se procesan uno a uno.
async function recibirWebhook(cuerpo, entorno) {
  const resultados = [];
  for (const evento of normalizarEntrada([{ json: cuerpo }])) {
    if (evento.tipo_evento === 'estado') {
      entorno.hoja.actualizar(T.eventos, 'mensaje_id', { mensaje_id: evento.mensaje_id, estado_entrega: evento.estado, detalle: evento.detalle });
      continue;
    }
    resultados.push(await procesarMensaje(evento, entorno));
  }
  return resultados;
}

// Flujo "ITS WOOD - Atención humana".
async function accionHumana(formulario, entorno) {
  const { hoja, enviar, ahora } = entorno;
  const filas = hoja.leer(T.conversaciones, 'wa_id', String(formulario['WhatsApp del cliente'] || '').replace(/\D/g, ''));
  const d = decidirAccionHumana({ formulario, filas, ahora: typeof ahora === 'function' ? ahora() : ahora });
  if (!d.ok) return d;
  hoja.actualizar(T.conversaciones, 'wa_id', { wa_id: d.wa_id, modo: d.modo, responsable: d.responsable, actualizado_en: d.actualizado_en });
  if (d.confirmar_solicitud) {
    const r = await confirmarOrden({ solicitud_id: d.confirmar_solicitud, simular: entorno.simularPlantillas }, entorno);
    return { ...d, ok: r.ok, texto_resultado: r.ok ? r.resumen : r.error };
  }
  if (!d.enviar) return d;
  const base = { fecha: d.actualizado_en, wa_id: d.wa_id, conversacion_id: d.conversacion_id, direccion: 'SALIDA_HUMANO', tipo: 'text', texto: d.enviar, media_id: '' };
  try {
    const r = await enviar({ to: d.wa_id, texto: d.enviar });
    hoja.agregar(T.eventos, { ...base, mensaje_id: r.messages[0].id, resultado: 'ENVIADO', detalle: d.responsable });
    return d;
  } catch (e) {
    hoja.agregar(T.eventos, { ...base, mensaje_id: `ERR-HUM-${Date.now()}`, resultado: 'ERROR_ENVIO', detalle: String(e.message).slice(0, 500) });
    return { ...d, ok: false, texto_resultado: `El modo cambió, pero el mensaje no se envió: ${e.message}` };
  }
}

module.exports = { procesarMensaje, recibirWebhook, accionHumana, confirmarOrden, llamarApi, sincronizarDrive };

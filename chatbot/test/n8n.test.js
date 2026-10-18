'use strict';

// Ejecuta el código de los nodos Code generados con un $ / $input simulados, como lo haría n8n.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { flujoProcesar, flujoEntrada, flujoHumano, flujoErrores } = require('../n8n/build');
const { leerCsv } = require('../sim/hoja_memoria');
const ev = require('../sim/eventos');

const CATALOGO = leerCsv(path.join(__dirname, '..', 'hoja', 'catalogo_bot.csv'));

function ejecutarCodigo(flujo, nombreNodo, datos, entrada) {
  const nodo = flujo.nodes.find(n => n.name === nombreNodo);
  const $ = nombre => {
    if (!(nombre in datos)) throw new Error(`nodo no simulado: ${nombre}`);
    const filas = datos[nombre];
    return { first: () => ({ json: filas[0] }), all: () => filas.map(json => ({ json })) };
  };
  const $input = { all: () => (entrada || []).map(json => ({ json })), first: () => ({ json: (entrada || [])[0] }) };
  return new Function('$', '$input', nodo.parameters.jsCode)($, $input).map(i => i.json);
}

test('nodo Normalizar evento', () => {
  const flujo = flujoEntrada();
  const salida = ejecutarCodigo(flujo, 'Normalizar evento', {}, [ev.mensaje('51987000001', 'Hola').entry[0].changes[0].value]);
  assert.equal(salida.length, 1);
  assert.equal(salida[0].texto, 'Hola');
});

test('nodos del subflujo: duplicado, motor, comparar modo y preparar envíos', () => {
  const flujo = flujoProcesar();
  const [mensaje] = ejecutarCodigo(flujoEntrada(), 'Normalizar evento', {}, [ev.mensaje('51987000001', 'Hola')]);
  const datos = { Entrada: [mensaje], 'Configuración': [{ phoneNumberId: 'PHONE_CFG' }] };

  assert.equal(ejecutarCodigo(flujo, 'Detectar duplicado', datos, [{}]).length, 1);
  assert.equal(ejecutarCodigo(flujo, 'Detectar duplicado', datos, [{ mensaje_id: mensaje.mensaje_id, resultado: 'PROCESADO' }]).length, 0);

  // Sheets sin filas devuelve un elemento vacío (alwaysOutputData); el catálogo viene como filas.
  datos['Leer conversación'] = [{}];
  datos['Leer catálogo'] = CATALOGO;
  datos['Leer inventario'] = [{ 'ITEM ': 'TABLA QUESERA ROMA ', 'UNIDADES ': 3 }];
  const [motor] = ejecutarCodigo(flujo, 'Motor conversacional', datos);
  assert.equal(motor.conversacion.modo, 'BOT');
  assert.match(motor.respuestas[0], /ITS WOOD/);

  datos['Motor conversacional'] = [motor];
  assert.equal(ejecutarCodigo(flujo, 'Comparar modo', datos, [{}])[0].cambio, false);
  const envios = ejecutarCodigo(flujo, 'Preparar envíos', datos, [{ ...motor.conversacion }]);
  assert.equal(envios[0].accion, 'enviar');
  assert.equal(envios[0].phone_number_id, 'PHONE_PRUEBA');
});

test('nodo Decidir acción del formulario', () => {
  const flujo = flujoHumano();
  const datos = { 'Formulario de atención': [{ 'WhatsApp del cliente': '51987000001', 'Acción': 'Tomar caso', 'Mensaje al cliente': '', 'Responsable': 'Carla' }] };
  const [d] = ejecutarCodigo(flujo, 'Decidir acción', datos, [{ wa_id: 51987000001, modo: 'PENDIENTE_HUMANO', ultima_entrada: new Date().toISOString() }]);
  assert.equal(d.ok, true);
  assert.equal(d.modo, 'HUMANO');
});

test('nodo Preparar registro de errores oculta credenciales', () => {
  const flujo = flujoErrores();
  const datos = { 'Error Trigger': [{ workflow: { name: 'X' }, execution: { id: 9, lastNodeExecuted: 'Enviar respuesta', mode: 'webhook', error: { message: 'Bad token: EAAGm0PX4ZCpsBAABCDEFGHIJKLMNOPQRSTUV access_token=abc123' } } }] };
  const [r] = ejecutarCodigo(flujo, 'Preparar registro', datos);
  assert.doesNotMatch(r.mensaje, /EAAGm0|abc123/);
  assert.equal(r.nodo, 'Enviar respuesta');
});

test('las escrituras usan cellFormat RAW y no tocan las columnas del equipo', () => {
  const flujo = flujoProcesar();
  const escrituras = flujo.nodes.filter(n => n.type === 'n8n-nodes-base.googleSheets' && n.parameters.operation !== 'read');
  for (const n of escrituras) assert.equal(n.parameters.options.cellFormat, n.name === 'Registrar en PAUTAS' ? 'USER_ENTERED' : 'RAW', n.name);
  const inventario = flujo.nodes.find(n => n.name === 'Leer inventario');
  assert.equal(inventario.parameters.options.dataLocationOnSheet.values.range, 'H3:I300');
  const guardar = flujo.nodes.find(n => n.name === 'Guardar conversación');
  assert.ok(!('responsable' in guardar.parameters.columns.value));
  assert.ok(!('notas' in guardar.parameters.columns.value));
});

test('BOT_CONVERSACIONES se escribe solo como texto: un número vacío no puede volverse 0', () => {
  const flujo = flujoProcesar();
  const guardar = flujo.nodes.find(n => n.name === 'Guardar conversación');
  assert.deepEqual(guardar.parameters.columns.schema.filter(c => c.type !== 'string').map(c => c.id), []);
  const solicitud = flujo.nodes.find(n => n.name === 'Registrar solicitud');
  assert.match(solicitud.parameters.columns.value.cantidad, /=== '' \? null :/);
});

test('nodos nuevos: API, confirmar orden y respuesta de proveedor', () => {
  const { flujoApi, flujoConfirmarOrden } = require('../n8n/build');
  const api = flujoApi();
  const [noValida] = ejecutarCodigo(api, 'Petición GET', {}, [{ params: { ruta: 'mensaje' }, query: {}, body: {} }]);
  assert.equal(noValida.ruta, 'error');
  assert.equal(noValida.status, 405);
  const [salud] = ejecutarCodigo(api, 'Petición GET', {}, [{ params: { ruta: 'salud' }, query: {} }]);
  assert.equal(salud.cuerpo.ok, true);
  const [msg] = ejecutarCodigo(api, 'Petición POST', {}, [{ params: { ruta: 'mensaje' }, query: {}, body: { wa_id: '51987000001', texto: 'Hola' } }]);
  assert.equal(msg.mensaje.origen, 'api');
  const [lista] = ejecutarCodigo(api, 'Formatear lista', { 'Petición GET': [{ ruta: 'solicitudes', filtros: { intencion: 'ALTA' }, limite: 10 }] },
    [{ row_number: 2, solicitud_id: 'A', intencion: 'ALTA' }, { row_number: 3, solicitud_id: 'B', intencion: 'BAJA' }]);
  assert.deepEqual(lista.cuerpo.datos, [{ solicitud_id: 'A', intencion: 'ALTA' }]);

  const orden = flujoConfirmarOrden();
  const envios = [{ cotizacion_id: 'C1', proveedor_nombre: 'X', estado: 'ENVIADA' }, { cotizacion_id: 'C2', proveedor_nombre: 'Y', estado: 'ENVIADA' }];
  const filas = ejecutarCodigo(orden, 'Filas enviadas', { 'Separar envíos': envios }, [{ messages: [{ id: 'wamid.1' }] }, { error: { message: 'plantilla no aprobada' } }]);
  assert.equal(filas[0].mensaje_id, 'wamid.1');
  assert.equal(filas[1].estado, 'ERROR_ENVIO');
  assert.match(filas[1].detalle, /plantilla no aprobada/);

  const procesar = flujoProcesar();
  const [prov] = ejecutarCodigo(procesar, '¿Es proveedor?', { Entrada: [{ wa_id: '51911111111' }] }, [{ proveedor_id: 'P01', nombre: 'Maderas', whatsapp: '911111111', productos: 'TODOS' }]);
  assert.equal(prov.es_proveedor, true);
});

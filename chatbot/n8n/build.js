'use strict';

// Genera las exportaciones de n8n en n8n/flujos/ a partir de src/.
// Los nodos Code incrustan los mismos archivos que prueban los tests, así la lógica tiene una sola fuente.
// Las credenciales no se incluyen: se eligen en n8n después de importar.
// Uso: node n8n/build.js
//   n8n/flujos/        marcadores PEGAR_... (se pueden compartir)
//   n8n/flujos_local/  valores de config.local.json, si existe (no se comparten: llevan el ID de la hoja)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const motor = require('../src/motor');
const { PESTANAS: T, RANGO_INVENTARIO, COLUMNAS_PAUTAS } = require('../src/hojas');
const ordenes = require('../src/ordenes');

const RAIZ = path.join(__dirname, '..');
const SALIDA = path.join(__dirname, 'flujos');
const fuente = archivo => fs.readFileSync(path.join(RAIZ, 'src', archivo), 'utf8').trim();

function cargarConfig(conLocal) {
  const config = {
    sheetId: 'PEGAR_ID_DE_LA_HOJA', phoneNumberId: 'PEGAR_PHONE_NUMBER_ID', waAvisos: '',
    // IDs de los flujos en n8n: con ellos, reimportar actualiza los flujos en vez de duplicarlos.
    idProcesar: '', idEntrada: '', idHumano: '', idErrores: '', idPrueba: '', idConfirmar: '', idApi: '',
    // Credenciales ya creadas en n8n (solo id y nombre; los secretos quedan en n8n).
    credGoogleId: '', credGoogleNombre: '', credPruebaId: '', credPruebaNombre: '', credApiId: '', credApiNombre: '',
  };
  const ruta = path.join(RAIZ, 'config.local.json');
  if (conLocal && fs.existsSync(ruta)) Object.assign(config, JSON.parse(fs.readFileSync(ruta, 'utf8')));
  return config;
}
let CONFIG = cargarConfig(false);

// ---------- fábrica de nodos ----------

function idEstable(...partes) {
  const h = crypto.createHash('sha1').update(partes.join('/')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function crearFlujo(nombre, id) {
  const nodos = [];
  const conexiones = {};
  const f = {
    nombre,
    nodo(nombreNodo, type, typeVersion, position, parameters, extra = {}) {
      nodos.push({ parameters, id: idEstable(nombre, nombreNodo), name: nombreNodo, type, typeVersion, position, ...extra });
      return nombreNodo;
    },
    // conectar(origen, destino, salida): salida 0 = principal/verdadero, 1 = falso/error.
    conectar(origen, destino, salida = 0) {
      conexiones[origen] = conexiones[origen] || { main: [] };
      while (conexiones[origen].main.length <= salida) conexiones[origen].main.push([]);
      conexiones[origen].main[salida].push({ node: destino, type: 'main', index: 0 });
    },
    cadena(...nombres) { for (let i = 0; i < nombres.length - 1; i++) f.conectar(nombres[i], nombres[i + 1]); },
    exportar(settings) {
      return { ...(id ? { id } : {}), name: nombre, nodes: nodos, connections: conexiones, active: false, settings, pinData: {}, meta: { templateCredsSetupCompleted: false }, tags: [] };
    },
    nodos,
    conexiones,
  };
  return f;
}

const CFG = "$('Configuración').first().json";
// Con credGoogleId, los nodos de Sheets usan la cuenta de servicio y quedan con la credencial asignada.
function credencialesSheets() {
  if (!CONFIG.credGoogleId) return {};
  return { credentials: { googleApi: { id: CONFIG.credGoogleId, name: CONFIG.credGoogleNombre } } };
}
function autenticacionSheets() { return CONFIG.credGoogleId ? { authentication: 'serviceAccount' } : {}; }
const doc = () => ({ __rl: true, value: `={{ ${CFG}.sheetId }}`, mode: 'id' });
const pestaña = nombre => ({ __rl: true, value: nombre, mode: 'name' });
const expr = codigo => `={{ ${codigo} }}`;

function configuracion(f, pos, campos) {
  return f.nodo('Configuración', 'n8n-nodes-base.set', 3.4, pos, {
    mode: 'manual',
    assignments: {
      assignments: campos.map(c => ({ id: idEstable(f.nombre, 'cfg', c), name: c, value: CONFIG[c], type: 'string' })),
    },
    includeOtherFields: true,
    options: {},
  }, { notes: 'Valores del entorno. Edítalos aquí después de importar (o en config.local.json y vuelve a generar).' });
}

function sheetsLeer(f, nombre, pos, tabla, filtro, rango) {
  const options = rango ? { dataLocationOnSheet: { values: { rangeDefinition: 'specifyRangeA1', range: rango } } } : {};
  const parameters = { ...autenticacionSheets(), resource: 'sheet', operation: 'read', documentId: doc(), sheetName: pestaña(tabla), options };
  if (filtro) parameters.filtersUI = { values: [{ lookupColumn: filtro[0], lookupValue: filtro[1] }] };
  return f.nodo(nombre, 'n8n-nodes-base.googleSheets', 4.5, pos, parameters, { alwaysOutputData: true, executeOnce: true, ...credencialesSheets() });
}

// valores: { columna: expresión }. clave: columna de coincidencia para update/appendOrUpdate.
// Columnas que se escriben como número. Solo estas: en n8n una columna de tipo number convierte "" en 0,
// y en BOT_CONVERSACIONES un 0 haría creer al bot que la cantidad ya se respondió.
const NUMERICAS = {
  [T.solicitudes]: new Set(['precio_unitario_ref', 'cantidad', 'total_referencial']),
  [T.pautas]: new Set(['CANTIDAD']),
};
const esNumerica = (tabla, c) => !!(NUMERICAS[tabla] && NUMERICAS[tabla].has(c));

function sheetsEscribir(f, nombre, pos, operation, tabla, valores, clave, extra = {}, cellFormat = 'RAW') {
  const columnas = Object.keys(valores);
  return f.nodo(nombre, 'n8n-nodes-base.googleSheets', 4.5, pos, {
    ...autenticacionSheets(),
    resource: 'sheet',
    operation,
    documentId: doc(),
    sheetName: pestaña(tabla),
    columns: {
      mappingMode: 'defineBelow',
      value: valores,
      matchingColumns: clave ? [clave] : [],
      schema: columnas.map(c => ({
        id: c, displayName: c, required: false, defaultMatch: false, display: true,
        type: esNumerica(tabla, c) ? 'number' : 'string', canBeUsedToMatch: true, removed: false,
      })),
    },
    // RAW: el texto del cliente se guarda literal, aunque empiece por "=", "+" o "@".
    // PAUTAS usa USER_ENTERED (fechas como fechas) y el motor antepone un apóstrofo a los textos.
    options: { cellFormat },
  }, { ...credencialesSheets(), ...extra });
}

// En columnas numéricas un valor vacío va como null (celda vacía), nunca como "" (que n8n convierte en 0).
function mapa(columnas, origen, tabla) {
  return Object.fromEntries(columnas.map(c => {
    const v = `${origen}[${JSON.stringify(c)}]`;
    return [c, expr(esNumerica(tabla, c) ? `${v} === '' ? null : ${v}` : v)];
  }));
}

function codigo(f, nombre, pos, archivos, pegamento, extra = {}) {
  const js = [...archivos.map(fuente), '', '// ---- n8n ----', pegamento.trim()].join('\n');
  return f.nodo(nombre, 'n8n-nodes-base.code', 2, pos, { jsCode: js }, extra);
}

function si(f, nombre, pos, condicion) {
  return f.nodo(nombre, 'n8n-nodes-base.if', 2, pos, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{ id: idEstable(f.nombre, nombre, 'cond'), leftValue: expr(condicion), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  });
}

// Switch por el valor de una expresión; cada ruta es una salida con nombre, en el orden dado.
function switchRutas(f, nombre, pos, valor, rutas) {
  return f.nodo(nombre, 'n8n-nodes-base.switch', 3.2, pos, {
    rules: {
      values: rutas.map(r => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: idEstable(f.nombre, nombre, r), leftValue: expr(valor), rightValue: r, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: r,
      })),
    },
    options: {},
  });
}

function ejecutarSubflujo(f, nombre, pos, idFlujo, nota) {
  return f.nodo(nombre, 'n8n-nodes-base.executeWorkflow', 1.2, pos, {
    source: 'database',
    workflowId: { __rl: true, value: idFlujo, mode: 'id' },
    mode: 'each',
    options: { waitForSubWorkflow: true },
  }, { alwaysOutputData: true, ...(nota ? { notes: nota } : {}) });
}

function responderJson(f, nombre, pos) {
  return f.nodo(nombre, 'n8n-nodes-base.respondToWebhook', 1.1, pos, {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify($json.cuerpo) }}',
    options: { responseCode: '={{ $json.status }}' },
  });
}

function whatsappEnviar(f, nombre, pos, numeroOrigen, destino, texto, extra = {}) {
  return f.nodo(nombre, 'n8n-nodes-base.whatsApp', 1, pos, {
    operation: 'send',
    phoneNumberId: expr(numeroOrigen),
    recipientPhoneNumber: expr(destino),
    textBody: expr(texto),
    additionalFields: {},
  }, extra);
}

const AJUSTES = { executionOrder: 'v1', timezone: 'America/Lima', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'none', callerPolicy: 'workflowsFromSameOwner' };
const errorDe = "typeof $json.error === 'object' ? JSON.stringify($json.error).slice(0, 500) : String($json.error || $json.message || '').slice(0, 500)";

// ---------- 1. Subflujo: procesar un mensaje ----------

function flujoProcesar() {
  const f = crearFlujo('ITS WOOD - Procesar mensaje', CONFIG.idProcesar);
  const ENT = "$('Entrada').first().json";
  const MOT = "$('Motor conversacional').first().json";
  const x = i => 0 + i * 220;

  f.nodo('Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [x(0), 300], { inputSource: 'passthrough' });
  configuracion(f, [x(1), 300], ['sheetId', 'phoneNumberId', 'waAvisos']);
  sheetsLeer(f, 'Buscar evento', [x(2), 300], T.eventos, ['mensaje_id', expr(`${ENT}.mensaje_id`)]);
  codigo(f, 'Detectar duplicado', [x(3), 300], ['pasos.js'], `
const mensaje = $('Entrada').first().json;
const filas = $input.all().map(i => i.json);
return esDuplicado(mensaje, filas) ? [] : [{ json: mensaje }];`);
  sheetsEscribir(f, 'Registrar recepción', [x(4), 300], 'appendOrUpdate', T.eventos, {
    mensaje_id: expr(`${ENT}.mensaje_id`), fecha: expr(`${ENT}.fecha_iso`), wa_id: expr(`${ENT}.wa_id`), conversacion_id: '',
    direccion: 'ENTRADA', tipo: expr(`${ENT}.tipo`), texto: expr(`${ENT}.texto`), media_id: expr(`${ENT}.media_id`),
    resultado: 'RECIBIDO', detalle: '',
  }, 'mensaje_id');
  // Un proveedor que responde a una solicitud de cotización no pasa por el bot de clientes.
  const PROV = "$('¿Es proveedor?').first().json";
  const RESP = "$('Respuesta de proveedor').first().json";
  sheetsLeer(f, 'Leer proveedores', [x(4), 520], T.proveedores);
  codigo(f, '¿Es proveedor?', [x(5), 520], ['ordenes.js'], `
const mensaje = $('Entrada').first().json;
return [{ json: identificarProveedor(mensaje, $input.all().map(i => i.json)) }];`);
  si(f, 'Proveedor', [x(6), 520], '$json.es_proveedor');
  sheetsLeer(f, 'Leer cotizaciones del proveedor', [x(7), 700], T.cotizaciones, ['proveedor_id', expr(`${PROV}.proveedor_id`)]);
  codigo(f, 'Respuesta de proveedor', [x(8), 700], ['ordenes.js'], `
const mensaje = $('Entrada').first().json;
const proveedor = $('¿Es proveedor?').first().json;
const cotizaciones = $input.all().map(i => i.json);
return [{ json: registrarRespuestaProveedor({ mensaje, proveedor, cotizaciones, ahora: new Date().toISOString() }) }];`);
  si(f, '¿Cotización abierta?', [x(9), 700], '!!$json.actualizar');
  sheetsEscribir(f, 'Guardar respuesta en la cotización', [x(10), 620], 'update', T.cotizaciones, {
    cotizacion_id: expr(`${RESP}.actualizar.cotizacion_id`), estado: expr(`${RESP}.actualizar.estado`),
    respuesta: expr(`${RESP}.actualizar.respuesta`), respondido_en: expr(`${RESP}.actualizar.respondido_en`),
  }, 'cotizacion_id');
  sheetsEscribir(f, 'Marcar respuesta de proveedor', [x(11), 700], 'appendOrUpdate', T.eventos, {
    mensaje_id: expr(`${ENT}.mensaje_id`), resultado: expr(`${RESP}.resultado`), detalle: expr(`${PROV}.proveedor_id`),
  }, 'mensaje_id');

  sheetsLeer(f, 'Leer conversación', [x(5), 300], T.conversaciones, ['wa_id', expr(`${ENT}.wa_id`)]);
  sheetsLeer(f, 'Leer catálogo', [x(6), 300], T.catalogo);
  sheetsLeer(f, 'Leer inventario', [x(6), 500], T.inventario, null, RANGO_INVENTARIO);
  codigo(f, 'Motor conversacional', [x(7), 300], ['motor.js'], `
const mensaje = $('Entrada').first().json;
const conversacion = $('Leer conversación').all().map(i => i.json).find(fila => fila && String(fila.wa_id ?? '') === String(mensaje.wa_id)) || null;
const catalogo = $('Leer catálogo').all().map(i => i.json);
const inventario = $('Leer inventario').all().map(i => i.json);
return [{ json: procesar({ mensaje, conversacion, catalogo, inventario, ahora: new Date().toISOString() }) }];`);
  sheetsLeer(f, 'Releer conversación', [x(8), 300], T.conversaciones, ['wa_id', expr(`${ENT}.wa_id`)]);
  codigo(f, 'Comparar modo', [x(9), 300], ['pasos.js'], `
const motor = $('Motor conversacional').first().json;
return [{ json: verificarCambioModo(motor, $input.all().map(i => i.json)) }];`);
  si(f, '¿Cambió el modo?', [x(10), 300], '$json.cambio');

  // Rama: una persona cambió el modo mientras se procesaba.
  sheetsEscribir(f, 'Actualizar última entrada', [x(11), 120], 'update', T.conversaciones, {
    wa_id: expr(`${MOT}.wa_id`), ultima_entrada: expr(`${MOT}.conversacion.ultima_entrada`),
  }, 'wa_id');
  sheetsEscribir(f, 'Marcar entrada omitida', [x(12), 120], 'appendOrUpdate', T.eventos, {
    mensaje_id: expr(`${ENT}.mensaje_id`), resultado: 'OMITIDO_CAMBIO_MODO', detalle: expr("'modo cambió a ' + $('Comparar modo').first().json.modo_actual"),
  }, 'mensaje_id');

  // Rama normal.
  sheetsEscribir(f, 'Guardar conversación', [x(11), 400], 'appendOrUpdate', T.conversaciones,
    mapa(motor.COLUMNAS_CONVERSACION, `${MOT}.conversacion`), 'wa_id');
  si(f, '¿Hay solicitud?', [x(12), 400], `!!${MOT}.solicitud`);
  sheetsEscribir(f, 'Registrar solicitud', [x(13), 300], 'append', T.solicitudes, mapa(motor.COLUMNAS_SOLICITUD, `${MOT}.solicitud`, T.solicitudes));
  // Filtro por intención de compra: el motor solo arma el prospecto si la intención es MEDIA o ALTA.
  si(f, '¿Hay prospecto?', [x(14), 300], `!!${MOT}.pauta`);
  sheetsEscribir(f, 'Registrar en PAUTAS', [x(14), 140], 'append', T.pautas, mapa(COLUMNAS_PAUTAS, `${MOT}.pauta`, T.pautas), null,
    { notes: 'Prospecto en la pestaña del equipo. USER_ENTERED para que las fechas queden como fechas.' }, 'USER_ENTERED');
  sheetsEscribir(f, 'Guardar cliente', [x(15), 300], 'appendOrUpdate', T.clientes, mapa(motor.COLUMNAS_CLIENTE, `${MOT}.cliente`), 'wa_id');
  sheetsEscribir(f, 'Marcar procesado', [x(16), 400], 'appendOrUpdate', T.eventos, {
    mensaje_id: expr(`${ENT}.mensaje_id`), conversacion_id: expr(`${MOT}.conversacion.conversacion_id`), resultado: expr(`${MOT}.resultado_evento`),
  }, 'mensaje_id');
  si(f, '¿Avisar al equipo?', [x(17), 400], `!!${MOT}.aviso && !!${CFG}.waAvisos`);
  whatsappEnviar(f, 'Avisar al equipo', [x(18), 300], `${CFG}.phoneNumberId`, `${CFG}.waAvisos`, `${MOT}.aviso`, {
    onError: 'continueRegularOutput',
    notes: 'Aviso interno provisional. Requiere que el número de avisos haya escrito al número comercial en las últimas 24 h o una plantilla aprobada.',
  });
  sheetsLeer(f, 'Verificar antes de enviar', [x(19), 400], T.conversaciones, ['wa_id', expr(`${ENT}.wa_id`)]);
  codigo(f, 'Preparar envíos', [x(20), 400], ['pasos.js'], `
const motor = $('Motor conversacional').first().json;
const mensaje = $('Entrada').first().json;
const filas = $input.all().map(i => i.json);
return prepararEnvios(motor, mensaje, filas, $('Configuración').first().json.phoneNumberId).map(json => ({ json }));`);
  si(f, '¿Enviar por WhatsApp?', [x(21), 400], "$json.accion === 'enviar'");
  whatsappEnviar(f, 'Enviar respuesta', [x(22), 300], '$json.phone_number_id', '$json.to', '$json.texto', { onError: 'continueErrorOutput' });

  const salida = (resultado, id, detalle) => ({
    mensaje_id: expr(id), fecha: expr('$now.toISO()'), wa_id: expr("$('Preparar envíos').item.json.wa_id"),
    conversacion_id: expr("$('Preparar envíos').item.json.conversacion_id"), direccion: 'SALIDA', tipo: 'text',
    texto: expr("$('Preparar envíos').item.json.texto"), media_id: '', resultado, detalle: expr(detalle),
  });
  sheetsEscribir(f, 'Registrar salida', [x(23), 200], 'append', T.eventos,
    salida('ENVIADO', "$json.messages[0].id", "'respuesta a ' + $('Preparar envíos').item.json.en_respuesta_a"));
  sheetsEscribir(f, 'Registrar error de envío', [x(23), 400], 'append', T.eventos,
    salida('ERROR_ENVIO', "'ERR-' + $('Preparar envíos').item.json.en_respuesta_a + '-' + $('Preparar envíos').item.json.orden", errorDe));
  sheetsEscribir(f, 'Registrar salida sin envío', [x(22), 560], 'append', T.eventos, {
    mensaje_id: expr('$json.mensaje_id'), fecha: expr('$now.toISO()'), wa_id: expr('$json.wa_id'), conversacion_id: expr('$json.conversacion_id'),
    direccion: 'SALIDA', tipo: 'text', texto: expr('$json.texto'), media_id: '', resultado: expr('$json.resultado'), detalle: expr('$json.detalle'),
  });

  f.cadena('Entrada', 'Configuración', 'Buscar evento', 'Detectar duplicado', 'Registrar recepción', 'Leer proveedores',
    '¿Es proveedor?', 'Proveedor');
  f.conectar('Proveedor', 'Leer cotizaciones del proveedor', 0);
  f.cadena('Leer cotizaciones del proveedor', 'Respuesta de proveedor', '¿Cotización abierta?');
  f.conectar('¿Cotización abierta?', 'Guardar respuesta en la cotización', 0);
  f.conectar('Guardar respuesta en la cotización', 'Marcar respuesta de proveedor');
  f.conectar('¿Cotización abierta?', 'Marcar respuesta de proveedor', 1);
  f.conectar('Proveedor', 'Leer conversación', 1);
  f.cadena('Leer conversación', 'Leer catálogo', 'Leer inventario', 'Motor conversacional', 'Releer conversación', 'Comparar modo', '¿Cambió el modo?');
  f.conectar('¿Cambió el modo?', 'Actualizar última entrada', 0);
  f.conectar('Actualizar última entrada', 'Marcar entrada omitida');
  f.conectar('¿Cambió el modo?', 'Guardar conversación', 1);
  f.conectar('Guardar conversación', '¿Hay solicitud?');
  f.conectar('¿Hay solicitud?', 'Registrar solicitud', 0);
  f.conectar('Registrar solicitud', '¿Hay prospecto?');
  f.conectar('¿Hay prospecto?', 'Registrar en PAUTAS', 0);
  f.conectar('¿Hay prospecto?', 'Guardar cliente', 1);
  f.conectar('Registrar en PAUTAS', 'Guardar cliente');
  f.conectar('Guardar cliente', 'Marcar procesado');
  f.conectar('¿Hay solicitud?', 'Marcar procesado', 1);
  f.conectar('Marcar procesado', '¿Avisar al equipo?');
  f.conectar('¿Avisar al equipo?', 'Avisar al equipo', 0);
  f.conectar('Avisar al equipo', 'Verificar antes de enviar');
  f.conectar('¿Avisar al equipo?', 'Verificar antes de enviar', 1);
  f.cadena('Verificar antes de enviar', 'Preparar envíos', '¿Enviar por WhatsApp?');
  f.conectar('¿Enviar por WhatsApp?', 'Enviar respuesta', 0);
  f.conectar('¿Enviar por WhatsApp?', 'Registrar salida sin envío', 1);
  f.conectar('Enviar respuesta', 'Registrar salida', 0);
  f.conectar('Enviar respuesta', 'Registrar error de envío', 1);
  return f.exportar({ ...AJUSTES, errorWorkflow: CONFIG.idErrores });
}

// ---------- 2. Entrada de WhatsApp ----------

function flujoEntrada() {
  const f = crearFlujo('ITS WOOD - Entrada WhatsApp', CONFIG.idEntrada);
  f.nodo('WhatsApp Trigger', 'n8n-nodes-base.whatsAppTrigger', 1, [0, 200], { updates: ['messages'] }, { webhookId: idEstable(f.nombre, 'wa-trigger') });
  f.nodo('Webhook de simulación', 'n8n-nodes-base.webhook', 2, [0, 420], {
    httpMethod: 'POST', path: 'itswood-simulacion', authentication: 'headerAuth', responseMode: 'onReceived', options: {},
  }, {
    webhookId: idEstable(f.nombre, 'sim-webhook'),
    notes: 'Solo para pruebas: recibe el mismo JSON que envía Meta y registra las respuestas como SIMULADO. Desactívalo en operación.',
  });
  codigo(f, 'Normalizar evento', [220, 300], ['normalizar.js'], 'return normalizarEntrada($input.all()).map(json => ({ json }));');
  configuracion(f, [440, 300], ['sheetId']);
  si(f, '¿Es estado de entrega?', [660, 300], "$json.tipo_evento === 'estado'");
  sheetsEscribir(f, 'Actualizar entrega', [880, 200], 'update', T.eventos, {
    mensaje_id: expr('$json.mensaje_id'), estado_entrega: expr('$json.estado'), detalle: expr('$json.detalle'),
  }, 'mensaje_id', { onError: 'continueRegularOutput', notes: 'Si el mensaje no está en Eventos (por ejemplo, un aviso interno), no hay fila que actualizar.' });
  f.nodo('Procesar mensaje', 'n8n-nodes-base.executeWorkflow', 1.2, [880, 400], {
    source: 'database',
    workflowId: { __rl: true, value: CONFIG.idProcesar, mode: 'id' },
    mode: 'each',
    options: { waitForSubWorkflow: true },
  }, { notes: 'Elige aquí el flujo "ITS WOOD - Procesar mensaje" después de importarlo. Procesa los mensajes de uno en uno.' });
  f.conectar('WhatsApp Trigger', 'Normalizar evento');
  f.conectar('Webhook de simulación', 'Normalizar evento');
  f.cadena('Normalizar evento', 'Configuración', '¿Es estado de entrega?');
  f.conectar('¿Es estado de entrega?', 'Actualizar entrega', 0);
  f.conectar('¿Es estado de entrega?', 'Procesar mensaje', 1);
  return f.exportar({ ...AJUSTES, errorWorkflow: CONFIG.idErrores });
}

// ---------- 5. Prueba local (sin WhatsApp) ----------
// Webhook protegido que recibe el mismo JSON que Meta y lo pasa al subflujo. Las respuestas se registran como
// SIMULADO en BOT_EVENTOS y se devuelven en la respuesta HTTP. Solo para pruebas: no publicar en operación.

function flujoPrueba() {
  const f = crearFlujo('ITS WOOD - Prueba local', CONFIG.idPrueba);
  f.nodo('Webhook de prueba', 'n8n-nodes-base.webhook', 2, [0, 300], {
    httpMethod: 'POST', path: 'itswood-prueba', authentication: 'headerAuth', responseMode: 'lastNode',
    responseData: 'allEntries', options: {},
  }, {
    webhookId: idEstable(f.nombre, 'webhook'),
    ...(CONFIG.credPruebaId ? { credentials: { httpHeaderAuth: { id: CONFIG.credPruebaId, name: CONFIG.credPruebaNombre } } } : {}),
  });
  codigo(f, 'Normalizar evento', [220, 300], ['normalizar.js'], 'return normalizarEntrada($input.all()).map(json => ({ json }));');
  f.nodo('Procesar mensaje', 'n8n-nodes-base.executeWorkflow', 1.2, [440, 300], {
    source: 'database',
    workflowId: { __rl: true, value: CONFIG.idProcesar, mode: 'id' },
    mode: 'each',
    options: { waitForSubWorkflow: true },
  });
  f.cadena('Webhook de prueba', 'Normalizar evento', 'Procesar mensaje');
  return f.exportar({ ...AJUSTES, saveDataSuccessExecution: 'all', errorWorkflow: CONFIG.idErrores });
}

// ---------- 6. Subflujo: confirmar orden y pedir cotización a proveedores ----------
// Entrada: { solicitud_id, simular, responsable }. Salida: { ok, status, resumen, error, cotizaciones }.
// Solo una rama llega a "Resultado" en cada ejecución, así que ese nodo corre una vez.

function flujoConfirmarOrden() {
  const f = crearFlujo('ITS WOOD - Confirmar orden', CONFIG.idConfirmar);
  const ENT = "$('Entrada').first().json";
  const PREP = "$('Preparar cotizaciones').first().json";
  const x = i => i * 220;
  f.nodo('Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [x(0), 300], { inputSource: 'passthrough' });
  configuracion(f, [x(1), 300], ['sheetId', 'phoneNumberId']);
  sheetsLeer(f, 'Leer solicitud', [x(2), 300], T.solicitudes, ['solicitud_id', expr(`${ENT}.solicitud_id`)]);
  sheetsLeer(f, 'Leer proveedores', [x(3), 300], T.proveedores);
  sheetsLeer(f, 'Leer cotizaciones de la solicitud', [x(4), 300], T.cotizaciones, ['solicitud_id', expr(`${ENT}.solicitud_id`)]);
  sheetsLeer(f, 'Leer catálogo', [x(5), 300], T.catalogo);
  codigo(f, 'Preparar cotizaciones', [x(6), 300], ['ordenes.js'], `
const entrada = $('Entrada').first().json;
const solicitud = $('Leer solicitud').all().map(i => i.json).find(s => String(s.solicitud_id ?? '') === String(entrada.solicitud_id)) || null;
return [{ json: prepararCotizaciones({
  solicitud,
  proveedores: $('Leer proveedores').all().map(i => i.json),
  cotizaciones: $('Leer cotizaciones de la solicitud').all().map(i => i.json),
  catalogo: $('Leer catálogo').all().map(i => i.json),
  ahora: new Date().toISOString(),
  simular: entrada.simular === true,
  phoneNumberId: $('Configuración').first().json.phoneNumberId,
}) }];`);
  si(f, '¿Orden válida?', [x(7), 300], '$json.ok');
  sheetsEscribir(f, 'Marcar orden confirmada', [x(8), 200], 'update', T.solicitudes, {
    solicitud_id: expr(`${PREP}.actualizar_solicitud.solicitud_id`), estado: expr(`${PREP}.actualizar_solicitud.estado`),
  }, 'solicitud_id');
  si(f, '¿Hay proveedores por contactar?', [x(9), 200], `${PREP}.envios.length > 0`);
  codigo(f, 'Separar envíos', [x(10), 100], [], "return $('Preparar cotizaciones').first().json.envios.map(json => ({ json }));");
  si(f, '¿Simular?', [x(11), 100], `${ENT}.simular === true`);
  const columnas = JSON.stringify(ordenes.COLUMNAS_COTIZACION);
  codigo(f, 'Filas simuladas', [x(12), 0], [], `
const columnas = ${columnas};
return $input.all().map(({ json: e }) => ({ json: { ...Object.fromEntries(columnas.map(c => [c, e[c] ?? ''])), detalle: 'simulado: no se envió por WhatsApp' } }));`);
  f.nodo('Enviar plantilla', 'n8n-nodes-base.whatsApp', 1, [x(12), 200], {
    resource: 'message',
    operation: 'sendTemplate',
    phoneNumberId: expr('$json.phone_number_id'),
    recipientPhoneNumber: expr('$json.wa_proveedor'),
    template: expr('$json.plantilla'),
    components: {
      component: [{
        type: 'body',
        bodyParameters: { parameter: [0, 1, 2, 3, 4, 5].map(i => ({ type: 'text', text: expr(`$json.parametros[${i}]`) })) },
      }],
    },
  }, {
    onError: 'continueRegularOutput',
    notes: 'Plantilla itswood_solicitud_cotizacion (es), aprobada en Meta. Texto propuesto en docs/proveedores.md.',
  });
  codigo(f, 'Filas enviadas', [x(13), 200], [], `
const columnas = ${columnas};
const envios = $('Separar envíos').all();
return $input.all().map(({ json: r }, i) => {
  const e = envios[i].json;
  const fila = Object.fromEntries(columnas.map(c => [c, e[c] ?? '']));
  if (r && r.messages && r.messages[0]) return { json: { ...fila, mensaje_id: r.messages[0].id } };
  const err = r && r.error ? (typeof r.error === 'object' ? JSON.stringify(r.error) : String(r.error)) : 'sin respuesta de WhatsApp';
  return { json: { ...fila, estado: 'ERROR_ENVIO', detalle: err.slice(0, 500) } };
});`);
  const mapaFila = mapa(ordenes.COLUMNAS_COTIZACION, '$json');
  sheetsEscribir(f, 'Registrar cotizaciones simuladas', [x(13), 0], 'append', T.cotizaciones, mapaFila);
  sheetsEscribir(f, 'Registrar cotizaciones', [x(14), 200], 'append', T.cotizaciones, mapaFila);
  codigo(f, 'Resultado', [x(15), 300], [], `
const prep = $('Preparar cotizaciones').first().json;
const filas = $input.all().map(i => i.json).filter(r => r && r.cotizacion_id);
return [{ json: {
  ok: prep.ok, status: prep.status, resumen: prep.resumen || '', error: prep.error || '',
  cotizaciones: filas.map(r => ({ proveedor: r.proveedor_nombre, estado: r.estado })),
} }];`);

  f.cadena('Entrada', 'Configuración', 'Leer solicitud', 'Leer proveedores', 'Leer cotizaciones de la solicitud', 'Leer catálogo',
    'Preparar cotizaciones', '¿Orden válida?');
  f.conectar('¿Orden válida?', 'Marcar orden confirmada', 0);
  f.conectar('¿Orden válida?', 'Resultado', 1);
  f.conectar('Marcar orden confirmada', '¿Hay proveedores por contactar?');
  f.conectar('¿Hay proveedores por contactar?', 'Separar envíos', 0);
  f.conectar('¿Hay proveedores por contactar?', 'Resultado', 1);
  f.conectar('Separar envíos', '¿Simular?');
  f.conectar('¿Simular?', 'Filas simuladas', 0);
  f.conectar('¿Simular?', 'Enviar plantilla', 1);
  f.cadena('Filas simuladas', 'Registrar cotizaciones simuladas', 'Resultado');
  f.cadena('Enviar plantilla', 'Filas enviadas', 'Registrar cotizaciones', 'Resultado');
  return f.exportar({ ...AJUSTES, errorWorkflow: CONFIG.idErrores });
}

// ---------- 7. API para otras plataformas ----------
// GET|POST /webhook/itswood/api/<ruta> con la cabecera X-Api-Key. Rutas y formatos en docs/api.md.

function flujoApi() {
  const f = crearFlujo('ITS WOOD - API', CONFIG.idApi);
  const GET = "$('Petición GET').first().json";
  f.nodo('API', 'n8n-nodes-base.webhook', 2, [0, 300], {
    multipleMethods: true,
    httpMethod: ['GET', 'POST'],
    // Con un parámetro en la ruta, n8n publica el webhook en /webhook/<webhookId>/<path>:
    // webhookId "itswood" + path "api/:ruta" deja la URL en /webhook/itswood/api/<ruta>.
    path: 'api/:ruta',
    authentication: 'headerAuth',
    responseMode: 'responseNode',
    options: {},
  }, {
    webhookId: 'itswood',
    ...(CONFIG.credApiId ? { credentials: { httpHeaderAuth: { id: CONFIG.credApiId, name: CONFIG.credApiNombre } } } : {}),
  });
  const peticion = metodo => `
const w = $input.first().json;
const v = validarPeticion({ metodo: '${metodo}', ruta: (w.params || {}).ruta, query: w.query, body: w.body });
if (!v.ok) return [{ json: { ruta: 'error', status: v.status, cuerpo: { ok: false, error: v.error } } }];
if (v.ruta === 'salud') return [{ json: { ruta: 'salud', status: 200, cuerpo: { ok: true, servicio: 'itswood-bot' } } }];
return [{ json: v }];`;
  codigo(f, 'Petición GET', [220, 200], ['api.js'], peticion('GET'));
  codigo(f, 'Petición POST', [220, 420], ['api.js'], peticion('POST'));
  configuracion(f, [440, 300], ['sheetId']);
  const rutas = ['error', 'salud', 'mensaje', 'conversacion', 'solicitudes', 'proveedores', 'cotizaciones', 'confirmar-orden'];
  switchRutas(f, 'Enrutar', [660, 300], '$json.ruta', rutas);

  // mensaje: el bot responde por HTTP (origen "api"), sin enviar nada por WhatsApp.
  codigo(f, 'Mensaje para el bot', [880, 100], [], 'return [{ json: $input.first().json.mensaje }];');
  ejecutarSubflujo(f, 'Procesar mensaje', [1100, 100], CONFIG.idProcesar, 'Subflujo ITS WOOD - Procesar mensaje.');
  codigo(f, 'Respuesta del bot', [1320, 100], ['api.js'], `
const mensaje = $('Mensaje para el bot').first().json;
return [{ json: respuestaMensaje(mensaje, $input.all().map(i => i.json)) }];`);

  // Consultas de lectura: solo una rama corre por petición, así que "Formatear lista" corre una vez.
  sheetsLeer(f, 'Leer conversación', [880, 260], T.conversaciones, ['wa_id', expr(`${GET}.filtros.wa_id`)]);
  sheetsLeer(f, 'Leer solicitudes', [880, 380], T.solicitudes);
  sheetsLeer(f, 'Leer proveedores', [880, 500], T.proveedores);
  sheetsLeer(f, 'Leer cotizaciones', [880, 620], T.cotizaciones);
  codigo(f, 'Formatear lista', [1100, 440], ['api.js'], `
const p = $('Petición GET').first().json;
const filas = $input.all().map(i => i.json);
const r = p.ruta === 'conversacion' ? respuestaConversacion(filas, p.filtros.wa_id) : respuestaLista(p.ruta, filas, p.filtros, p.limite);
return [{ json: r }];`);

  codigo(f, 'Pedido de orden', [880, 760], [], `
const p = $input.first().json;
return [{ json: { solicitud_id: p.solicitud_id, simular: p.simular, responsable: p.responsable } }];`);
  ejecutarSubflujo(f, 'Confirmar orden', [1100, 760], CONFIG.idConfirmar, 'Subflujo ITS WOOD - Confirmar orden.');
  codigo(f, 'Respuesta de la orden', [1320, 760], [], `
const r = $input.first().json || {};
if (r.ok === undefined) return [{ json: { status: 500, cuerpo: { ok: false, error: 'El subflujo Confirmar orden no devolvió resultado.' } } }];
return [{ json: { status: r.status || (r.ok ? 200 : 400), cuerpo: r.ok ? { ok: true, resumen: r.resumen, cotizaciones: r.cotizaciones } : { ok: false, error: r.error } } }];`);

  responderJson(f, 'Responder', [1540, 300]);

  f.conectar('API', 'Petición GET', 0);
  f.conectar('API', 'Petición POST', 1);
  f.conectar('Petición GET', 'Configuración');
  f.conectar('Petición POST', 'Configuración');
  f.conectar('Configuración', 'Enrutar');
  const salida = r => rutas.indexOf(r);
  f.conectar('Enrutar', 'Responder', salida('error'));
  f.conectar('Enrutar', 'Responder', salida('salud'));
  f.conectar('Enrutar', 'Mensaje para el bot', salida('mensaje'));
  f.cadena('Mensaje para el bot', 'Procesar mensaje', 'Respuesta del bot', 'Responder');
  f.conectar('Enrutar', 'Leer conversación', salida('conversacion'));
  f.conectar('Enrutar', 'Leer solicitudes', salida('solicitudes'));
  f.conectar('Enrutar', 'Leer proveedores', salida('proveedores'));
  f.conectar('Enrutar', 'Leer cotizaciones', salida('cotizaciones'));
  for (const n of ['Leer conversación', 'Leer solicitudes', 'Leer proveedores', 'Leer cotizaciones']) f.conectar(n, 'Formatear lista');
  f.conectar('Formatear lista', 'Responder');
  f.conectar('Enrutar', 'Pedido de orden', salida('confirmar-orden'));
  f.cadena('Pedido de orden', 'Confirmar orden', 'Respuesta de la orden', 'Responder');
  return f.exportar({ ...AJUSTES, errorWorkflow: CONFIG.idErrores });
}

// ---------- 3. Atención humana ----------

function flujoHumano() {
  const f = crearFlujo('ITS WOOD - Atención humana', CONFIG.idHumano);
  const DEC = "$('Decidir acción').first().json";
  f.nodo('Formulario de atención', 'n8n-nodes-base.formTrigger', 2.2, [0, 300], {
    authentication: 'basicAuth',
    formTitle: 'ITS WOOD · Atención humana',
    formDescription: 'Toma un caso, responde al cliente por el mismo chat de WhatsApp, devuélvelo al bot o ciérralo. Consulta los mensajes del cliente en la pestaña BOT_EVENTOS.',
    formFields: {
      values: [
        { fieldLabel: 'WhatsApp del cliente', placeholder: '51987654321', requiredField: true },
        { fieldLabel: 'Acción', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Tomar caso' }, { option: 'Responder' }, { option: 'Devolver al bot' }, { option: 'Cerrar caso' }, { option: 'Confirmar orden' }] }, requiredField: true },
        { fieldLabel: 'Mensaje al cliente', fieldType: 'textarea' },
        { fieldLabel: 'Responsable', requiredField: true },
      ],
    },
    path: 'itswood-atencion',
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: idEstable(f.nombre, 'form') });
  configuracion(f, [220, 300], ['sheetId', 'phoneNumberId']);
  sheetsLeer(f, 'Leer conversación', [440, 300], T.conversaciones, ['wa_id', expr("String($json['WhatsApp del cliente'] || '').replace(/\\D/g, '')")]);
  codigo(f, 'Decidir acción', [660, 300], ['humano.js'], `
const formulario = $('Formulario de atención').first().json;
return [{ json: decidirAccionHumana({ formulario, filas: $input.all().map(i => i.json), ahora: new Date().toISOString() }) }];`);
  si(f, '¿Acción válida?', [880, 300], '$json.ok');
  sheetsEscribir(f, 'Actualizar conversación', [1100, 200], 'update', T.conversaciones, {
    wa_id: expr(`${DEC}.wa_id`), modo: expr(`${DEC}.modo`), responsable: expr(`${DEC}.responsable`), actualizado_en: expr(`${DEC}.actualizado_en`),
  }, 'wa_id');
  // Confirmar orden: pide cotización a los proveedores de la última solicitud del cliente.
  si(f, '¿Confirmar orden?', [1320, 420], `!!${DEC}.confirmar_solicitud`);
  codigo(f, 'Pedido de orden', [1540, 420], [], `
const d = $('Decidir acción').first().json;
return [{ json: { solicitud_id: d.confirmar_solicitud, simular: false, responsable: d.responsable } }];`);
  ejecutarSubflujo(f, 'Confirmar orden', [1760, 420], CONFIG.idConfirmar, 'Subflujo ITS WOOD - Confirmar orden.');
  si(f, '¿Hay mensaje?', [1320, 200], `!!${DEC}.enviar`);
  whatsappEnviar(f, 'Enviar mensaje', [1540, 100], `${CFG}.phoneNumberId`, `${DEC}.wa_id`, `${DEC}.enviar`, { onError: 'continueErrorOutput' });
  const evento = (resultado, id, detalle) => ({
    mensaje_id: expr(id), fecha: expr('$now.toISO()'), wa_id: expr(`${DEC}.wa_id`), conversacion_id: expr(`${DEC}.conversacion_id`),
    direccion: 'SALIDA_HUMANO', tipo: 'text', texto: expr(`${DEC}.enviar`), media_id: '', resultado, detalle: expr(detalle),
  });
  sheetsEscribir(f, 'Registrar mensaje', [1760, 0], 'append', T.eventos, evento('ENVIADO', '$json.messages[0].id', `${DEC}.responsable`));
  sheetsEscribir(f, 'Registrar error', [1760, 200], 'append', T.eventos, evento('ERROR_ENVIO', "'ERR-HUM-' + $now.toMillis()", errorDe));

  const respuesta = (nombre, pos, cuerpo) => f.nodo(nombre, 'n8n-nodes-base.respondToWebhook', 1.1, pos, {
    respondWith: 'text',
    responseBody: `=<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 16px">${cuerpo}<p><a href="javascript:history.back()">Volver al formulario</a></p></body>`,
    options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } },
  });
  respuesta('Responder hecho', [1980, 100], `<h2>Listo</h2><p>{{ ${DEC}.texto_resultado }}</p><p>{{ ${DEC}.enviar ? 'Mensaje enviado al cliente.' : '' }}</p>`);
  respuesta('Responder fallo de envío', [1980, 300], `<h2>El mensaje no se envió</h2><p>{{ ${DEC}.texto_resultado }}</p><p>Error de WhatsApp: {{ $('Registrar error').first().json.detalle }}</p>`);
  respuesta('Responder orden', [1980, 420], "<h2>{{ $json.ok ? 'Orden confirmada' : 'No se confirmó la orden' }}</h2><p>{{ $json.ok ? $json.resumen : $json.error }}</p><p>{{ ($json.cotizaciones || []).map(c => c.proveedor + ': ' + c.estado).join(' · ') }}</p>");
  respuesta('Responder no válido', [1100, 420], `<h2>No se hizo ningún cambio</h2><p>{{ ${DEC}.texto_resultado }}</p>`);

  f.cadena('Formulario de atención', 'Configuración', 'Leer conversación', 'Decidir acción', '¿Acción válida?');
  f.conectar('¿Acción válida?', 'Actualizar conversación', 0);
  f.conectar('¿Acción válida?', 'Responder no válido', 1);
  f.conectar('Actualizar conversación', '¿Confirmar orden?');
  f.conectar('¿Confirmar orden?', 'Pedido de orden', 0);
  f.cadena('Pedido de orden', 'Confirmar orden', 'Responder orden');
  f.conectar('¿Confirmar orden?', '¿Hay mensaje?', 1);
  f.conectar('¿Hay mensaje?', 'Enviar mensaje', 0);
  f.conectar('¿Hay mensaje?', 'Responder hecho', 1);
  f.conectar('Enviar mensaje', 'Registrar mensaje', 0);
  f.conectar('Enviar mensaje', 'Registrar error', 1);
  f.conectar('Registrar mensaje', 'Responder hecho');
  f.conectar('Registrar error', 'Responder fallo de envío');
  return f.exportar({ ...AJUSTES, errorWorkflow: CONFIG.idErrores });
}

// ---------- 4. Errores ----------

function flujoErrores() {
  const f = crearFlujo('ITS WOOD - Errores', CONFIG.idErrores);
  f.nodo('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 300], {});
  configuracion(f, [220, 300], ['sheetId']);
  codigo(f, 'Preparar registro', [440, 300], [], `
// Registra etapa y causa sin credenciales: se tachan tokens, claves y cabeceras de autorización.
const e = $('Error Trigger').first().json;
const limpiar = v => String(v ?? '')
  .replace(/(bearer|token|access_token|authorization|password|secret|apikey|api_key)(["':=\\s]+)[^\\s"',}]+/gi, '$1$2[oculto]')
  .replace(/EAA[A-Za-z0-9]{20,}/g, '[token oculto]')
  .slice(0, 500);
return [{ json: {
  fecha: new Date().toISOString(),
  flujo: e.workflow?.name || '',
  nodo: e.execution?.lastNodeExecuted || e.trigger?.error?.node?.name || '',
  mensaje: limpiar(e.execution?.error?.message || e.trigger?.error?.message),
  ejecucion_id: String(e.execution?.id || ''),
  modo: e.execution?.mode || '',
} }];`);
  sheetsEscribir(f, 'Registrar error', [660, 300], 'append', T.errores, {
    fecha: expr('$json.fecha'), flujo: expr('$json.flujo'), nodo: expr('$json.nodo'), mensaje: expr('$json.mensaje'),
    ejecucion_id: expr('$json.ejecucion_id'), modo: expr('$json.modo'),
  });
  f.cadena('Error Trigger', 'Configuración', 'Preparar registro', 'Registrar error');
  return f.exportar({ executionOrder: 'v1', timezone: 'America/Lima', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' });
}

// ---------- validación y escritura ----------

function validar(flujo) {
  const nombres = new Set(flujo.nodes.map(n => n.name));
  if (nombres.size !== flujo.nodes.length) throw new Error(`${flujo.name}: nombres de nodo repetidos`);
  for (const [origen, { main }] of Object.entries(flujo.connections)) {
    if (!nombres.has(origen)) throw new Error(`${flujo.name}: conexión desde nodo inexistente ${origen}`);
    for (const salida of main) for (const c of salida) if (!nombres.has(c.node)) throw new Error(`${flujo.name}: conexión a nodo inexistente ${c.node}`);
  }
  for (const n of flujo.nodes) {
    // Las referencias $('Nodo') deben apuntar a nodos existentes.
    for (const [, ref] of JSON.stringify(n.parameters).matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) {
      if (!nombres.has(ref)) throw new Error(`${flujo.name} › ${n.name}: referencia a nodo inexistente ${ref}`);
    }
    if (n.type === 'n8n-nodes-base.code') {
      try { new Function('$', '$input', '$json', '$now', n.parameters.jsCode); } catch (e) { throw new Error(`${flujo.name} › ${n.name}: ${e.message}`); }
    }
  }
}

function escribirFlujos(carpeta) {
  fs.mkdirSync(carpeta, { recursive: true });
  const flujos = {
    '1_procesar_mensaje.json': flujoProcesar(),
    '2_entrada_whatsapp.json': flujoEntrada(),
    '3_atencion_humana.json': flujoHumano(),
    '4_errores.json': flujoErrores(),
    '5_prueba_local.json': flujoPrueba(),
    '6_confirmar_orden.json': flujoConfirmarOrden(),
    '7_api.json': flujoApi(),
  };
  for (const [archivo, flujo] of Object.entries(flujos)) {
    validar(flujo);
    fs.writeFileSync(path.join(carpeta, archivo), JSON.stringify(flujo, null, 2) + '\n');
    console.log(`${path.basename(carpeta)}/${archivo}: ${flujo.nodes.length} nodos`);
  }
}

function main() {
  escribirFlujos(SALIDA);
  if (fs.existsSync(path.join(RAIZ, 'config.local.json'))) {
    CONFIG = cargarConfig(true);
    escribirFlujos(path.join(__dirname, 'flujos_local'));
    CONFIG = cargarConfig(false);
  }
  const columnas = {
    [T.conversaciones]: [...motor.COLUMNAS_CONVERSACION, ...motor.COLUMNAS_EQUIPO_CONVERSACION],
    [T.solicitudes]: [...motor.COLUMNAS_SOLICITUD, 'notas_equipo'],
    [T.clientes]: motor.COLUMNAS_CLIENTE,
    [T.eventos]: motor.COLUMNAS_EVENTO,
    [T.errores]: ['fecha', 'flujo', 'nodo', 'mensaje', 'ejecucion_id', 'modo'],
    [T.cotizaciones]: [...ordenes.COLUMNAS_COTIZACION, 'notas_equipo'],
    [T.proveedores]: ordenes.COLUMNAS_PROVEEDOR,
  };
  fs.writeFileSync(path.join(RAIZ, 'hoja', 'columnas.json'), JSON.stringify(columnas, null, 2) + '\n');
  console.log('hoja/columnas.json actualizado');
}

if (require.main === module) main();
module.exports = { flujoProcesar, flujoEntrada, flujoHumano, flujoErrores, flujoPrueba, flujoConfirmarOrden, flujoApi };

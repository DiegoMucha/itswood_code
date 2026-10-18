'use strict';

// Plan Mermín: configuración, bienvenida web, sincronización de Drive, prioridad, métricas, fidelización y reportes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { HojaMemoria, leerCsv } = require('../sim/hoja_memoria');
const { recibirWebhook, sincronizarDrive } = require('../sim/pipeline');
const ev = require('../sim/eventos');
const demo = require('../sim/fuente_demo');
const { leerConfig, render, validarCambiosConfig, mensajeBienvenida } = require('../src/config');
const { extraerFolderId, elegirHojaFuente, fechaFuente, conectarDrive } = require('../src/sync');

const CATALOGO = leerCsv(path.join(__dirname, '..', 'hoja', 'catalogo_bot.csv'));
const ANA = '51987000001';
const LUIS = '51987000002';
const CONFIG_DEMO = [
  { clave: 'url_web', valor: 'https://tienda.example/' },
  { clave: 'avisos_whatsapp', valor: '51999000111' },
];

function entorno(opciones = {}) {
  const hoja = new HojaMemoria(CATALOGO.map(f => ({ ...f })), []);
  hoja.tablas.BOT_CONFIG = (opciones.config || CONFIG_DEMO).map(f => ({ ...f }));
  let t = Date.parse(opciones.inicio || '2026-10-17T15:00:00.000Z');
  let n = 0;
  const e = {
    hoja,
    enviados: [],
    config: { phoneNumberId: 'PHONE_PRUEBA', waAvisos: '' },
    ahora: () => new Date((t += 1000)).toISOString(),
    enviar: async envio => { e.enviados.push(envio); return { messages: [{ id: `wamid.S${++n}` }] }; },
  };
  e.cliente = async (waId, contenido) => {
    const antes = e.enviados.length;
    await recibirWebhook(ev.mensaje(waId, contenido, { fecha: new Date(t).toISOString() }), e);
    return e.enviados.slice(antes).filter(x => !x.aviso && x.to === waId).map(x => x.texto);
  };
  e.conv = waId => hoja.tablas.BOT_CONVERSACIONES.find(f => f.wa_id === waId);
  return e;
}
async function conversar(e, waId, mensajes) { for (const m of mensajes) await e.cliente(waId, m); }

// ---------- 1. BOT_CONFIG ----------

test('config: valores por defecto, filas de la hoja y plantillas', () => {
  const c = leerConfig([{ clave: 'nombre_bot', valor: 'Robles' }, { clave: 'tono', valor: 'FORMAL' }, { clave: 'url_web', valor: '' }]);
  assert.equal(c.nombre_bot, 'Robles');
  assert.equal(c.tono, 'formal');
  assert.equal(c.codigo_descuento_web, 'WEB10');
  assert.equal(c.url_web, '');
  assert.equal(render('Hola {nombre} y {falta}', { nombre: 'Ana' }), 'Hola Ana y ');
  assert.match(mensajeBienvenida(c), /^¡Buen día! Soy Robles 🌳/);
  assert.doesNotMatch(mensajeBienvenida(c), /web/, 'sin URL no se ofrece la web');
});

test('config: PUT valida claves, tono, hora y números', () => {
  assert.equal(validarCambiosConfig({ nombre_bot: 'Mermín', tono: 'formal' }).filas.length, 2);
  assert.match(validarCambiosConfig({ otra: 1 }).error, /desconocida/);
  assert.match(validarCambiosConfig({ tono: 'gracioso' }).error, /cercano o formal/);
  assert.match(validarCambiosConfig({ hora_resumen_diario: '25:00' }).error, /HH:MM/);
  assert.match(validarCambiosConfig({ ultima_sync: 'x' }).error, /no se edita/);
  assert.match(validarCambiosConfig({ tope_valor: 'mucho' }).error, /número/);
});

// ---------- 2. Bienvenida con redirección a la web ----------

test('bienvenida: la conversación nueva recibe la web con descuento y UTM una sola vez', async () => {
  const e = entorno();
  const [primero] = await e.cliente(ANA, 'Hola');
  assert.match(primero, /Soy Mermín 🌳, el asistente de ITS WOOD/);
  assert.match(primero, /10% de descuento\* con el código \*WEB10\*/);
  assert.match(primero, /https:\/\/tienda\.example\/\?utm_source=whatsapp&utm_campaign=mermin/);
  assert.match(primero, /1️⃣ Para una empresa/);
  const bienvenidas = () => e.hoja.tablas.BOT_EVENTOS.filter(x => x.resultado === 'BIENVENIDA_WEB');
  assert.equal(bienvenidas().length, 1);
  assert.equal(bienvenidas()[0].conversacion_id, e.conv(ANA).conversacion_id);

  const [segundo] = await e.cliente(ANA, 'menu');
  assert.doesNotMatch(segundo, /utm_source/);
  await e.cliente(ANA, '2');
  assert.equal(bienvenidas().length, 1, 'la conversación existente no la recibe de nuevo');
});

test('bienvenida: el nombre del bot y el tono se editan desde BOT_CONFIG', async () => {
  const e = entorno({ config: [...CONFIG_DEMO, { clave: 'nombre_bot', valor: 'Roble' }, { clave: 'tono', valor: 'formal' }] });
  const [r] = await e.cliente(LUIS, 'Buenas');
  assert.match(r, /Soy Roble 🌳/);
  assert.match(r, /Compre en nuestra web\* y llévese/);
  assert.match(r, /utm_campaign=roble/);
  assert.match(r, /¿Prefiere que le ayude por aquí?/);
});

// ---------- 3. Sincronización de la carpeta de Drive ----------

// Drive simulado: la carpeta tiene la hoja fuente con las pestañas de fuente_demo (editables en la prueba).
function conDrive(e, fuente = demo.copia(), archivos = demo.ARCHIVOS_CARPETA) {
  e.drive = {
    listar: folderId => (folderId === 'CARPETA_DEMO' ? archivos : []),
    leer: (sheetId, pestana) => (sheetId === 'SHEET_FUENTE' ? fuente[pestana] || [] : []),
  };
  e.hoja.tablas.BOT_CONFIG.push({ clave: 'drive_folder_id', valor: 'CARPETA_DEMO' });
  return fuente;
}

test('drive: URL de carpeta, elección de la hoja MERMIN_FUENTE y formatos de la hoja', () => {
  assert.equal(extraerFolderId('https://drive.google.com/drive/u/0/folders/1AbC_dEfGhIjKlMn?usp=sharing'), '1AbC_dEfGhIjKlMn');
  assert.equal(extraerFolderId('https://drive.google.com/open?id=1AbC_dEfGhIjKlMn'), '1AbC_dEfGhIjKlMn');
  assert.equal(extraerFolderId('no es una url'), '');
  assert.equal(elegirHojaFuente(demo.ARCHIVOS_CARPETA).id, 'SHEET_FUENTE');
  assert.equal(elegirHojaFuente([{ id: 'X', name: 'Ventas', mimeType: 'application/vnd.google-apps.spreadsheet' }]).id, 'X', 'sin MERMIN_FUENTE usa la primera');
  assert.equal(elegirHojaFuente([{ id: 'P', name: 'foto.png', mimeType: 'image/png' }]), null);
  assert.equal(fechaFuente('17/10/2026'), '2026-10-17');
  assert.equal(fechaFuente('46312'), '2026-10-17', 'número de serie de Sheets');
  assert.equal(fechaFuente('31/02/2026'), '');
});

test('drive: copia la fuente a las pestañas BOT_ y guarda la hoja y ultima_sync en BOT_CONFIG', async () => {
  const e = entorno();
  conDrive(e);
  const r = await sincronizarDrive(e);
  assert.equal(r.ok, true, r.errores && r.errores.join(' '));
  assert.equal(e.hoja.tablas.BOT_PRODUCTOS.length, 9);
  assert.equal(e.hoja.tablas.BOT_CLIENTES_FUENTE.length, 7);
  assert.equal(e.hoja.tablas.BOT_VENTAS.length, 12);
  const ana = e.hoja.tablas.BOT_CLIENTES_FUENTE.find(c => c.cliente_id === 'C002');
  assert.equal(ana.telefono, '51987000001');
  assert.equal(e.hoja.tablas.BOT_CLIENTES_FUENTE.find(c => c.cliente_id === 'C007').tipo, 'PERSONA');
  const p008 = e.hoja.tablas.BOT_VENTAS.find(v => v.pedido_id === 'P008');
  assert.equal(p008.total, 85, 'sin total se calcula con el precio');
  assert.equal(p008.codigo, 'WEB10');
  assert.equal(e.hoja.tablas.BOT_VENTAS[0].fecha, '2026-04-10');
  const config = leerConfig(e.hoja.tablas.BOT_CONFIG);
  assert.equal(config.sheet_fuente_id, 'SHEET_FUENTE');
  assert.match(config.ultima_sync, /^2026-10-17T/);
});

test('drive: una columna faltante se registra en BOT_ERRORES y conserva la última copia válida', async () => {
  const e = entorno();
  const fuente = conDrive(e);
  await sincronizarDrive(e);
  for (const f of fuente.VENTAS) delete f.total;
  fuente.PRODUCTOS.push({ sku: 'NUEVO', nombre: 'Nuevo', categoria: '', precio: '10', costo: '', stock: '', activo: '' });
  const r = await sincronizarDrive(e);
  assert.equal(r.ok, false);
  assert.match(r.errores[0], /VENTAS le faltan columnas: total/);
  assert.match(e.hoja.tablas.BOT_ERRORES.at(-1).mensaje, /total/);
  assert.equal(e.hoja.tablas.BOT_PRODUCTOS.length, 9, 'la copia anterior no se toca');

  const sinCarpeta = entorno();
  const r2 = await sincronizarDrive(sinCarpeta);
  assert.match(r2.errores[0], /Falta conectar la carpeta/);
});

test('drive: conectar la carpeta valida la URL y pide compartirla con la cuenta de servicio', () => {
  assert.equal(conectarDrive({ url: 'hola' }).status, 400);
  const sinAcceso = conectarDrive({ url: 'https://drive.google.com/drive/folders/1AbC_dEfGhIjKlMn', archivos: [], correoServicio: 'bot@proyecto.iam.gserviceaccount.com' });
  assert.equal(sinAcceso.status, 403);
  assert.match(sinAcceso.error, /bot@proyecto\.iam\.gserviceaccount\.com/);
  const ok = conectarDrive({ url: 'https://drive.google.com/drive/folders/1AbC_dEfGhIjKlMn', archivos: demo.ARCHIVOS_CARPETA });
  assert.deepEqual(ok.config.map(c => [c.clave, c.valor]), [['drive_folder_id', '1AbC_dEfGhIjKlMn'], ['sheet_fuente_id', 'SHEET_FUENTE']]);
});

module.exports = { entorno, conversar, conDrive, ANA, LUIS, CONFIG_DEMO };

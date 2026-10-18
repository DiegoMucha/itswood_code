'use strict';

// Plan Mermín: configuración, bienvenida web, sincronización de Drive, prioridad, métricas, fidelización y reportes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { HojaMemoria, leerCsv } = require('../sim/hoja_memoria');
const { recibirWebhook } = require('../sim/pipeline');
const ev = require('../sim/eventos');
const { leerConfig, render, validarCambiosConfig, mensajeBienvenida } = require('../src/config');

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

module.exports = { entorno, conversar, ANA, LUIS, CONFIG_DEMO };

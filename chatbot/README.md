# Chatbot de WhatsApp de ITS WOOD (n8n + Google Sheets)

Mensaje de WhatsApp → preguntas por camino (empresa o persona) → calificación de la intención de compra → registro
en Sheets → derivación → respuesta humana por el mismo chat con el bot en pausa. Al confirmar el equipo una orden,
el bot pide cotización a los proveedores por WhatsApp y guarda sus respuestas. Otras plataformas se conectan por una
API.

n8n es el único backend. El registro es el libro de Google Sheets de ITS WOOD: el bot usa sus propias pestañas `BOT_`,
lee `INVENTARIO` y `PROVEEDORES` y añade prospectos a `PAUTAS`; no toca `VENTAS 2026` ni el resto. No hay servidor propio.

```
WhatsApp Cloud API ──webhook──> [2] Entrada WhatsApp ──cada mensaje──> [1] Procesar mensaje ──> WhatsApp
                                                                         │  (clientes o respuestas de proveedores)
Otra plataforma ──HTTP + X-Api-Key──> [7] API ──┬──> [1] Procesar mensaje (respuesta por HTTP)
                                                ├──> lecturas: conversación, solicitudes, proveedores, cotizaciones
                                                └──> [6] Confirmar orden ──plantilla──> proveedores por WhatsApp
Formulario web (equipo) ──> [3] Atención humana ──> Sheets + WhatsApp, o [6] Confirmar orden
Cualquier fallo ──> [4] Errores ──> Sheets (pestaña BOT_ERRORES)
```

## Estructura

| Ruta | Contenido |
| --- | --- |
| `src/motor.js` | Conversación: pasos, validaciones, catálogo, resumen, derivación e intención de compra. |
| `src/ordenes.js` | Confirmación de órdenes, elección de proveedores, plantilla y respuestas de proveedores. |
| `src/api.js` | Rutas, validación y formato de respuestas de la API. |
| `src/normalizar.js`, `src/pasos.js`, `src/humano.js`, `src/hojas.js` | Webhooks, duplicados, cambio de modo, formulario y nombres de pestañas. |
| `n8n/build.js` | Genera `n8n/flujos/*.json` incrustando `src/` en los nodos Code. |
| `n8n/flujos/` | Exportaciones para compartir: **sin credenciales** y con marcadores. |
| `n8n/flujos_local/` | Las mismas con `config.local.json` aplicado (ID de la hoja e IDs de la instancia). No compartir. |
| `hoja/` | Catálogo, equivalencias (`catalogo_bot.csv`) y plantilla de pestañas `BOT_`. |
| `sim/` | Simulador local, chat de terminal y clientes de prueba (`enviar_prueba.js`, `llamar_api.js`). |
| `test/` | Pruebas de los casos del plan, de proveedores, intención y API, y del código de los nodos. |
| `docs/` | [Hoja](docs/hoja.md) · [API](docs/api.md) · [Proveedores](docs/proveedores.md) · [Configuración](docs/configuracion.md) · [Atención humana](docs/atencion_humana.md) · [Pruebas](docs/pruebas.md) |

## Uso rápido

```bash
npm test
```

```bash
npm run chat
```

```bash
npm run build
```

`npm run chat` abre una conversación local con el bot (sin WhatsApp ni Sheets). `npm run build` vuelve a generar
los flujos y la plantilla después de cambiar `src/` o `config.local.json`.

## Estado

- 48 pruebas automáticas pasan (hoja en memoria con las pestañas reales y el código real de los nodos Code).
- n8n 2.43.7 en Docker con los 7 flujos importados; escritura real en el libro probada con una cuenta de servicio.
- Pestañas `BOT_`, `PROVEEDORES` y `BOT_COTIZACIONES` creadas en el libro.
- **Pendiente:** compartir el libro con la cuenta de servicio y quitar el acceso público; cargar proveedores;
  aprobar la plantilla `itswood_solicitud_cotizacion` en Meta; conectar WhatsApp Cloud API. Ver [docs/pruebas.md](docs/pruebas.md).
- Fuera de esta entrega: transcripción de audios, botones/listas, campañas y posventa.

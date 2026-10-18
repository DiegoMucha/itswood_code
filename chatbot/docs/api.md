# API del bot (backend a backend)

Flujo de n8n `ITS WOOD - API`. Permite que otra plataforma (web, CRM, app interna) converse con el bot, consulte
datos y confirme órdenes. Recibe peticiones y responde en JSON.

- **URL base:** `https://<n8n>/webhook/itswood/api/<ruta>` (local: `http://localhost:5678/webhook/itswood/api/<ruta>`)
- **Autenticación:** cabecera `X-Api-Key: <clave>`. Sin clave o con una incorrecta responde **403**. La clave es una
  credencial "Header Auth" de n8n (`ITS WOOD API`); en local está en `.n8n-local.md`.
- **Formato:** `Content-Type: application/json` en los POST. Todas las respuestas son JSON con `ok`.
- **Errores:** 400 (dato faltante o inválido), 403 (clave), 404 (ruta o recurso inexistente), 405 (método), 500.
  Cuerpo: `{ "ok": false, "error": "<explicación>" }`.
- Las peticiones se procesan en serie con los mensajes de WhatsApp (`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`), así que
  una respuesta puede tardar unos 20 segundos.

## Rutas

| Método | Ruta | Para qué |
| --- | --- | --- |
| GET | `salud` | Comprobar que la API está arriba. |
| POST | `mensaje` | Enviar un mensaje de un cliente al bot y recibir sus respuestas. |
| GET | `conversacion?wa_id=` | Estado de la conversación de un cliente (paso, datos, modo, intención). |
| GET | `solicitudes?estado=&intencion=&wa_id=&limite=` | Solicitudes registradas, la más reciente primero. |
| GET | `proveedores?limite=` | Lista de la pestaña `PROVEEDORES`. |
| GET | `cotizaciones?solicitud_id=&estado=&limite=` | Pedidos de cotización a proveedores y sus respuestas. |
| POST | `confirmar-orden` | Confirmar una orden y pedir cotización a los proveedores. |

`limite` va de 1 a 500 (100 por defecto). Los filtros no distinguen mayúsculas.

### POST mensaje

```json
{ "wa_id": "51987654321", "texto": "Hola, quiero cotizar tablas", "nombre": "Ana", "mensaje_id": "opcional" }
```

`wa_id` identifica al cliente (con código de país); la conversación es la misma que tendría por WhatsApp. Si se
repite un `mensaje_id`, el mensaje se descarta como duplicado. La respuesta **no** se envía por WhatsApp: vuelve en
la respuesta HTTP y queda en `BOT_EVENTOS` con resultado `API`.

```json
{ "ok": true, "ruta": "mensaje", "mensaje_id": "API-...", "wa_id": "51987654321",
  "respuestas": ["¡Hola! 👋 Soy el asistente virtual de ITS WOOD..."], "atendido_por": "bot" }
```

`respuestas` vacío con `atendido_por: "equipo_o_sin_respuesta"` significa que el caso está con una persona del
equipo (el bot no responde), que el mensaje era duplicado o que el modo cambió mientras se procesaba.

### POST confirmar-orden

```json
{ "solicitud_id": "SOL-20261017-0001-24GP", "simular": false, "responsable": "Plataforma X" }
```

Marca la solicitud como `ORDEN_CONFIRMADA` y envía la plantilla de cotización a los proveedores que atienden el
producto (ver [proveedores.md](proveedores.md)). Repetir la llamada no vuelve a escribir a los proveedores ya
contactados; sí reintenta los que quedaron en `ERROR_ENVIO`. Con `"simular": true` no envía nada y registra las
cotizaciones como `SIMULADA` (para pruebas).

```json
{ "ok": true, "resumen": "Orden SOL-... confirmada. Se pidió cotización a 2 proveedor(es): ...",
  "cotizaciones": [{ "proveedor": "Maderas del Norte", "estado": "ENVIADA" }] }
```

Error típico (400): la solicitud no tiene producto o cantidad (por ejemplo, el cliente pidió un asesor antes de
terminar).

## Ejemplos

```bash
curl -H "X-Api-Key: $CLAVE" "http://localhost:5678/webhook/itswood/api/solicitudes?intencion=ALTA"
```

```bash
curl -X POST -H "X-Api-Key: $CLAVE" -H "Content-Type: application/json" -d "{\"wa_id\":\"51987654321\",\"texto\":\"Hola\"}" http://localhost:5678/webhook/itswood/api/mensaje
```

```bash
node sim/llamar_api.js GET "cotizaciones?solicitud_id=SOL-20261017-0001-24GP"
```

## Seguridad

- Rotar la clave cambiando la credencial `ITS WOOD API` en n8n; las plataformas deben guardarla como secreto.
- Exponer n8n solo por HTTPS. La API lee datos de clientes (nombre, teléfono, dirección): darla solo a sistemas del negocio.

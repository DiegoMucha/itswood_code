// Cliente HTTP compartido. Si no hay VITE_API_URL o el backend no responde
// en 4 s, la app pasa a "Modo ejemplo" y cada servicio usa sus datos locales.

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const TIEMPO_MAXIMO_MS = 4000;

let modoEjemplo = !API_URL;
const oyentes = new Set();

export const enModoEjemplo = () => modoEjemplo;

export function alCambiarModo(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

function activarModoEjemplo() {
  if (modoEjemplo) return;
  modoEjemplo = true;
  oyentes.forEach((fn) => fn(true));
}

export class ErrorApi extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.status = status;
  }
}

export async function pedir(ruta, { method = 'GET', body, form } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIEMPO_MAXIMO_MS);
  let res;
  try {
    res = await fetch(`${API_URL}${ruta}`, {
      method,
      signal: ctrl.signal,
      headers: form ? undefined : { 'Content-Type': 'application/json' },
      body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ErrorApi('Sin conexión con el servidor', 0);
  } finally {
    clearTimeout(timer);
  }
  const tipo = res.headers.get('content-type') || '';
  const datos = tipo.includes('json') ? await res.json().catch(() => null) : await res.blob();
  if (!res.ok) throw new ErrorApi(datos?.error || `Error ${res.status}`, res.status);
  return datos;
}

/**
 * Llama al backend y, si no hay conexión (o la ruta aún no existe: 404/501),
 * responde con los datos locales. Los errores de validación (400) sí se muestran.
 */
export async function conRespaldo(llamada, local, { rutaPropuesta = false } = {}) {
  if (modoEjemplo) return local();
  try {
    return await llamada();
  } catch (e) {
    if (e.status === 0) {
      activarModoEjemplo();
      return local();
    }
    if (rutaPropuesta && (e.status === 404 || e.status === 501)) return local();
    throw e;
  }
}

export async function detectarBackend() {
  if (modoEjemplo) return false;
  try {
    await pedir('/health');
    return true;
  } catch {
    activarModoEjemplo();
    return false;
  }
}

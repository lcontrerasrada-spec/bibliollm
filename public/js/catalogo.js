// =====================================================================
// catalogo.js — Lógica COMPARTIDA del catálogo (navegador + Node).
// La usan: la web (public/), el sincronizador (sync/) y el generador
// del dataset de entrenamiento (entrenamiento/). Así el modelo se
// entrena exactamente con el mismo formato que verá en producción.
// =====================================================================

export const SEDES = {
  BIB_CENTRAL_NUEVO_2: 'Central (Montería)',
  BIB_LORICA_NUEVO_2: 'Lorica',
  BIB_BERASTEGUI_NUEVO_2: 'Berástegui',
};

export const URLS_FUENTE = Object.keys(SEDES).map(
  (k) => `https://amauta.unicordoba.edu.co/janium/Descargar/${k}.CSV`
);

// Estados que NO cuentan como parte del inventario visible
const ESTADOS_EXCLUIDOS = new Set(['descarte', 'perdido', 'mutilado']);

export const NUM_SHARDS = 32;

export function normalizar(txt) {
  return (txt || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const limpio = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

// Hash FNV-1a 32 bits → id corto y estable para cada título
export function hashTexto(txt) {
  let h = 0x811c9dc5;
  for (let i = 0; i < txt.length; i++) {
    h ^= txt.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function shardDe(id) {
  return parseInt(id, 36) % NUM_SHARDS;
}

function claseEstado(estado) {
  const e = normalizar(estado);
  if (e === 'disponible') return 'd';
  if (e === 'prestado') return 'p';
  return 'o'; // mantenimiento, en tránsito, procesos técnicos, etc.
}

/**
 * Convierte las filas de los CSV (ya parseadas, con header) en registros
 * agrupados: un registro por obra/edición, con copias por sede y estado.
 * @param {Array<{sede:string, filas:Array<Object>}>} fuentes
 */
export function construirCatalogo(fuentes) {
  const mapa = new Map();
  for (const { sede, filas } of fuentes) {
    for (const f of filas) {
      const titulo = limpio(f.titulo);
      if (!titulo) continue;
      if (ESTADOS_EXCLUIDOS.has(normalizar(f.estado))) continue;
      const autor = limpio(f.autor);
      const clas = limpio(f.clasificacion);
      const info = limpio(f.info_adicional);
      const clave = [titulo, autor, clas, info].map(normalizar).join('|');
      const id = hashTexto(clave);
      let r = mapa.get(id);
      if (!r) {
        const area = limpio(f.descripcion);
        r = {
          id,
          t: titulo,
          a: autor,
          c: clas,
          i: info,
          e: limpio(f.editorial),
          l: limpio(f.lugar),
          y: limpio(f.fec_pub),
          isbn: limpio(f.isbn),
          tp: limpio(f.tipom),
          col: limpio(f.ubicacion),
          area: /^\d{3} - /.test(area) ? area : '',
          s: {},
        };
        mapa.set(id, r);
      }
      const n = Math.max(1, parseInt(f.cantidad, 10) || 1);
      const s = (r.s[sede] ||= { d: 0, p: 0, o: 0 });
      s[claseEstado(f.estado)] += n;
    }
  }
  return [...mapa.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function totalDisponibles(r) {
  return Object.values(r.s).reduce((acc, s) => acc + s.d, 0);
}

export function textoDisponibilidad(r) {
  const partes = [];
  for (const [sede, s] of Object.entries(r.s)) {
    const p = [];
    p.push(`${s.d} disponible${s.d === 1 ? '' : 's'}`);
    if (s.p) p.push(`${s.p} prestado${s.p === 1 ? '' : 's'}`);
    if (s.o) p.push(`${s.o} no disponible${s.o === 1 ? '' : 's'} temporalmente`);
    partes.push(`${sede}: ${p.join(', ')}`);
  }
  return partes.join('; ');
}

/** Ficha en texto plano: ESTE es el contexto que lee el LLM. */
export function fichaTexto(r, n) {
  const campos = [`[${n}] «${r.t}»`];
  campos.push(`Autor: ${r.a || 'sin autor registrado'}`);
  if (r.i) campos.push(`Edición/nota: ${r.i}`);
  if (r.e) campos.push(`Editorial: ${r.e}${r.y ? ', ' + r.y : ''}`);
  else if (r.y) campos.push(`Año: ${r.y}`);
  if (r.tp) campos.push(`Tipo: ${r.tp}`);
  if (r.area) campos.push(`Área: ${r.area}`);
  if (r.c) campos.push(`Clasificación: ${r.c}`);
  if (r.col) campos.push(`Ubicación: ${r.col}`);
  campos.push(`Disponibilidad: ${textoDisponibilidad(r)}`);
  return campos.join(' | ');
}

export const MARCA = {
  nombre: 'Lía',
  eslogan: 'Tu compañera de biblioteca en Unicórdoba',
};

export const PROMPT_SISTEMA =
  `Eres ${MARCA.nombre}, la asistente de las bibliotecas de la Universidad de Córdoba (Colombia). ` +
  'Respondes en español, cercana, clara y breve. Usa SOLO la información de las FICHAS DEL CATÁLOGO y de la ' +
  'INFORMACIÓN DE LA BIBLIOTECA; nunca inventes títulos, autores, copias, horarios ni ubicaciones. Si no tienes ' +
  'el dato, dilo con amabilidad y sugiere otra búsqueda o el sitio web. Para libros, di si hay copias disponibles, ' +
  'en qué sede y con qué clasificación se ubican en el estante. Si la pregunta se refiere a un libro del que ya se ' +
  'habló ("ese", "¿y en Lorica?"), responde sobre ese libro usando su ficha.';

export function construirMensajeUsuario(pregunta, registros, total = registros.length, infoBiblioteca = '') {
  const partes = [];
  if (infoBiblioteca) partes.push(`INFORMACIÓN DE LA BIBLIOTECA:\n${infoBiblioteca}`);
  if (registros.length || !infoBiblioteca) {
    const fichas = registros.length
      ? registros.map((r, i) => fichaTexto(r, i + 1)).join('\n')
      : '(ninguna ficha coincide)';
    const encabezado = registros.length ? `FICHAS DEL CATÁLOGO (coincidencias totales: ${total}):` : 'FICHAS DEL CATÁLOGO:';
    partes.push(`${encabezado}\n${fichas}`);
  }
  partes.push(`PREGUNTA: ${pregunta}`);
  return partes.join('\n\n');
}

export function construirMensajes(pregunta, registros, total, infoBiblioteca = '', historial = []) {
  return [
    { role: 'system', content: PROMPT_SISTEMA },
    ...historial, // turnos anteriores (pregunta/respuesta) → memoria de la conversación
    { role: 'user', content: construirMensajeUsuario(pregunta, registros, total, infoBiblioteca) },
  ];
}

/** Reparte el catálogo en shards estables (por hash del id). */
export function repartirEnShards(registros) {
  const shards = Array.from({ length: NUM_SHARDS }, () => []);
  for (const r of registros) shards[shardDe(r.id)].push(r);
  return shards;
}

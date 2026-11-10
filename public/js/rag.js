// =====================================================================
// rag.js — Recuperación (la "R" de RAG). Índice BM25 con MiniSearch.
// Compartido por la web y el generador de dataset. MiniSearch se
// inyecta para poder usar la versión de CDN (navegador) o npm (Node).
// =====================================================================
import { normalizar, totalDisponibles } from './catalogo.js';

const STOP = new Set(
  ('a al algo algun alguna alguno de del el la las lo los un una unos unas y o u en con por para sobre ' +
    'que quiero quisiera busco buscar buscando necesito encontrar tienen tiene tienes hay existe existen ' +
    'me mi mis libro libros texto textos tema temas acerca favor porfa dame dime muestrame muestra ' +
    'ver algo cual cuales donde esta estan disponible disponibles copia copias ejemplar ejemplares ' +
    'biblioteca sede alguna es son sea como cuantos cuantas autor autores titulo titulado llamado se ' +
    'puedo prestar prestamo hola buenas gracias obra obras material materiales clase recomiendas recomienda ' +
    'recomiendan estoy haciendo trabajo encuentro ubico ubicar estante cuanta libre libres ayudas ayudar ' +
    'algun ningun mas informacion detalle detalles opcion ejemplo hay quiero ver tengo tenga').split(' ')
);

const SEDES_CLAVE = [
  { re: /\b(central|monteria)\b/, sede: 'Central (Montería)' },
  { re: /\blorica\b/, sede: 'Lorica' },
  { re: /\bberastegui\b/, sede: 'Berástegui' },
];

export function terminosBusqueda(consulta) {
  return normalizar(consulta)
    .split(' ')
    .filter((p) => p.length > 1 && !STOP.has(p) && !/^(central|monteria|lorica|berastegui)$/.test(p));
}

export function detectarSede(consulta) {
  const q = normalizar(consulta);
  const m = SEDES_CLAVE.find((s) => s.re.test(q));
  return m ? m.sede : null;
}

export function detectarOpcion(consulta) {
  const q = normalizar(consulta);
  const ord = { primer: 1, primera: 1, primero: 1, uno: 1, segunda: 2, segundo: 2, dos: 2, tercer: 3, tercera: 3, tercero: 3, tres: 3, cuarta: 4, cuarto: 4, cuatro: 4, quinta: 5, quinto: 5, cinco: 5 };
  let m = q.match(/\b(?:opcion|numero|el|la|libro)\s*(\d)\b/) || q.match(/^\s*(\d)\s*$/);
  if (m) return parseInt(m[1], 10);
  m = q.match(/\b(primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|uno|dos|tres|cuatro|cinco)\b/);
  if (m && /(opcion|libro|ese|esa|del|de la|el|la|detalle|quiero|ver)/.test(q)) return ord[m[1]];
  return null;
}

export function esCharla(consulta) {
  const q = normalizar(consulta);
  const palabras = q.split(' ').filter(Boolean).length;
  return (
    palabras <= 6 &&
    /^(hola|holi|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal|gracias|muchas gracias|chao|adios|ok|listo|como estas|quien eres|que puedes hacer|que haces|ayuda)\b/.test(q)
  );
}

export function crearIndice(MiniSearch, registros) {
  const idx = new MiniSearch({
    idField: 'id',
    fields: ['t', 'a', 'c', 'e', 'area', 'tp', 'i', 'isbn'],
    storeFields: [],
    processTerm: (term) => {
      const t = normalizar(term);
      return t && !STOP.has(t) ? t : null;
    },
    searchOptions: {
      boost: { t: 3, a: 2.5, c: 2, area: 0.6, e: 0.8 },
      prefix: (term) => term.length > 3,
      fuzzy: (term) => (term.length >= 6 ? 0.34 : term.length >= 4 ? 0.25 : false),
    },
  });
  idx.addAll(registros);
  return idx;
}

/**
 * Recupera las k fichas más relevantes.
 * @param {MiniSearch} idx
 * @param {Map<string,Object>} porId
 */
export function recuperar(idx, porId, consulta, k = 5, opciones = {}) {
  const terms = terminosBusqueda(consulta);
  const sede = opciones.sede || detectarSede(consulta);
  const soloDisp = opciones.soloDisp || /\bdisponible/.test(normalizar(consulta));
  if (!terms.length) return { registros: [], todos: [], terms, sede, total: 0 };

  const q = terms.join(' ');
  let hits = idx.search(q, { combineWith: 'AND' });
  if (hits.length === 0) hits = idx.search(q, { combineWith: 'OR' });

  let regs = hits.map((h) => porId.get(h.id)).filter(Boolean);
  if (sede) regs = regs.filter((r) => r.s[sede]);
  // Leve preferencia por lo que se puede prestar ya (sin romper el orden BM25)
  const puntaje = new Map(hits.map((h, i) => [h.id, h.score]));
  regs.sort((x, y) => {
    const bx = (puntaje.get(x.id) || 0) * (totalDisponibles(x) > 0 ? 1.15 : 1);
    const by = (puntaje.get(y.id) || 0) * (totalDisponibles(y) > 0 ? 1.15 : 1);
    return by - bx;
  });
  if (soloDisp) {
    const disp = regs.filter((r) => totalDisponibles(r) > 0);
    if (disp.length) regs = disp;
  }
  return { registros: regs.slice(0, k), todos: regs.slice(0, 60), terms, sede, total: regs.length, soloDisp };
}

// =====================================================================
// memoria.js — Memoria de la conversación.
// Recuerda el "libro en foco" (del que se está hablando) y entiende
// preguntas de seguimiento: "¿y en Lorica?", "¿quién lo escribió?",
// "¿hay otra edición?", "¿qué más tiene ese autor?".
// Lo usan la web y el generador del dataset (mismo comportamiento).
// =====================================================================
import { normalizar } from './catalogo.js';
import { terminosBusqueda, detectarSede, esCharla } from './rag.js';

// Palabras que, solas, indican que se sigue hablando del mismo libro
const VOCAB_SEGUIMIENTO = new Set(('y lo la le ese esa este esta eso mismo misma libro obra ' +
  'quien escribio escrito autor autora autores ano edicion ediciones editorial publicado publico cuando ' +
  'isbn copia copias cuantas cuantos hay prestado prestados estante encuentro ubico donde queda ' +
  'otra otras otro otros mas reciente nueva nuevo ultima ultimo antigua vieja tiene tienen escribio ' +
  'llevar llevarme llevo casa prestan prestar puedo disponible disponibles libre libres sede ' +
  'central monteria lorica berastegui tambien todavia aun ahora sigue clasificacion codigo trata tema ' +
  'sobre que de del en para con su sus').split(' '));

const RE_PRONOMBRE = /\b(lo|la|le|ese|esa|este|esta|eso|el mismo|la misma|ese libro|este libro|esa obra|ese autor|este autor|del mismo autor)\b/;
const RE_ARRANQUE = /^(y|tambien|todavia|aun|ademas|entonces|vale|ok|listo)\b/;

/** ¿La pregunta se refiere explícitamente a algo ya mencionado? (lo, ese, este libro…) */
export function tienePronombre(consulta) {
  const q = normalizar(consulta).replace(/\b(la biblioteca|la universidad|la sede)\b/g, '');
  return RE_PRONOMBRE.test(q);
}

/** Tipo de seguimiento o null si la pregunta es una búsqueda nueva. */
export function detectarSeguimiento(consulta, hayFoco) {
  if (!hayFoco || esCharla(consulta)) return null;
  const q = normalizar(consulta);
  if (/\b(la biblioteca|las bibliotecas|la universidad|el campus|la sede central)\b/.test(q)) return null; // habla del lugar, no del libro
  const terms = terminosBusqueda(consulta);
  const nuevas = terms.filter((t) => !VOCAB_SEGUIMIENTO.has(t));
  const corta = q.split(' ').length <= 9;
  const pareceSeguimiento = RE_PRONOMBRE.test(q) || RE_ARRANQUE.test(q) || (corta && nuevas.length === 0);
  if (!pareceSeguimiento || nuevas.length > 0) return null;
  if (/\b(otra|otras|mas reciente|ultima|nueva|antigua|vieja)\b.*\bedicion|\bediciones\b|\bedicion mas\b/.test(q)) return 'ediciones';
  if (/\b(otros|otras|mas|que mas)\b.*\b(autor|autora|escribio|escrito|libros|obras)\b|\bmismo autor\b/.test(q) && !/\bquien\b/.test(q)) return 'autor';
  return 'foco';
}

/** Qué se pregunta sobre el libro en foco (para redactar la respuesta). */
export function aspectoPregunta(consulta) {
  const q = normalizar(consulta);
  if (detectarSede(consulta)) return 'sede';
  if (/\b(quien|autor|autora|escribio|escrito)\b/.test(q)) return 'autor';
  if (/\b(ano|cuando|publicado|publico)\b/.test(q)) return 'anio';
  if (/\beditorial\b/.test(q)) return 'editorial';
  if (/\bedicion\b/.test(q)) return 'edicion';
  if (/\bisbn\b/.test(q)) return 'isbn';
  if (/\b(donde|estante|encuentro|ubico|ubicacion|clasificacion|codigo)\b/.test(q)) return 'ubicacion';
  if (/\b(casa|llevar|llevarme|domicilio)\b/.test(q)) return 'domicilio';
  if (/\b(cuantas|cuantos|copias|disponible|disponibles|libre|libres|hay|prestado)\b/.test(q)) return 'disponibilidad';
  if (/\b(trata|tema|sobre que|de que es)\b/.test(q)) return 'tema';
  return 'disponibilidad';
}

/** Registros que entran como contexto en una pregunta de seguimiento. */
export function contextoSeguimiento(tipo, foco, idx, porId, recuperar) {
  const actual = porId.get(foco.id) || foco;
  if (tipo === 'ediciones') {
    const mismos = recuperar(idx, porId, actual.t, 60).todos
      .filter((r) => normalizar(r.t) === normalizar(actual.t) && normalizar(r.a) === normalizar(actual.a));
    const lista = mismos.length ? mismos : [actual];
    lista.sort((a, b) => (parseInt(String(b.y).replace(/\D/g, ''), 10) || 0) - (parseInt(String(a.y).replace(/\D/g, ''), 10) || 0));
    return { registros: lista.slice(0, 3), total: lista.length };
  }
  if (tipo === 'autor' && actual.a) {
    const otros = recuperar(idx, porId, actual.a.replace(',', ''), 60).todos
      .filter((r) => r.a === actual.a && normalizar(r.t) !== normalizar(actual.t));
    const vistos = new Set();
    const unicos = otros.filter((r) => { const k = normalizar(r.t); if (vistos.has(k)) return false; vistos.add(k); return true; });
    return { registros: unicos.slice(0, 3), total: unicos.length, autor: actual.a };
  }
  return { registros: [actual], total: 1 };
}

/** Historial compacto para el modelo: solo preguntas y respuestas (sin fichas). */
export function historialCompacto(turnos, max = 2) {
  return turnos.slice(-max).flatMap((t) => [
    { role: 'user', content: t.pregunta },
    { role: 'assistant', content: t.respuesta.length > 500 ? t.respuesta.slice(0, 500) + '…' : t.respuesta },
  ]);
}

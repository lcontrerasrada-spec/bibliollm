// =====================================================================
// institucional.js — Lo que el asistente sabe de la universidad y la
// biblioteca (además del catálogo). Edita aquí horarios, servicios, etc.
// Se usa en la web (RAG) y en el dataset de entrenamiento.
// =====================================================================
import { normalizar, MARCA } from './catalogo.js';
import { terminosBusqueda } from './rag.js';

export { MARCA };

export const UNIVERSIDAD = {
  nombre: 'Universidad de Córdoba',
  tipo: 'institución pública de educación superior',
  ciudad: 'Montería, Córdoba',
  direccion: 'Carrera 6 #77-305, Barrio Neiva, Montería, Córdoba',
  web: 'https://www.unicordoba.edu.co/',
};

export const BIBLIOTECA_CENTRAL = {
  nombre: 'Biblioteca Central "Misael Díaz Urzola"',
  ubicacion: 'dentro del Campus Central de la Universidad de Córdoba en Montería',
  // Horario por día de la semana (0 = domingo … 6 = sábado), en hora de Colombia
  horario: {
    1: ['06:00', '20:00'], 2: ['06:00', '20:00'], 3: ['06:00', '20:00'],
    4: ['06:00', '20:00'], 5: ['06:00', '20:00'], 6: ['08:00', '16:00'],
  },
  horarioTexto: ['Lunes a viernes: 6:00 a.m. a 8:00 p.m.', 'Sábados: 8:00 a.m. a 4:00 p.m.'],
  servicios: [
    'Préstamo de material bibliográfico en sala y para llevar a domicilio',
    'Espacios de consulta y salas de estudio individual y grupal',
    'Acceso a repositorios institucionales, recursos en línea y bases de datos digitales',
    'Equipos de cómputo para consulta de catálogo e investigación',
  ],
};

// ---------- Estado abierto / cerrado (hora de Colombia) ----------
const fmtHora = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
};

export function ahoraEnColombia(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fecha);
  const get = (t) => partes.find((p) => p.type === t).value;
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dia, minutos: (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10) };
}

const aMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function estadoBiblioteca(fecha = new Date()) {
  const { dia, minutos } = ahoraEnColombia(fecha);
  const hoy = BIBLIOTECA_CENTRAL.horario[dia];
  if (hoy && minutos >= aMin(hoy[0]) && minutos < aMin(hoy[1])) {
    return { abierta: true, texto: `Abierta · cierra a las ${fmtHora(hoy[1])}` };
  }
  // Próxima apertura
  for (let k = 0; k < 7; k++) {
    const d = (dia + k) % 7;
    const h = BIBLIOTECA_CENTRAL.horario[d];
    if (!h) continue;
    if (k === 0 && minutos < aMin(h[0])) return { abierta: false, texto: `Cerrada · abre hoy a las ${fmtHora(h[0])}` };
    if (k > 0) return { abierta: false, texto: `Cerrada · abre ${k === 1 ? 'mañana' : 'el ' + DIAS[d]} a las ${fmtHora(h[0])}` };
  }
  return { abierta: false, texto: 'Cerrada' };
}

// ---------- Detección: ¿la pregunta es sobre la institución? ----------
const TEMAS = {
  horario: /\b(horario|hora|horas|abre|abren|abierta|abierto|cierra|cierran|cerrada|cerrado|atienden|atencion|sabado|sabados|domingo|domingos|festivo|festivos)\b/,
  ubicacion: /\b(donde queda|donde esta la biblioteca|ubicacion|ubicada|direccion|como llego|llegar|campus|sede central|queda la)\b/,
  servicios: /\b(servicio|servicios|domicilio|a la casa|para la casa|prestan|prestamos|llevar libros|llevarme|sala de estudio|salas|estudio grupal|computador|computadores|equipos|internet|bases de datos|repositorio|recursos en linea|wifi)\b/,
  universidad: /\b(universidad|unicordoba|pagina web|sitio web|web oficial|que es la universidad)\b/,
};

export function temasInstitucionales(consulta) {
  const q = normalizar(consulta);
  return Object.entries(TEMAS).filter(([, re]) => re.test(q)).map(([t]) => t);
}

/** Texto que se agrega al contexto del modelo (la "ficha institucional"). */
export function contextoInstitucional(temas) {
  if (!temas.length) return '';
  const b = BIBLIOTECA_CENTRAL, u = UNIVERSIDAD;
  const l = [];
  l.push(`${u.nombre}: ${u.tipo} ubicada en ${u.ciudad}. Campus Central: ${u.direccion}. Sitio web: ${u.web}`);
  l.push(`${b.nombre}: ${b.ubicacion}.`);
  if (temas.includes('horario')) l.push(`Horario de la Biblioteca Central: ${b.horarioTexto.join('; ')}. Domingos y festivos: no figura horario.`);
  if (temas.includes('servicios')) l.push(`Servicios: ${b.servicios.join('; ')}.`);
  l.push('Sedes Lorica y Berástegui: no hay horario registrado; consultar en el sitio web.');
  return l.join('\n');
}

// Palabras que solo indican el tema institucional (no son un libro a buscar)
const VOCAB_INST = new Set(('horario hora horas abre abren abierta abierto cierra cierran cerrada cerrado atienden atencion ' +
  'sabado sabados domingo domingos festivo festivos queda ubicacion ubicada direccion llego llegar campus servicio servicios ' +
  'domicilio llevar llevarme sala salas estudio grupal individual computador computadores equipos internet bases datos ' +
  'repositorio repositorios recursos linea wifi universidad unicordoba pagina web sitio oficial hoy manana dia dias semana ' +
  'misael diaz urzola central hasta desde puedo pueden ofrece ofrecen tiene tienen que cual cuales como ' +
  'prestan prestamos casa sacar hacen hay usar ir').split(' '));

/** true si la pregunta es solo sobre la biblioteca/universidad (no busca un libro). */
export function esSoloInstitucional(consulta) {
  if (!temasInstitucionales(consulta).length) return false;
  return terminosBusqueda(consulta).every((t) => VOCAB_INST.has(t));
}

#!/usr/bin/env node
// =====================================================================
// generar_dataset.mjs — Crea el dataset de entrenamiento (SFT) para
// afinar el LLM con LoRA. Usa EXACTAMENTE el mismo recuperador y el
// mismo formato de fichas que la web → lo que el modelo aprende es lo
// que verá en producción ("train/serve parity").
//
// Cada ejemplo: [system, user(FICHAS + PREGUNTA), assistant(respuesta)]
// Las respuestas se construyen SOLO con datos de las fichas, así el
// modelo aprende a no inventar (fidelidad / grounding).
//
// Uso: node entrenamiento/generar_dataset.mjs [--n 4500] [--seed 7]
// Salida: entrenamiento/dataset/{train,val,eval}.jsonl
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { crearIndice, recuperar, terminosBusqueda } from '../public/js/rag.js';
import { construirMensajes, normalizar, totalDisponibles } from '../public/js/catalogo.js';
import { detectarSeguimiento, aspectoPregunta, contextoSeguimiento, historialCompacto } from '../public/js/memoria.js';
import { MARCA, BIBLIOTECA_CENTRAL as BC, UNIVERSIDAD as U, contextoInstitucional, temasInstitucionales, esSoloInstitucional } from '../public/js/institucional.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const N = parseInt(arg('--n', '4500'), 10);
const K = 3; // fichas por pregunta (igual que la web: menos texto = respuesta más rápida)

// ---------- RNG reproducible ----------
let semilla = parseInt(arg('--seed', '7'), 10);
const rnd = () => ((semilla = (semilla * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const elegir = (arr) => arr[Math.floor(rnd() * arr.length)];
const prob = (p) => rnd() < p;

const catalogo = JSON.parse(fs.readFileSync(path.join(__dir, '..', 'public', 'data', 'catalogo.json'), 'utf8')).registros;
const porId = new Map(catalogo.map((r) => [r.id, r]));
const idx = crearIndice(MiniSearch, catalogo);
console.log(`Catálogo: ${catalogo.length} obras`);

// ---------- Utilidades de texto ----------
const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const titulo = (t) => t.replace(/\s+/g, ' ').trim().replace(/[ .:;,/]+$/, '');
function nombreAutor(a) {
  if (!a) return '';
  const [ap, no] = a.split(',').map((x) => x.trim());
  return no ? `${no.split(' ')[0]} ${ap}` : ap;
}
const apellido = (a) => (a ? a.split(',')[0].trim() : '');
function conErrorTipeo(s) {
  let x = prob(0.7) ? sinTildes(s) : s;
  if (prob(0.5)) x = x.toLowerCase();
  const pal = x.split(' ');
  const i = pal.findIndex((p) => p.length > 6);
  if (i >= 0 && prob(0.35)) {
    const p = pal[i]; const j = 2 + Math.floor(rnd() * (p.length - 3));
    pal[i] = p.slice(0, j) + p.slice(j + 1); // borra una letra
  }
  return pal.join(' ');
}
const palabrasClave = (t) =>
  terminosBusqueda(t).filter((p) => p.length > 3 && !/^\d+$/.test(p));

// ---------- Relevancia: ¿la ficha corresponde a lo que se pidió? ----------
function relevante(r, terms) {
  if (!terms.length) return false;
  const bolsa = normalizar(`${r.t} ${r.a} ${r.c} ${r.e} ${r.area} ${r.tp} ${r.i} ${r.isbn}`).split(' ');
  const ok = terms.filter((t) => bolsa.some((w) => w.startsWith(t.slice(0, Math.max(4, t.length - 2))) || (t.length <= 4 && w === t)));
  return ok.length >= Math.max(1, Math.ceil(terms.length * (terms.length >= 3 ? 0.67 : 1)));
}

// ---------- Redacción de respuestas (solo con datos de la ficha) ----------
function lineaDisp(r, sede) {
  const ent = Object.entries(r.s).filter(([s]) => !sede || s === sede);
  return ent
    .map(([s, v]) => {
      const p = [];
      if (v.d) p.push(`${v.d} disponible${v.d > 1 ? 's' : ''}`);
      if (v.p) p.push(`${v.p} prestado${v.p > 1 ? 's' : ''}`);
      if (v.o) p.push(`${v.o} en proceso/no disponible${v.o > 1 ? 's' : ''}`);
      if (!p.length) p.push('sin copias disponibles');
      return `${s}: ${p.join(', ')}`;
    })
    .join(' · ');
}
function citaCorta(r) {
  const extra = [nombreAutor(r.a), r.i, r.y].filter(Boolean).join(', ');
  return `**${titulo(r.t)}**${extra ? ` (${extra})` : ''}`;
}
function itemLista(r, n, sede) {
  const ubic = [r.c && `clasificación ${r.c}`, r.col].filter(Boolean).join(', ');
  return `${n}. ${citaCorta(r)}${ubic ? ` — ${ubic}` : ''}.\n   ${totalDisponibles(r) ? '✅' : '⏳'} ${lineaDisp(r, sede)}`;
}

const INTRO_LISTA = [
  (n, q) => `Encontré ${n} resultado${n > 1 ? 's' : ''} para «${q}». Estos son los principales:`,
  (n, q) => `¡Claro! Tenemos ${n} coincidencia${n > 1 ? 's' : ''} con «${q}»:`,
  (n, q) => `Sí, hay material sobre «${q}» (${n} en total). Te dejo los más relevantes:`,
  (n, q) => `Esto es lo que encontré sobre «${q}» (${n} resultado${n > 1 ? 's' : ''}):`,
];
const CIERRE_LISTA = [
  'Si quieres los detalles de alguno, dime «opción 1», «opción 2»…',
  '¿Te muestro los detalles de alguno? Solo dime el número.',
  'Puedes pedirme «más detalles de la opción 2» o buscar otro tema.',
  'Con la clasificación lo ubicas en el estante. ¿Quieres ver alguno en detalle?',
];

function respuestaLista(rels, total, q, sede) {
  const mostrar = rels.slice(0, 3);
  let txt = elegir(INTRO_LISTA)(total, q) + '\n\n';
  txt += mostrar.map((r, i) => itemLista(r, i + 1, sede)).join('\n');
  if (sede) txt += `\n\n(Filtré por la sede ${sede}.)`;
  if (mostrar.length && mostrar.every((r) => totalDisponibles(r) === 0))
    txt += '\n\nAhora mismo no hay copias libres; puedes acercarte al mostrador para apartarlo cuando lo devuelvan.';
  return txt + '\n\n' + elegir(CIERRE_LISTA);
}

function respuestaDetalle(r, n) {
  const l = [];
  l.push(`${elegir(['Aquí tienes los detalles', 'Estos son los datos', 'Te cuento sobre esta obra'])}${n ? ` de la opción ${n}` : ''}:`);
  l.push(`\n📖 **${titulo(r.t)}**`);
  l.push(`👤 Autor: ${r.a || 'no registrado en el catálogo'}`);
  if (r.i) l.push(`📝 Edición: ${r.i}`);
  if (r.e || r.y) l.push(`🏢 Editorial: ${[r.e, r.l, r.y].filter(Boolean).join(', ')}`);
  if (r.tp) l.push(`📚 Tipo: ${r.tp}${r.area ? ` · Área ${r.area}` : ''}`);
  if (r.c) l.push(`🔢 Clasificación: ${r.c}`);
  if (r.col) l.push(`📍 Ubicación: ${r.col}`);
  l.push(`📦 Disponibilidad: ${lineaDisp(r)}`);
  l.push(
    totalDisponibles(r)
      ? `\nAnota la clasificación ${r.c || ''} y búscalo en la ${r.col || 'colección indicada'}.`.replace('  ', ' ')
      : '\nEn este momento no hay copias libres; pregunta en el mostrador por su devolución.'
  );
  return l.join('\n');
}

function respuestaDisponibilidad(r, sede) {
  const ents = Object.entries(r.s).filter(([s]) => !sede || s === sede);
  const disp = ents.reduce((a, [, v]) => a + v.d, 0);
  const cab = disp
    ? elegir(['¡Sí! ', 'Sí, está disponible. ', 'Buenas noticias: ']) + `**${titulo(r.t)}** tiene copias para préstamo.`
    : `Por ahora **${titulo(r.t)}** no tiene copias libres${sede ? ` en ${sede}` : ''}.`;
  let txt = `${cab}\n\n📦 ${lineaDisp(r, sede)}`;
  if (sede && !disp) {
    const otras = Object.entries(r.s).filter(([s, v]) => s !== sede && v.d);
    if (otras.length) txt += `\n\nPero sí hay en ${otras.map(([s, v]) => `${s} (${v.d})`).join(' y ')}.`;
  }
  if (r.c) txt += `\n🔢 Clasificación: ${r.c}${r.col ? ` · 📍 ${r.col}` : ''}`;
  return txt;
}

function respuestaUbicacion(r) {
  const sedes = Object.entries(r.s).filter(([, v]) => v.d).map(([s]) => s);
  return (
    `Para encontrar **${titulo(r.t)}**:\n\n` +
    `📍 Colección: ${r.col || 'no especificada'}\n🔢 Clasificación: ${r.c || 'sin clasificación registrada'}\n` +
    `🏛️ ${sedes.length ? `Disponible en: ${sedes.join(', ')}` : 'No hay copias libres ahora mismo'}\n\n` +
    'Busca el número de clasificación en el lomo del libro; los estantes están ordenados por ese código.'
  );
}

function respuestaNoEncontrado(q, sede) {
  return elegir([
    `No encontré «${q}»${sede ? ` en la sede ${sede}` : ''} en el catálogo. ¿Probamos con el autor, otra palabra clave o el número de clasificación?`,
    `Lo siento, no aparece nada que coincida con «${q}»${sede ? ` en ${sede}` : ''}. Intenta con un término más general o con el apellido del autor.`,
    `Revisé el inventario y no hay coincidencias para «${q}»${sede ? ` en ${sede}` : ''}. ¿Quieres buscar un tema relacionado?`,
  ]);
}

// ---------- Plantillas de preguntas ----------
const P_TITULO = [
  (t) => `¿Tienen el libro «${t}»?`, (t) => `busco ${t}`, (t) => `${t}`, (t) => `necesito el libro ${t}`,
  (t) => `¿hay algún ejemplar de ${t}?`, (t) => `quiero ${t}`, (t) => `me ayudas a encontrar ${t}`,
];
const P_AUTOR = [
  (a) => `libros de ${a}`, (a) => `¿qué tienen de ${a}?`, (a) => `busco algo del autor ${a}`, (a) => `obras de ${a}`, (a) => `${a}`,
];
const P_TEMA = [
  (k) => `algo sobre ${k}`, (k) => `necesito material de ${k} para mi clase`, (k) => `libros de ${k}`,
  (k) => `¿qué tienen sobre ${k}?`, (k) => `estoy haciendo un trabajo de ${k}, ¿qué me recomiendas?`, (k) => `${k}`,
];
const P_DISP = [
  (t) => `¿está disponible «${t}»?`, (t) => `¿puedo prestar ${t}?`, (t) => `¿hay copias libres de ${t}?`, (t) => `¿cuántas copias hay de ${t}?`,
];
const P_SEDE = [
  (t, s) => `¿hay ${t} en ${s}?`, (t, s) => `¿tienen ${t} en la sede ${s}?`, (t, s) => `${t} disponible en ${s}`,
];
const P_UBIC = [
  (t) => `¿dónde encuentro ${t}?`, (t) => `¿en qué estante está ${t}?`, (t) => `¿cómo ubico el libro ${t}?`,
];
const P_OPCION = [
  (n) => `quiero ver la opción ${n}`, (n) => `dame detalles de la opción ${n}`, (n) => `la ${n}`, (n) => `más información del libro ${n}`,
  (n) => `${['', 'la primera', 'la segunda', 'la tercera', 'la cuarta'][n]}`,
];
const CHARLA = [
  ['hola', `¡Hola! 👋 Soy ${MARCA.nombre}, tu compañera de biblioteca en la Universidad de Córdoba. Dime un título, autor o tema y te digo si está disponible y dónde ubicarlo.`],
  ['buenas tardes', '¡Buenas tardes! ¿Qué libro, autor o tema buscamos hoy?'],
  ['buenos días', '¡Buenos días! Estoy listo para ayudarte a encontrar libros en las sedes Central, Lorica y Berástegui. ¿Qué necesitas?'],
  ['gracias', '¡Con gusto! 😊 Si necesitas otro libro, aquí estoy.'],
  ['muchas gracias', '¡A ti! Que te vaya muy bien con tu lectura. 📚'],
  ['¿quién eres?', `Soy ${MARCA.nombre}, la asistente con inteligencia artificial de las bibliotecas de Unicórdoba. Reviso el inventario en tiempo real para decirte qué hay disponible, en qué sede y cómo encontrarlo. También te cuento horarios y servicios de la Biblioteca Central.`],
  ['¿qué puedes hacer?', 'Puedo buscar libros por título, autor, tema o clasificación, decirte cuántas copias hay en cada sede y cómo ubicarlos en el estante. También te cuento el horario, la ubicación y los servicios de la Biblioteca Central. Prueba con «libros de cálculo de Stewart» o «¿a qué hora cierran?».'],
  ['¿cómo estás?', '¡Muy bien, gracias! Con todo el catálogo listo para buscar. ¿Qué te gustaría leer?'],
  ['chao', '¡Hasta luego! Vuelve cuando necesites un libro. 👋'],
  ['hola, ¿cómo funciona esto?', '¡Hola! Escríbeme o dime en voz alta lo que buscas y reviso el inventario en vivo de las tres sedes. Por ejemplo: «¿hay libros de química orgánica en Berástegui?».'],
  ['buenas noches', '¡Buenas noches! ¿Qué libro te ayudo a encontrar?'],
  ['ok gracias', '¡Con gusto! Aquí estaré si necesitas algo más. 📚'],
  ['listo', '¡Perfecto! ¿Buscamos otro libro?'],
  ['hey', '¡Hey! 👋 ¿Qué buscamos hoy en la biblioteca?'],
  ['¿eres una persona?', 'No, soy un modelo de lenguaje afinado con los datos de la biblioteca de Unicórdoba. Para trámites especiales, el personal del mostrador te atiende con gusto.'],
  ['ayuda', 'Escríbeme o dime en voz alta lo que buscas: un título («Cien años de soledad»), un autor («García Márquez»), un tema («álgebra lineal») o una sede («en Lorica»).'],
];
const FUERA = [
  '¿quién ganó el partido de ayer?', '¿cuál es la capital de Francia?', 'cuéntame un chiste', '¿qué hora es?',
  'hazme la tarea de física', '¿cómo está el clima?', 'recomiéndame una película', '¿cuánto es 2 + 2?',
  'escríbeme un poema', '¿quién es el presidente?', '¿dónde queda la cafetería?', 'dame la contraseña del wifi',
];
const RESP_FUERA = [
  'Eso se sale de lo que sé hacer: solo consulto el catálogo de las bibliotecas de Unicórdoba. ¿Te busco algún libro sobre el tema?',
  'Solo puedo ayudarte con el inventario de la biblioteca. Si quieres, busco libros relacionados con eso.',
];
const INVENTADOS = [
  'manual de reparación de naves espaciales klingon', 'recetas de cocina marciana', 'el gato que programaba en cobol',
  'tratado de dragones cordobeses', 'historia secreta del reggaetón cuántico', 'guía de viajes a la atlántida',
  'física de los hechizos', 'zxqvb', 'biografía de pepito pérez el astronauta',
];

// ---------- Generación ----------
const vistos = new Set();
const ejemplos = [];
function agregar(pregunta, regs, total, respuesta, tipo, info = '', permitirRepetido = false) {
  const clave = normalizar(pregunta) + '|' + regs.map((r) => r.id).join(',');
  if (vistos.has(clave) && !permitirRepetido) return;
  vistos.add(clave);
  const msgs = construirMensajes(pregunta, regs, total, info);
  msgs.push({ role: 'assistant', content: respuesta });
  ejemplos.push({ tipo, messages: msgs });
}

function caso(tipo) {
  const r = elegir(catalogo);
  const t = titulo(r.t);
  if (t.length < 4 || t.length > 90) return;
  const sedes = Object.keys(r.s);

  if (tipo === 'titulo' || tipo === 'tema' || tipo === 'autor') {
    let q;
    if (tipo === 'titulo') {
      const pal = t.split(' ');
      const base = pal.length > 6 && prob(0.5) ? pal.slice(0, 4 + Math.floor(rnd() * 2)).join(' ') : t;
      q = elegir(P_TITULO)(prob(0.4) ? conErrorTipeo(base) : base);
    } else if (tipo === 'autor') {
      if (!r.a || /universidad|ministerio|instituto/i.test(r.a)) return;
      q = elegir(P_AUTOR)(prob(0.5) ? apellido(r.a) : nombreAutor(r.a));
    } else {
      const kw = palabrasClave(t);
      if (kw.length < 2) return;
      const i = Math.floor(rnd() * (kw.length - 1));
      q = elegir(P_TEMA)(kw.slice(i, i + 2).join(' '));
    }
    const rec = recuperar(idx, porId, q, K);
    const rels = rec.registros.filter((x) => relevante(x, rec.terms));
    const consulta = rec.terms.join(' ');
    if (!rels.length) return agregar(q, rec.registros, rec.total, respuestaNoEncontrado(consulta, rec.sede), 'no_encontrado');
    const totalRel = rels.length === rec.registros.length ? rec.total : rels.length;
    return agregar(q, rec.registros, rec.total, respuestaLista(rels, totalRel, consulta, rec.sede), tipo);
  }

  if (tipo === 'disponibilidad' || tipo === 'ubicacion' || tipo === 'sede') {
    let q, sede = null;
    if (tipo === 'sede') {
      const todas = ['Lorica', 'Berástegui', 'Montería'];
      const s = prob(0.75) ? sedes[Math.floor(rnd() * sedes.length)].replace('Central (Montería)', prob(0.5) ? 'Montería' : 'la Central') : elegir(todas);
      q = elegir(P_SEDE)(t, prob(0.3) ? sinTildes(s) : s);
    } else q = elegir(tipo === 'ubicacion' ? P_UBIC : P_DISP)(t);
    const rec = recuperar(idx, porId, q, K);
    sede = rec.sede;
    const exactos = rec.registros.filter((x) => normalizar(x.t) === normalizar(r.t));
    if (!exactos.length) {
      if (sede && !rec.registros.length) return agregar(q, [], 0, respuestaNoEncontrado(normalizar(t), sede), 'no_encontrado');
      return;
    }
    // Varias ediciones con el mismo título → se listan todas (no se escoge una al azar)
    const resp = exactos.length > 1
      ? respuestaLista(exactos, exactos.length, titulo(r.t), sede)
      : tipo === 'ubicacion' ? respuestaUbicacion(exactos[0]) : respuestaDisponibilidad(exactos[0], sede);
    return agregar(q, rec.registros, rec.total, resp, tipo);
  }

  if (tipo === 'opcion') {
    const kw = palabrasClave(t);
    if (!kw.length) return;
    const rec = recuperar(idx, porId, kw.slice(0, 2).join(' '), K);
    if (rec.registros.length < 2) return;
    const n = 1 + Math.floor(rnd() * rec.registros.length);
    const q = elegir(P_OPCION)(n);
    return agregar(q, rec.registros, rec.total, respuestaDetalle(rec.registros[n - 1], n), 'opcion');
  }
}

const MEZCLA = [
  ['titulo', 0.24], ['tema', 0.18], ['autor', 0.12], ['disponibilidad', 0.12],
  ['sede', 0.08], ['ubicacion', 0.08], ['opcion', 0.12],
];
let intentos = 0;
const objetivo = Math.round(N * 0.94);
while (ejemplos.length < objetivo && intentos < N * 40) {
  intentos++;
  let u = rnd(), tipo = MEZCLA[0][0];
  for (const [t, p] of MEZCLA) { if ((u -= p) <= 0) { tipo = t; break; } }
  caso(tipo);
}
// Charla, fuera de dominio y títulos inventados (enseñan a no alucinar)
for (let i = 0; ejemplos.length < N && i < N; i++) {
  const u = rnd();
  if (u < 0.4) { const [q, a] = elegir(CHARLA); agregar(prob(0.5) ? q : q.toUpperCase().slice(0, 1) + q.slice(1), [], 0, a, 'charla'); }
  else if (u < 0.6) agregar(elegir(FUERA), [], 0, elegir(RESP_FUERA), 'fuera_dominio');
  else {
    const q = `${elegir(['busco', 'tienen', 'necesito el libro', ''])} ${elegir(INVENTADOS)}`.trim();
    const rec = recuperar(idx, porId, q, K);
    if (rec.registros.some((x) => relevante(x, rec.terms))) continue;
    agregar(q, rec.registros, rec.total, respuestaNoEncontrado(rec.terms.join(' ') || q, rec.sede), 'no_encontrado');
  }
}


// ---------- Preguntas sobre la biblioteca y la universidad ----------
const H = BC.horarioTexto;
const INST = [
  ['horario', ['¿Cuál es el horario de la biblioteca?', 'horario de atención', '¿a qué hora abre la biblioteca?', '¿hasta qué hora atienden?', '¿a qué hora cierran?', 'horario biblioteca central', '¿qué horario tienen?', '¿a qué horas puedo ir a la biblioteca?'],
    () => elegir([
      `🕒 La ${BC.nombre} atiende:\n\n- ${H[0]}\n- ${H[1]}\n\nEl horario publicado no incluye domingos ni festivos.`,
      `Este es el horario de la Biblioteca Central:\n\n- ${H[0]}\n- ${H[1]}\n\n¿Te busco algún libro para que lo tengas listo cuando vayas?`,
    ])],
  ['horario', ['¿abren los sábados?', '¿atienden el sábado?', 'horario del sábado', '¿puedo ir un sábado?'],
    () => `Sí 🙌 Los sábados la Biblioteca Central atiende de 8:00 a.m. a 4:00 p.m. De lunes a viernes, de 6:00 a.m. a 8:00 p.m.`],
  ['horario', ['¿abren los domingos?', '¿atienden los domingos?', '¿abren los festivos?', '¿hay servicio el domingo?'],
    () => `El horario publicado de la Biblioteca Central es de lunes a sábado (${H[0].toLowerCase()}; ${H[1].toLowerCase()}) y no incluye domingos ni festivos. Para confirmar fechas especiales, revisa ${U.web}`],
  ['horario', ['¿qué horario tiene la biblioteca de Lorica?', 'horario sede Berástegui', '¿a qué hora abre la biblioteca de Lorica?', '¿cuál es el horario en Berástegui?'],
    () => `No tengo registrado el horario de esa sede 😕 Solo tengo el de la Biblioteca Central en Montería (${H[0].toLowerCase()}; ${H[1].toLowerCase()}). Puedes confirmarlo en ${U.web}`],
  ['ubicacion', ['¿Dónde queda la biblioteca?', '¿dónde está la biblioteca central?', 'ubicación de la biblioteca', '¿cómo llego a la biblioteca?', '¿cuál es la dirección de la universidad?', 'dirección del campus central'],
    () => `📍 La ${BC.nombre} está ${BC.ubicacion}.\n\nDirección del Campus Central: ${U.direccion}.`],
  ['servicios', ['¿Qué servicios tiene la biblioteca?', '¿qué ofrece la biblioteca?', 'servicios de la biblioteca', '¿qué puedo hacer en la biblioteca?'],
    () => `En la Biblioteca Central puedes:\n\n${BC.servicios.map((x) => `- ${x}`).join('\n')}\n\n¿Quieres que te busque un libro?`],
  ['servicios', ['¿puedo llevarme libros a la casa?', '¿prestan libros a domicilio?', '¿los libros se pueden sacar de la biblioteca?', '¿hacen préstamos para la casa?'],
    () => `Sí 📚 La biblioteca presta material bibliográfico en sala y también para llevar a domicilio. Dime qué libro buscas y te digo si hay copias disponibles.`],
  ['servicios', ['¿tienen salas de estudio?', '¿hay salas para estudiar en grupo?', '¿dónde puedo estudiar en grupo?', '¿hay espacio para estudiar solo?'],
    () => `Sí, la Biblioteca Central tiene espacios de consulta y salas de estudio individual y grupal.`],
  ['servicios', ['¿tienen computadores?', '¿hay equipos para investigar?', '¿puedo usar un computador en la biblioteca?'],
    () => `Sí, hay equipos de cómputo para consultar el catálogo y para investigación.`],
  ['servicios', ['¿tienen bases de datos?', '¿hay recursos digitales?', '¿tienen repositorio institucional?', 'bases de datos de la universidad'],
    () => `Sí, la biblioteca da acceso a repositorios institucionales, recursos en línea y bases de datos digitales. Encuentras los enlaces en ${U.web}`],
  ['servicios', ['¿tienen wifi?', '¿hay internet en la biblioteca?', '¿cuál es la clave del wifi?'],
    () => `No tengo información sobre el wifi 😕 Lo que sí sé es que hay equipos de cómputo para consulta e investigación. Pregunta en el mostrador por el acceso a internet.`],
  ['universidad', ['¿Qué es la Universidad de Córdoba?', 'háblame de la universidad', '¿cuál es la página de la universidad?', 'sitio web de unicordoba', '¿la universidad es pública?'],
    () => `La ${U.nombre} es una ${U.tipo} ubicada en ${U.ciudad}.\n\n📍 Campus Central: ${U.direccion}\n🌐 ${U.web}`],
];
for (let ronda = 0; ronda < 3; ronda++) {
  for (const [, preguntas, resp] of INST) {
    for (const q0 of preguntas) {
      const q = ronda === 0 ? q0 : ronda === 1 ? sinTildes(q0.toLowerCase()) : q0.replace(/^¿/, '').replace(/\?$/, '');
      const temas = temasInstitucionales(q);
      const info = contextoInstitucional(temas.length ? temas : ['universidad']);
      const regs = esSoloInstitucional(q) ? [] : recuperar(idx, porId, q, K).registros;
      agregar(q, regs, regs.length, resp(), 'institucional', info, true); // repetidas a propósito: refuerzan este tema
    }
  }
}
// Mixtas: libro + llevarlo a domicilio
for (let i = 0; i < 400; i++) {
  if (ejemplos.filter((e) => e.tipo === 'institucional').length > 260) break;
  const r = elegir(catalogo);
  const t = titulo(r.t);
  if (t.length < 5 || t.length > 70) continue;
  const q = elegir([`¿puedo llevarme ${t} a la casa?`, `¿me prestan ${t} para la casa?`, `quiero llevarme ${t}`]);
  const rec = recuperar(idx, porId, q, K);
  const ex = rec.registros.find((x) => normalizar(x.t) === normalizar(r.t));
  if (!ex) continue;
  const info = contextoInstitucional(['servicios']);
  const disp = totalDisponibles(ex);
  const resp = disp
    ? `¡Sí! La biblioteca presta material para llevar a domicilio, y **${t}** tiene copias disponibles.\n\n📦 ${lineaDisp(ex)}${ex.c ? `\n🔢 Clasificación: ${ex.c}${ex.col ? ` · 📍 ${ex.col}` : ''}` : ''}\n\nLlévalo al mostrador para registrar el préstamo.`
    : `La biblioteca sí presta material a domicilio, pero ahora mismo **${t}** no tiene copias libres.\n\n📦 ${lineaDisp(ex)}\n\nPregunta en el mostrador cuándo vuelve.`;
  agregar(q, rec.registros, rec.total, resp, 'institucional', info);
}


// ---------- Conversaciones con memoria (2 turnos sobre el mismo libro) ----------
const SEGUIMIENTOS = {
  sede: ['¿y en {S}?', '¿lo tienen en {S}?', '¿y hay en la sede {S}?', '¿está en {S}?'],
  autor: ['¿quién lo escribió?', '¿quién es el autor?', '¿de quién es ese libro?', 'y el autor?'],
  anio: ['¿de qué año es?', '¿cuándo se publicó?', '¿es reciente?'],
  editorial: ['¿qué editorial es?', '¿de qué editorial es ese libro?'],
  edicion: ['¿qué edición es?', '¿de qué edición es ese?'],
  isbn: ['¿cuál es el ISBN?', '¿tiene ISBN?'],
  ubicacion: ['¿dónde lo encuentro?', '¿en qué estante está?', '¿y cómo lo ubico?', '¿cuál es su clasificación?'],
  domicilio: ['¿me lo puedo llevar a la casa?', '¿lo puedo sacar de la biblioteca?', '¿y me lo prestan para la casa?'],
  disponibilidad: ['¿cuántas copias hay?', '¿está disponible?', '¿y todavía hay copias?', '¿hay alguno libre?'],
  tema: ['¿de qué trata?', '¿sobre qué tema es?'],
  ediciones: ['¿hay otra edición?', '¿cuál es la edición más reciente?', '¿tienen otras ediciones?'],
  autor_mas: ['¿qué más tiene ese autor?', '¿hay otros libros del mismo autor?', '¿qué otros libros escribió?'],
};
const sedeCorta = (x) => x.replace(' (Montería)', '');
const sinFin = (t) => t.replace(/[ .:;,/]+$/, '');

function respuestaSeguimiento(aspecto, r, ctx, sede) {
  const t = `**${sinFin(r.t)}**`;
  switch (aspecto) {
    case 'sede': return respuestaDisponibilidad(r, sede);
    case 'autor': return r.a ? `${t} es de ${nombreAutor(r.a)}${r.i ? ` (${r.i})` : ''}.` : `El catálogo no registra el autor de ${t}.`;
    case 'anio': return r.y ? `Esta edición de ${t} es de ${r.y}${r.e ? `, publicada por ${r.e}` : ''}.` : `El catálogo no registra el año de ${t}.`;
    case 'editorial': return r.e ? `${t} es de la editorial ${r.e}${r.l ? ` (${r.l})` : ''}${r.y ? `, ${r.y}` : ''}.` : `El catálogo no registra la editorial de ${t}.`;
    case 'edicion': return r.i ? `Es la ${r.i} de ${t}${r.y ? `, de ${r.y}` : ''}.` : `El catálogo no indica el número de edición de ${t}${r.y ? `; es de ${r.y}` : ''}.`;
    case 'isbn': return r.isbn ? `El ISBN de ${t} es ${r.isbn}.` : `La ficha de ${t} no tiene ISBN registrado.`;
    case 'ubicacion': return respuestaUbicacion(r);
    case 'domicilio': return totalDisponibles(r)
      ? `¡Sí! La biblioteca presta material para llevar a domicilio y ${t} tiene copias disponibles.\n\n📦 ${lineaDisp(r)}${r.c ? `\n🔢 Clasificación: ${r.c}` : ''}\n\nLlévalo al mostrador para registrar el préstamo.`
      : `La biblioteca sí presta a domicilio, pero ahora mismo ${t} no tiene copias libres.\n\n📦 ${lineaDisp(r)}`;
    case 'tema': return r.area ? `${t} está en el área ${r.area}${r.tp ? ` (${r.tp})` : ''}. El catálogo no trae un resumen del contenido, pero puedes ojearlo en la ${r.col || 'colección indicada'}.` : `No tengo un resumen de ${t}; el catálogo solo registra su ficha bibliográfica.`;
    case 'ediciones': {
      if (ctx.registros.length <= 1) return `Solo encontré esta edición de ${t}${r.i ? ` (${r.i})` : ''}${r.y ? `, de ${r.y}` : ''}.`;
      const [nueva] = ctx.registros;
      return `Sí, de ${t} hay ${ctx.total} ediciones. La más reciente es ${[nueva.i, nueva.y].filter(Boolean).join(', ') || 'la primera de la lista'}:\n\n${ctx.registros.map((x, i) => itemLista(x, i + 1)).join('\n')}`;
    }
    case 'autor_mas': {
      const nombre = nombreAutor(r.a);
      if (!ctx.registros.length) return `No encontré otras obras de ${nombre} en el catálogo, aparte de ${t}.`;
      return `Además de ${t}, de ${nombre} tenemos ${ctx.total} obra${ctx.total > 1 ? 's' : ''} más:\n\n${ctx.registros.map((x, i) => itemLista(x, i + 1)).join('\n')}`;
    }
    default: return respuestaDisponibilidad(r, null);
  }
}

let conversaciones = 0;
for (let i = 0; i < 6000 && conversaciones < 900; i++) {
  const r0 = elegir(catalogo);
  const t0 = titulo(r0.t);
  if (t0.length < 4 || t0.length > 70) continue;
  // Turno 1: el usuario busca un libro
  const q1 = elegir(P_TITULO)(prob(0.3) ? sinTildes(t0.toLowerCase()) : t0);
  const rec1 = recuperar(idx, porId, q1, K);
  const rels = rec1.registros.filter((x) => relevante(x, rec1.terms));
  if (!rels.length) continue;
  const foco = rec1.registros[0];
  if (!rels.includes(foco)) continue;
  const resp1 = rels.length > 1 ? respuestaLista(rels, rels.length === rec1.registros.length ? rec1.total : rels.length, rec1.terms.join(' ')) : respuestaDisponibilidad(foco);
  // Turno 2: pregunta de seguimiento sobre ese mismo libro
  let aspecto = elegir(Object.keys(SEGUIMIENTOS));
  if (aspecto === 'autor_mas' && !foco.a) aspecto = 'autor';
  let sede = null;
  let q2 = elegir(SEGUIMIENTOS[aspecto]);
  if (q2.includes('{S}')) { sede = elegir(['Central (Montería)', 'Lorica', 'Berástegui']); q2 = q2.replace('{S}', sedeCorta(sede)); }
  const tipo = detectarSeguimiento(q2, true);
  if (!tipo) continue; // la web no lo reconocería como seguimiento: no lo entrenamos
  const ctx = contextoSeguimiento(tipo, foco, idx, porId, recuperar);
  const aspectoFinal = tipo === 'ediciones' ? 'ediciones' : tipo === 'autor' ? 'autor_mas' : aspectoPregunta(q2);
  const resp2 = respuestaSeguimiento(aspectoFinal, porId.get(foco.id), ctx, sede);
  const info = aspectoFinal === 'domicilio' ? contextoInstitucional(['servicios']) : '';
  const historial = historialCompacto([{ pregunta: q1, respuesta: resp1 }]);
  const msgs = construirMensajes(q2, ctx.registros, ctx.total, info, historial);
  msgs.push({ role: 'assistant', content: resp2 });
  ejemplos.push({ tipo: 'memoria', messages: msgs });
  conversaciones++;
}

// ---------- Mezclar, dividir y guardar ----------
for (let i = ejemplos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ejemplos[i], ejemplos[j]] = [ejemplos[j], ejemplos[i]]; }
const nEval = 150, nVal = Math.round(ejemplos.length * 0.04);
const evalSet = ejemplos.slice(0, nEval), val = ejemplos.slice(nEval, nEval + nVal), train = ejemplos.slice(nEval + nVal);
const out = path.join(__dir, 'dataset');
fs.mkdirSync(out, { recursive: true });
const guardar = (n, arr) => fs.writeFileSync(path.join(out, n), arr.map((e) => JSON.stringify(e)).join('\n') + '\n');
guardar('train.jsonl', train); guardar('val.jsonl', val); guardar('eval.jsonl', evalSet);

const conteo = {};
ejemplos.forEach((e) => (conteo[e.tipo] = (conteo[e.tipo] || 0) + 1));
console.log(`Ejemplos: ${ejemplos.length} (train ${train.length}, val ${val.length}, eval ${evalSet.length})`);
console.table(conteo);

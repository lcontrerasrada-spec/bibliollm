// =====================================================================
// app.js — Lía: orquesta la conversación y la experiencia.
//   pregunta → RECUPERAR (catálogo en vivo + info de la biblioteca)
//   → fichas al instante → el modelo redacta encima → acciones rápidas.
// =====================================================================
import { CONFIG } from './config.js';
import { Inventario } from './datos.js';
import { recuperar, detectarOpcion, esCharla } from './rag.js';
import { construirMensajes, totalDisponibles, normalizar } from './catalogo.js';
import {
  MARCA, BIBLIOTECA_CENTRAL as BC, UNIVERSIDAD as U,
  estadoBiblioteca, temasInstitucionales, contextoInstitucional, esSoloInstitucional,
} from './institucional.js';
import { OrbeAgua } from './orbe.js';

const $ = (id) => document.getElementById(id);
const historial = $('historial');
const inventario = new Inventario();
const orbeAgua = new OrbeAgua($('orbe-canvas'));
const POR_PAGINA = CONFIG.FICHAS_POR_PREGUNTA || 3;

let ultimas = { registros: [], todos: [], total: 0 };
let modeloListo = false;
let generando = null;
let contador = 0;
const fichasVisibles = new Map(); // id → Set(elementos)
const filtro = { sede: '', soloDisp: false };

// ---------------------------------------------------------------
// Marca y saludo
// ---------------------------------------------------------------
document.title = `${MARCA.nombre} · Bibliotecas Unicórdoba`;
$('marca-nombre').textContent = MARCA.nombre;
$('marca-eslogan').textContent = MARCA.eslogan;
(() => {
  const h = new Date().getHours();
  const s = h < 12 ? '¡Buenos días!' : h < 19 ? '¡Buenas tardes!' : '¡Buenas noches!';
  $('saludo').textContent = `${s} Soy ${MARCA.nombre} 👋`;
})();

// ---------------------------------------------------------------
// Biblioteca Central: estado en vivo, horario, servicios
// ---------------------------------------------------------------
function pintarBiblioteca() {
  const e = estadoBiblioteca();
  $('txt-biblioteca').textContent = `Biblioteca ${e.texto.toLowerCase()}`;
  $('punto-biblio').classList.toggle('vivo', e.abierta);
  $('estado-biblio').textContent = e.abierta ? 'Abierta' : 'Cerrada';
  $('estado-biblio').classList.toggle('abierta', e.abierta);
}
$('horario').innerHTML = BC.horarioTexto.map((h) => { const [d, r] = h.split(': '); return `<li><span>${d}</span><b>${r}</b></li>`; }).join('') +
  '<li><span>Domingos y festivos</span><b>Sin horario publicado</b></li>';
$('servicios').innerHTML = BC.servicios.map((s) => `<li>${s}</li>`).join('');
$('btn-mapa').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Universidad de Córdoba ' + U.direccion)}`;
$('btn-web').href = U.web;
pintarBiblioteca();
setInterval(pintarBiblioteca, 60_000);

// ---------------------------------------------------------------
// Inventario en tiempo real
// ---------------------------------------------------------------
const fmt = new Intl.NumberFormat('es-CO');
function haceCuanto(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'hace segundos';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}
function pintarEstadoInventario() {
  const m = inventario.meta;
  if (!m) return;
  $('punto-vivo').classList.toggle('vivo', inventario.enVivo);
  $('txt-inventario').textContent = inventario.enVivo
    ? `${fmt.format(inventario.porId.size)} obras · en vivo`
    : `${fmt.format(inventario.porId.size)} obras · copia del ${new Date(m.version).toLocaleDateString('es-CO')}`;
  $('pill-inventario').title = inventario.enVivo ? `Inventario revisado ${haceCuanto(m.ultimaRevision)}` : 'Copia estática del catálogo';
}
setInterval(pintarEstadoInventario, 30_000);
inventario.addEventListener('listo', () => { pintarEstadoInventario(); pintarLista(); });
inventario.addEventListener('meta', pintarEstadoInventario);
inventario.addEventListener('cambios', ({ detail: ids }) => {
  for (const id of ids) {
    const els = fichasVisibles.get(id);
    if (!els) continue;
    const r = inventario.porId.get(id);
    for (const el of [...els]) {
      if (!el.isConnected) { els.delete(el); continue; }
      const nuevo = crearFicha(r, el.dataset.n, true);
      el.replaceWith(nuevo);
      els.delete(el);
      els.add(nuevo);
    }
  }
  if (ids.some((id) => miLista.includes(id))) pintarLista();
  pintarEstadoInventario();
});
inventario.addEventListener('novedades', ({ detail: lista }) => {
  const ul = $('novedades');
  if (!lista.length) return;
  ul.innerHTML = '';
  const etiqueta = { nuevo: 'Nuevo', disponibilidad: 'Cambio', retirado: 'Retirado' };
  for (const n of lista) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="etq ${n.tipo}">${etiqueta[n.tipo] || n.tipo}</span><b></b><small></small>`;
    li.querySelector('b').textContent = n.titulo;
    li.querySelector('small').textContent = `${n.detalle} · ${haceCuanto(n.ts)}`;
    ul.appendChild(li);
  }
});

// ---------------------------------------------------------------
// Utilidades de render
// ---------------------------------------------------------------
function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const markdown = (s) => escapar(s)
  .replace(/^- /gm, '• ')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
function bajar() { historial.scrollTop = historial.scrollHeight; }
const sedeCorta = (s) => s.replace(' (Montería)', '');
let tToast;
function toast(txt) {
  const t = $('toast');
  t.textContent = txt;
  t.classList.remove('oculto');
  clearTimeout(tToast);
  tToast = setTimeout(() => t.classList.add('oculto'), 2200);
}

function msgUsuario(texto) {
  $('bienvenida')?.remove();
  const d = document.createElement('div');
  d.className = 'msg usuario';
  d.textContent = texto;
  historial.appendChild(d);
  bajar();
}
function msgBot() {
  const d = document.createElement('div');
  d.className = 'msg bot';
  d.innerHTML = '<div class="puntos"><i></i><i></i><i></i></div>';
  historial.appendChild(d);
  bajar();
  return d;
}

// ---------------------------------------------------------------
// Fichas
// ---------------------------------------------------------------
function chipsDisponibilidad(r, cont) {
  for (const [sede, s] of Object.entries(r.s)) {
    const add = (cls, txt) => { const c = document.createElement('span'); c.className = 'chip ' + cls; c.textContent = txt; cont.appendChild(c); };
    add(s.d ? 'd' : '', `${sedeCorta(sede)}: ${s.d} disp.`);
    if (s.p) add('p', `${s.p} prestado${s.p > 1 ? 's' : ''}`);
  }
}

function crearFicha(r, n, actualizado = false) {
  const el = document.createElement('div');
  el.className = 'ficha' + (actualizado ? ' flash' : '');
  el.dataset.id = r ? r.id : '';
  el.dataset.n = n;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  if (!r) {
    el.innerHTML = `<span class="n">${n}</span><span class="t">Esta obra ya no figura en el inventario</span>`;
    return el;
  }
  const guardado = miLista.includes(r.id);
  el.innerHTML = `<div class="ficha-cab"><span class="n">OPCIÓN ${n}${actualizado ? ' <span class="nuevo-dato">· actualizado ahora</span>' : ''}</span>
    <button class="estrella${guardado ? ' on' : ''}" aria-label="Guardar en mi lista" title="Guardar en mi lista">${guardado ? '★' : '☆'}</button></div>
    <span class="t"></span><span class="a"></span><span class="c"></span><span class="chips"></span>`;
  el.querySelector('.t').textContent = r.t;
  el.querySelector('.a').textContent = [r.a, r.i, r.y].filter(Boolean).join(' · ') || 'Sin autor registrado';
  el.querySelector('.c').textContent = [r.c, r.col].filter(Boolean).join(' · ');
  chipsDisponibilidad(r, el.querySelector('.chips'));
  el.querySelector('.estrella').addEventListener('click', (e) => { e.stopPropagation(); alternarLista(r.id); });
  const abrir = () => abrirDetalle(inventario.porId.get(r.id) || r);
  el.addEventListener('click', abrir);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  if (actualizado) setTimeout(() => el.classList.remove('flash'), 2500);
  return el;
}

function pintarFichas(contenedor, registros, desde = 1) {
  if (!registros.length) return null;
  const g = document.createElement('div');
  g.className = 'fichas';
  registros.forEach((r, i) => {
    const el = crearFicha(r, desde + i);
    g.appendChild(el);
    if (!fichasVisibles.has(r.id)) fichasVisibles.set(r.id, new Set());
    fichasVisibles.get(r.id).add(el);
  });
  contenedor.appendChild(g);
  return g;
}

// ---------------------------------------------------------------
// Detalle de un libro (instantáneo, sin esperar al modelo)
// ---------------------------------------------------------------
let detalleActual = null;
function abrirDetalle(r) {
  detalleActual = r;
  $('det-tipo').textContent = [r.tp, r.area].filter(Boolean).join(' · ');
  $('det-titulo').textContent = r.t;
  $('det-autor').textContent = [r.a || 'Sin autor registrado', r.i].filter(Boolean).join(' · ');
  const disp = $('det-disp');
  disp.innerHTML = '';
  for (const [sede, s] of Object.entries(r.s)) {
    const fila = document.createElement('div');
    fila.className = 'det-sede' + (s.d ? ' ok' : '');
    fila.innerHTML = `<b></b><span></span>`;
    fila.querySelector('b').textContent = sede;
    fila.querySelector('span').textContent = [
      `${s.d} disponible${s.d === 1 ? '' : 's'}`, s.p && `${s.p} prestado${s.p > 1 ? 's' : ''}`, s.o && `${s.o} en proceso`,
    ].filter(Boolean).join(' · ');
    disp.appendChild(fila);
  }
  const sedesOk = Object.entries(r.s).filter(([, s]) => s.d).map(([n]) => n);
  const pasos = [
    sedesOk.length ? `Ve a la biblioteca de <b>${escapar(sedesOk.join(' o '))}</b>.` : 'Ahora no hay copias libres: pregunta en el mostrador cuándo vuelve una.',
    r.col ? `Busca la <b>${escapar(r.col)}</b>.` : 'Pregunta en el mostrador por la colección.',
    r.c ? `Ubica en el lomo la clasificación <b class="mono">${escapar(r.c)}</b> (los estantes van en ese orden).` : 'Pide ayuda en el mostrador para ubicarlo.',
    'Llévalo al mostrador para el préstamo en sala o a domicilio.',
  ];
  $('det-pasos').innerHTML = pasos.map((p) => `<li>${p}</li>`).join('');
  const datos = [['Editorial', [r.e, r.l, r.y].filter(Boolean).join(', ')], ['ISBN', r.isbn], ['Clasificación', r.c]].filter(([, v]) => v);
  $('det-datos').innerHTML = datos.map(([k, v]) => `<dt>${k}</dt><dd>${escapar(v)}</dd>`).join('');
  $('det-guardar').textContent = miLista.includes(r.id) ? '★ Quitar de mi lista' : '⭐ Guardar en mi lista';
  $('det-copiar').classList.toggle('oculto', !r.c);
  $('velo').classList.remove('oculto');
  $('detalle').classList.remove('oculto');
  $('det-cerrar').focus();
}
function cerrarDetalle() { $('velo').classList.add('oculto'); $('detalle').classList.add('oculto'); detalleActual = null; }
$('det-cerrar').onclick = cerrarDetalle;
$('velo').onclick = cerrarDetalle;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cerrarDetalle();
  if (e.key === '/' && document.activeElement !== $('texto')) { e.preventDefault(); $('texto').focus(); }
});
$('det-guardar').onclick = () => { if (detalleActual) { alternarLista(detalleActual.id); abrirDetalle(detalleActual); } };
$('det-copiar').onclick = async () => {
  try { await navigator.clipboard.writeText(detalleActual.c); toast('Clasificación copiada 📋'); } catch { toast(detalleActual.c); }
};

// ---------------------------------------------------------------
// Mi lista (se guarda en este navegador)
// ---------------------------------------------------------------
let miLista = [];
try { miLista = JSON.parse(localStorage.getItem('lia-lista') || '[]'); } catch { miLista = []; }
function guardarLista() { try { localStorage.setItem('lia-lista', JSON.stringify(miLista)); } catch { /* sin almacenamiento */ } }
function alternarLista(id) {
  const ya = miLista.includes(id);
  miLista = ya ? miLista.filter((x) => x !== id) : [id, ...miLista].slice(0, 30);
  guardarLista();
  toast(ya ? 'Quitado de tu lista' : 'Guardado en tu lista ⭐');
  document.querySelectorAll(`.ficha[data-id="${id}"] .estrella`).forEach((b) => { b.classList.toggle('on', !ya); b.textContent = ya ? '☆' : '★'; });
  pintarLista();
}
function pintarLista() {
  const ul = $('mi-lista');
  $('contador-lista').textContent = miLista.length;
  if (!miLista.length) { ul.innerHTML = '<li class="vacio">Guarda libros con la ☆ para ver su disponibilidad en vivo.</li>'; return; }
  ul.innerHTML = '';
  for (const id of miLista) {
    const r = inventario.porId.get(id);
    const li = document.createElement('li');
    if (!r) { li.innerHTML = '<small>Ya no figura en el inventario</small>'; ul.appendChild(li); continue; }
    const d = totalDisponibles(r);
    li.innerHTML = `<button class="item-lista"><b></b><small></small></button><span class="disp ${d ? 'ok' : ''}">${d ? `${d} disp.` : 'Prestado'}</span>`;
    li.querySelector('b').textContent = r.t;
    li.querySelector('small').textContent = [r.c, Object.keys(r.s).map(sedeCorta).join(', ')].filter(Boolean).join(' · ');
    li.querySelector('button').onclick = () => abrirDetalle(r);
    ul.appendChild(li);
  }
}
pintarLista();

// ---------------------------------------------------------------
// Filtros (sede y solo disponibles)
// ---------------------------------------------------------------
document.querySelectorAll('#filtros .filtro').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#filtros .filtro').forEach((x) => x.classList.remove('activo'));
    b.classList.add('activo');
    filtro.sede = b.dataset.sede;
    $('texto').focus();
  };
});
$('chk-disp').onchange = (e) => { filtro.soloDisp = e.target.checked; };

// ---------------------------------------------------------------
// Respuestas sin modelo (instantáneas y exactas)
// ---------------------------------------------------------------
function respuestaCharla(pregunta) {
  const q = normalizar(pregunta);
  if (/gracias/.test(q)) return '¡Con gusto! 😊 Si necesitas otro libro, aquí estoy.';
  if (/chao|adios/.test(q)) return '¡Hasta pronto! 👋 Que te vaya muy bien con tu lectura.';
  if (/quien eres|que eres|que puedes|que haces|ayuda/.test(q))
    return `Soy ${MARCA.nombre}, la asistente con inteligencia artificial de las bibliotecas de Unicórdoba 📚\n\nPuedo:\n- Buscar libros por título, autor o tema\n- Decirte cuántas copias hay ahora en Central, Lorica o Berástegui\n- Explicarte cómo encontrarlos en el estante\n- Contarte horarios y servicios de la Biblioteca Central`;
  return `¡Hola! 👋 Soy ${MARCA.nombre}. Dime un título, autor o tema y reviso el inventario en vivo. También puedes preguntarme por horarios o servicios.`;
}

function respuestaInstitucional(temas) {
  const l = [];
  if (temas.includes('horario')) {
    const e = estadoBiblioteca();
    l.push(`🕒 Horario de la ${BC.nombre}:\n- ${BC.horarioTexto.join('\n- ')}\n\nAhora mismo: **${e.texto}**. El horario publicado no incluye domingos ni festivos.`);
  }
  if (temas.includes('ubicacion')) l.push(`📍 La biblioteca está ${BC.ubicacion}.\nDirección: ${U.direccion}.`);
  if (temas.includes('servicios')) l.push(`📚 Servicios:\n- ${BC.servicios.join('\n- ')}`);
  if (temas.includes('universidad') || !l.length) l.push(`La ${U.nombre} es una ${U.tipo} ubicada en ${U.ciudad}.\n🌐 ${U.web}`);
  return l.join('\n\n');
}

function respuestaRapida(pregunta, rec, opcion, temas) {
  if (esCharla(pregunta)) return respuestaCharla(pregunta);
  if (rec.soloInst) return respuestaInstitucional(temas);
  if (opcion && rec.registros[opcion - 1]) {
    const r = rec.registros[opcion - 1];
    const d = totalDisponibles(r);
    return `📖 **${r.t}**\n👤 ${r.a || 'Sin autor registrado'}${r.i ? ` · ${r.i}` : ''}\n${d ? `✅ ${d} copia${d > 1 ? 's' : ''} disponible${d > 1 ? 's' : ''}` : '⏳ Sin copias libres ahora'}${r.c ? ` · 🔢 ${r.c}` : ''}\n\nToca la ficha para ver cómo encontrarlo.`;
  }
  if (!rec.registros.length) {
    const donde = rec.sede ? ` en ${sedeCorta(rec.sede)}` : '';
    return `No encontré resultados para «${rec.terms?.join(' ') || pregunta}»${donde} 😕\n\nPrueba con el apellido del autor, una palabra más general o quita el filtro de sede.`;
  }
  const disp = rec.registros.filter((r) => totalDisponibles(r) > 0).length;
  const donde = rec.sede ? ` en ${sedeCorta(rec.sede)}` : '';
  return `Encontré **${rec.total}** resultado${rec.total > 1 ? 's' : ''}${donde}. Aquí tienes los ${rec.registros.length} más relevantes${disp ? ` (${disp} con copias disponibles ahora)` : ''}. Toca una ficha para ver cómo encontrarlo.`;
}

// ---------------------------------------------------------------
// Acciones rápidas bajo cada respuesta
// ---------------------------------------------------------------
function pintarAcciones(caja, rec, temas) {
  const fila = document.createElement('div');
  fila.className = 'acciones';
  const boton = (txt, fn) => { const b = document.createElement('button'); b.className = 'accion'; b.textContent = txt; b.onclick = fn; fila.appendChild(b); return b; };
  const mostrados = () => caja.querySelectorAll('.ficha').length;
  if (rec.todos && rec.todos.length > mostrados()) {
    const mas = boton(`Ver más resultados (${rec.todos.length - mostrados()})`, () => {
      const desde = mostrados();
      const nuevos = rec.todos.slice(desde, desde + POR_PAGINA).map((r) => inventario.porId.get(r.id) || r);
      pintarFichas(caja.querySelector('.cuerpo'), nuevos, desde + 1);
      ultimas = { ...rec, registros: rec.todos.slice(0, desde + nuevos.length) };
      const quedan = rec.todos.length - mostrados();
      if (quedan > 0) mas.textContent = `Ver más resultados (${quedan})`; else mas.remove();
      bajar();
    });
  }
  if (rec.registros?.length && !rec.soloDisp && rec.registros.some((r) => !totalDisponibles(r))) {
    boton('Solo los disponibles', () => { $('chk-disp').checked = true; filtro.soloDisp = true; enviar(rec.consulta); });
  }
  if (rec.registros?.length) boton('¿Dónde queda la biblioteca?', () => enviar('¿Dónde queda la biblioteca?'));
  if (!rec.registros?.length && !temas.length && !esCharla(rec.consulta || '')) {
    if (filtro.sede) boton('Buscar en todas las sedes', () => { document.querySelector('#filtros .filtro[data-sede=""]').click(); enviar(rec.consulta); });
    boton('¿Qué puedo preguntarte?', () => enviar('¿Qué puedes hacer?'));
  }
  if (temas.includes('horario')) boton('¿Qué servicios tiene?', () => enviar('¿Qué servicios tiene la biblioteca?'));
  if (temas.includes('servicios') || temas.includes('ubicacion')) boton('Horario de atención', () => enviar('¿Cuál es el horario de la biblioteca?'));
  if (fila.children.length) caja.appendChild(fila);
}

function pintarMeta(contenedor, info, ref) {
  const m = document.createElement('div');
  m.className = 'meta-msg';
  m.innerHTML = `<span>${escapar(info)}</span>`;
  if (ref) {
    for (const [txt, util] of [['👍', true], ['👎', false]]) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = util ? 'Respuesta útil' : 'Respuesta incorrecta';
      b.onclick = () => { inventario.valorar(ref, util); m.querySelectorAll('button').forEach((x) => x.classList.remove('activo')); b.classList.add('activo'); toast('¡Gracias! Esto ayuda a mejorar a ' + MARCA.nombre); };
      m.appendChild(b);
    }
  }
  contenedor.appendChild(m);
}

// ---------------------------------------------------------------
// Modelo — 'servidor' (tu PC o Cloud Run) o 'navegador'
// ---------------------------------------------------------------
let infoDispositivo = null;
let worker = null;
let abortador = null;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function estadoLia(texto, ok) {
  $('estado-lia').textContent = texto;
  $('estado-lia').classList.toggle('ok', !!ok);
}
function marcarListo() { modeloListo = true; estadoLia(`✨ ${MARCA.nombre} está lista para conversar`, true); }

let URL_SERVIDOR = CONFIG.SERVIDOR_URL === 'auto' ? '' : (CONFIG.SERVIDOR_URL || '').replace(/\/+$/, '');
let conexionActual = 0;
function servidorApagado() { modeloListo = false; estadoLia('⚡ Modo rápido: te muestro las fichas al instante'); }

async function probarServidor(url, id) {
  estadoLia('Conectando…');
  for (let intento = 0; intento < 45; intento++) {
    if (id !== conexionActual) return;
    try {
      const r = await fetch(`${url}/v1/models`, { cache: 'no-store' });
      if (r.ok && id === conexionActual) { marcarListo(); return; }
    } catch { /* arrancando */ }
    await esperar(4000);
  }
  if (id === conexionActual) servidorApagado();
}

function conectarServidor() {
  if (CONFIG.SERVIDOR_URL !== 'auto') { probarServidor(URL_SERVIDOR, ++conexionActual); return; }
  inventario.escucharServidor((info) => {
    const url = info && info.activo && info.url ? info.url.replace(/\/+$/, '') : '';
    if (url && url === URL_SERVIDOR && modeloListo) return;
    URL_SERVIDOR = url;
    const id = ++conexionActual;
    if (!url) return servidorApagado();
    probarServidor(url, id);
  });
}

async function generarServidor(mensajes, burbuja) {
  abortador = new AbortController();
  let texto = '';
  try {
    const r = await fetch(`${URL_SERVIDOR}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortador.signal,
      body: JSON.stringify({
        model: 'bibliollm', messages: mensajes, stream: true,
        max_tokens: CONFIG.MAX_TOKENS_RESPUESTA, temperature: 0, repeat_penalty: 1.05,
      }),
    });
    if (!r.ok) throw new Error(`Servidor respondió ${r.status}`);
    const lector = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lineas = buffer.split('\n');
      buffer = lineas.pop();
      for (const l of lineas) {
        if (!l.startsWith('data:')) continue;
        const dato = l.slice(5).trim();
        if (dato === '[DONE]') continue;
        try {
          const trozo = JSON.parse(dato).choices?.[0]?.delta?.content;
          if (trozo) { texto += trozo; burbuja.innerHTML = markdown(texto); bajar(); }
        } catch { /* línea parcial */ }
      }
    }
    return { texto: texto.trim() };
  } catch (e) {
    if (e.name === 'AbortError') return { texto: texto.trim() || '(respuesta detenida)' };
    return { error: e.message };
  } finally { abortador = null; }
}

function crearWorker() {
  worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.tipo === 'dispositivo') infoDispositivo = data;
    else if (data.tipo === 'progreso') {
      const pct = (100 * data.cargado) / data.total;
      $('barra-relleno').style.width = pct.toFixed(1) + '%';
      $('modelo-estado').textContent = `Descargando ${(data.cargado / 1e6).toFixed(0)} / ${(data.total / 1e6).toFixed(0)} MB`;
    } else if (data.tipo === 'listo') {
      try { localStorage.setItem('bibliollm-activo', '1'); } catch {}
      $('tarjeta-modelo').classList.add('oculto');
      marcarListo();
    } else if (data.tipo === 'token' && generando?.id === data.id) {
      generando.texto += data.texto;
      generando.burbuja.innerHTML = markdown(generando.texto);
      bajar();
    } else if (data.tipo === 'fin' && generando?.id === data.id) generando.resolver({ texto: data.texto });
    else if (data.tipo === 'error') {
      if (generando && generando.id === data.id) generando.resolver({ error: data.mensaje });
      else { $('modelo-estado').textContent = 'No se pudo cargar: ' + data.mensaje; $('btn-activar').disabled = false; }
    }
  };
}
function activarModelo() {
  if (!worker) crearWorker();
  $('btn-activar').disabled = true;
  $('barra').classList.remove('oculto');
  worker.postMessage({ tipo: 'cargar', modeloId: CONFIG.MODELO_ID });
}
$('btn-activar').onclick = activarModelo;
function generarNavegador(mensajes, burbuja) {
  const id = ++contador;
  return new Promise((resolver) => {
    generando = { id, burbuja, texto: '', resolver };
    worker.postMessage({ tipo: 'generar', id, mensajes, maxTokens: CONFIG.MAX_TOKENS_RESPUESTA });
  });
}
const generarLLM = (m, b) => (CONFIG.MODO_LLM === 'servidor' ? generarServidor(m, b) : generarNavegador(m, b));
$('btn-parar').onclick = () => (CONFIG.MODO_LLM === 'servidor' ? abortador?.abort() : worker?.postMessage({ tipo: 'parar' }));

// ---------------------------------------------------------------
// Flujo principal
// ---------------------------------------------------------------
let ocupado = false;
async function enviar(pregunta) {
  pregunta = (pregunta || '').trim();
  if (!pregunta || ocupado || !inventario.idx) return;
  ocupado = true;
  detenerVoz();
  msgUsuario(pregunta);
  const caja = msgBot();
  const t0 = performance.now();

  // 1) Entender y RECUPERAR
  const charla = esCharla(pregunta);
  const opcion = detectarOpcion(pregunta);
  const temas = charla ? [] : temasInstitucionales(pregunta);
  const soloInst = esSoloInstitucional(pregunta);
  let rec;
  if (charla || soloInst) rec = { registros: [], todos: [], total: 0, soloInst };
  else if (opcion && ultimas.registros.length) {
    rec = { ...ultimas, todos: [], registros: ultimas.registros.map((r) => inventario.porId.get(r.id) || r) };
  } else {
    rec = recuperar(inventario.idx, inventario.porId, pregunta, POR_PAGINA, filtro);
    if (rec.registros.length) ultimas = rec;
  }
  rec.consulta = pregunta;
  const infoBiblio = temas.length ? contextoInstitucional(temas) : '';

  // 2) Fichas al instante
  caja.innerHTML = '';
  const burbuja = document.createElement('div');
  burbuja.className = 'burbuja';
  const cuerpo = document.createElement('div');
  cuerpo.className = 'cuerpo';
  caja.append(burbuja, cuerpo);
  if (opcion && rec.registros[opcion - 1]) pintarFichas(cuerpo, [rec.registros[opcion - 1]], opcion);
  else pintarFichas(cuerpo, rec.registros);
  bajar();

  // 3) Redactar: charla al instante; lo demás con el modelo (si está en línea)
  let texto, info;
  if (charla) {
    texto = respuestaCharla(pregunta);
    info = `💬 ${MARCA.nombre}`;
  } else if (soloInst) {
    // Horario, ubicación y servicios: directo de los datos oficiales (exacto e instantáneo)
    texto = respuestaInstitucional(temas);
    info = `🏛️ ${MARCA.nombre} · información de la biblioteca`;
  } else if (modeloListo) {
    burbuja.innerHTML = '<span class="puntos"><i></i><i></i><i></i></span>';
    burbuja.classList.add('escribiendo');
    $('btn-parar').classList.remove('oculto');
    orbeAgua.estado('pensando');
    const r = await generarLLM(construirMensajes(pregunta, rec.registros, rec.total, infoBiblio), burbuja);
    $('btn-parar').classList.add('oculto');
    burbuja.classList.remove('escribiendo');
    orbeAgua.estado('reposo');
    texto = r.error || !r.texto ? respuestaRapida(pregunta, rec, opcion, temas) : r.texto;
    info = r.error ? '⚡ Respuesta rápida' : `✨ ${MARCA.nombre} · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  } else {
    texto = respuestaRapida(pregunta, rec, opcion, temas);
    info = '⚡ Respuesta rápida';
  }
  burbuja.innerHTML = markdown(texto);
  pintarAcciones(caja, rec, temas);

  const ref = await inventario.registrarConsulta({
    pregunta: pregunta.slice(0, 500), respuesta: texto.slice(0, 4000),
    ids: rec.registros.map((r) => r.id).slice(0, 10), modelo: modeloListo ? (CONFIG.MODO_LLM === 'servidor' ? 'servidor' : CONFIG.MODELO_ID) : 'rapido',
  });
  pintarMeta(caja, info, ref);
  bajar();
  hablar(texto);
  ocupado = false;
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('texto').value;
  $('texto').value = '';
  enviar(v);
});
document.querySelectorAll('#sugerencias button').forEach((b) => (b.onclick = () => enviar(b.textContent)));

// ---------------------------------------------------------------
// Voz
// ---------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let reconocedor = null, escuchando = false, audioCtx, analizador, buf;
const orbe = $('orbe');

async function animarAudio() {
  if (!audioCtx) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new AudioContext();
      analizador = audioCtx.createAnalyser();
      analizador.fftSize = 256;
      audioCtx.createMediaStreamSource(stream).connect(analizador);
      buf = new Uint8Array(analizador.frequencyBinCount);
    } catch { return; }
  }
  const loop = () => {
    if (!escuchando) { orbeAgua.voz(0); return; }
    analizador.getByteFrequencyData(buf);
    orbeAgua.voz(buf.reduce((a, b) => a + b, 0) / buf.length / 70);
    requestAnimationFrame(loop);
  };
  loop();
}
function alternarVoz() {
  if (!SR) { $('txt-voz').textContent = 'Tu navegador no permite dictado (usa Chrome o Edge)'; return; }
  detenerVoz();
  if (escuchando) { reconocedor?.stop(); return; }
  reconocedor = new SR();
  reconocedor.lang = 'es-CO';
  reconocedor.interimResults = true;
  reconocedor.onstart = () => { escuchando = true; orbeAgua.estado('escuchando'); $('txt-voz').textContent = '¡Te escucho!…'; animarAudio(); };
  reconocedor.onresult = (e) => {
    const t = [...e.results].map((r) => r[0].transcript).join('');
    $('texto').value = t;
    if (e.results[e.results.length - 1].isFinal) { reconocedor.stop(); $('texto').value = ''; enviar(t); }
  };
  reconocedor.onend = () => { escuchando = false; orbeAgua.estado('reposo'); $('txt-voz').textContent = `Toca la esfera y habla con ${MARCA.nombre}`; };
  reconocedor.onerror = (e) => { $('txt-voz').textContent = e.error === 'not-allowed' ? 'Permite el micrófono para hablar' : 'No te escuché, intenta de nuevo'; };
  reconocedor.start();
}
orbe.onclick = alternarVoz;

let voces = [];
const cargarVoces = () => (voces = speechSynthesis.getVoices());
if ('speechSynthesis' in window) { cargarVoces(); speechSynthesis.onvoiceschanged = cargarVoces; }
function detenerVoz() { if ('speechSynthesis' in window) speechSynthesis.cancel(); if (!escuchando) orbeAgua.estado('reposo'); }
function hablar(texto) {
  if (!('speechSynthesis' in window) || !$('chk-voz').checked) return;
  let limpio = texto.replace(/\*\*/g, '').replace(/https?:\/\/\S+/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/«|»/g, '"');
  const frases = limpio.split(/(?<=[.!?:])\s+|\n+/).filter((f) => f.trim());
  limpio = '';
  for (const f of frases) { if ((limpio + f).length > 260) break; limpio += f + ' '; }
  const u = new SpeechSynthesisUtterance(limpio || frases[0] || '');
  const voz = voces.find((v) => /es[-_](CO|MX|US|419)/i.test(v.lang) && /google|natural|sabina|paulina|dalia|salome/i.test(v.name)) || voces.find((v) => v.lang.startsWith('es'));
  if (voz) u.voice = voz; else u.lang = 'es-CO';
  u.onstart = () => orbeAgua.estado('hablando');
  u.onend = () => orbeAgua.estado('reposo');
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------
const arranque = inventario.iniciar().catch((e) => { $('txt-inventario').textContent = 'Error cargando inventario'; console.error(e); });
if (CONFIG.MODO_LLM === 'servidor') arranque.then(conectarServidor);
else {
  $('tarjeta-modelo').classList.remove('oculto');
  estadoLia('Activa el modelo abajo para conversar');
  let antes = false;
  try { antes = localStorage.getItem('bibliollm-activo') === '1'; } catch {}
  if (antes) activarModelo();
}
window.__bibliollm = { inventario, enviar, normalizar };

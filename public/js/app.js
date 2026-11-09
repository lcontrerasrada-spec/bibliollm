// =====================================================================
// app.js — Orquesta la conversación:
//   pregunta → RECUPERAR fichas en vivo (rag.js) → LLM genera (worker)
//   → respuesta + fichas reales como fuente, que se actualizan solas.
// =====================================================================
import { CONFIG } from './config.js';
import { Inventario } from './datos.js';
import { recuperar, detectarOpcion, esCharla } from './rag.js';
import { construirMensajes, totalDisponibles, normalizar } from './catalogo.js';
import { OrbeAgua } from './orbe.js';

const $ = (id) => document.getElementById(id);
const historial = $('historial');
const inventario = new Inventario();
const orbeAgua = new OrbeAgua($('orbe-canvas'));

let ultimas = { registros: [], total: 0 };
let modeloListo = false;
let generando = null; // { id, burbuja, resolver }
let contador = 0;
const fichasVisibles = new Map(); // id → Set(elementos)

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
    ? `${fmt.format(inventario.porId.size)} obras · en vivo · revisado ${haceCuanto(m.ultimaRevision)}`
    : `${fmt.format(inventario.porId.size)} obras · copia del ${new Date(m.version).toLocaleDateString('es-CO')}`;
}
setInterval(pintarEstadoInventario, 30_000);

inventario.addEventListener('listo', pintarEstadoInventario);
inventario.addEventListener('meta', pintarEstadoInventario);
inventario.addEventListener('cambios', ({ detail: ids }) => {
  for (const id of ids) {
    const els = fichasVisibles.get(id);
    if (!els) continue;
    const r = inventario.porId.get(id);
    for (const el of [...els]) { // copia: el Set se modifica dentro del bucle
      if (!el.isConnected) { els.delete(el); continue; }
      const nuevo = crearFicha(r, el.dataset.n, true);
      el.replaceWith(nuevo);
      els.delete(el);
      els.add(nuevo);
    }
  }
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
// Render
// ---------------------------------------------------------------
function escapar(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const markdown = (s) => escapar(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

function bajar() { historial.scrollTop = historial.scrollHeight; }

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

function crearFicha(r, n, actualizado = false) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'ficha' + (actualizado ? ' flash' : '');
  el.dataset.id = r ? r.id : '';
  el.dataset.n = n;
  if (!r) {
    el.innerHTML = `<span class="n">${n}</span><span class="t">Esta obra ya no figura en el inventario</span>`;
    return el;
  }
  const autor = [r.a, r.i, r.y].filter(Boolean).join(' · ');
  el.innerHTML = `<span class="n">OPCIÓN ${n}${actualizado ? ' <span class="nuevo-dato">· actualizado ahora</span>' : ''}</span>
    <span class="t"></span><span class="a"></span><span class="c"></span><span class="chips"></span>`;
  el.querySelector('.t').textContent = r.t;
  el.querySelector('.a').textContent = autor || 'Sin autor registrado';
  el.querySelector('.c').textContent = [r.c, r.col].filter(Boolean).join(' · ');
  const chips = el.querySelector('.chips');
  for (const [sede, s] of Object.entries(r.s)) {
    const nombre = sede.replace(' (Montería)', '');
    const add = (cls, txt) => { const c = document.createElement('span'); c.className = 'chip ' + cls; c.textContent = txt; chips.appendChild(c); };
    add(s.d ? 'd' : '', `${nombre}: ${s.d} disp.`);
    if (s.p) add('p', `${s.p} prestado${s.p > 1 ? 's' : ''}`);
  }
  el.addEventListener('click', () => enviar(`Dame detalles de la opción ${n}`));
  if (actualizado) setTimeout(() => el.classList.remove('flash'), 2500);
  return el;
}

function pintarFichas(contenedor, registros, numeros = registros.map((_, i) => i + 1)) {
  if (!registros.length) return;
  const g = document.createElement('div');
  g.className = 'fichas';
  registros.forEach((r, i) => {
    const el = crearFicha(r, numeros[i]);
    g.appendChild(el);
    if (!fichasVisibles.has(r.id)) fichasVisibles.set(r.id, new Set());
    fichasVisibles.get(r.id).add(el);
  });
  contenedor.appendChild(g);
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
      b.onclick = () => { inventario.valorar(ref, util); m.querySelectorAll('button').forEach((x) => x.classList.remove('activo')); b.classList.add('activo'); };
      m.appendChild(b);
    }
  }
  contenedor.appendChild(m);
}

// ---------------------------------------------------------------
// Respuesta sin LLM (mientras el modelo se descarga)
// ---------------------------------------------------------------
function respuestaRapida(pregunta, rec, opcion) {
  if (esCharla(pregunta)) return '¡Hola! 👋 Pregúntame por un título, autor o tema y reviso el inventario en vivo.';
  if (opcion && rec.registros[opcion - 1]) {
    const r = rec.registros[opcion - 1];
    return `📖 **${r.t}**\n👤 ${r.a || 'Sin autor registrado'}${r.i ? `\n📝 ${r.i}` : ''}\n🏢 ${[r.e, r.l, r.y].filter(Boolean).join(', ')}\n🔢 ${r.c}\n📍 ${r.col}`;
  }
  if (!rec.registros.length) return `No encontré resultados para «${rec.terms?.join(' ') || pregunta}». Prueba con el autor u otra palabra clave.`;
  const disp = rec.registros.filter((r) => totalDisponibles(r) > 0).length;
  return `Encontré ${rec.total} resultado${rec.total > 1 ? 's' : ''}${rec.sede ? ` en ${rec.sede}` : ''}. Estas son las ${rec.registros.length} fichas más relevantes (${disp} con copias disponibles ahora):`;
}

// ---------------------------------------------------------------
// LLM — dos modos (config.js → MODO_LLM):
//  'servidor'  : el modelo corre en tu Hugging Face Space (llama.cpp).
//                El usuario NO descarga nada; la respuesta llega por streaming.
//  'navegador' : el modelo se descarga y corre en el navegador (WebGPU).
// ---------------------------------------------------------------
let infoDispositivo = null;
let worker = null;
let abortador = null;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function marcarListo(detalle) {
  modeloListo = true;
  $('barra').classList.add('oculto');
  $('btn-activar').classList.add('oculto');
  $('txt-modelo').textContent = '🧠 BiblioLLM en línea';
  $('modelo-estado').textContent = detalle;
}

// ---- Modo servidor ----
const URL_SERVIDOR = (CONFIG.SERVIDOR_URL || '').replace(/\/+$/, '');

async function conectarServidor() {
  $('btn-activar').classList.add('oculto');
  $('modelo-desc').innerHTML = 'BiblioLLM corre en <strong>nuestro servidor</strong>: no necesitas descargar nada.';
  $('txt-modelo').textContent = 'Conectando con BiblioLLM…';
  // Un Space gratis se duerme tras días sin uso; despertarlo toma ~1 min.
  for (let intento = 0; intento < 60; intento++) {
    try {
      const r = await fetch(`${URL_SERVIDOR}/v1/models`, { cache: 'no-store' });
      if (r.ok) { marcarListo('Modelo afinado · servidor propio'); return; }
    } catch { /* aún arrancando */ }
    if (intento === 1) $('modelo-estado').textContent = 'Despertando el servidor (la primera vez tarda ~1 min)…';
    await esperar(4000);
  }
  $('txt-modelo').textContent = 'Servidor no disponible';
  $('modelo-estado').textContent = 'Respondo en modo rápido mientras el servidor vuelve.';
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

// ---- Modo navegador (Web Worker + Transformers.js) ----
function crearWorker() {
  worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.tipo === 'dispositivo') {
      infoDispositivo = data;
      $('modelo-estado').textContent = data.device === 'webgpu' ? `Usando la GPU (WebGPU, ${data.dtype})` : 'Sin WebGPU: usando CPU (más lento)';
    } else if (data.tipo === 'progreso') {
      const pct = (100 * data.cargado) / data.total;
      $('barra-relleno').style.width = pct.toFixed(1) + '%';
      $('modelo-estado').textContent = `Descargando ${(data.cargado / 1e6).toFixed(0)} / ${(data.total / 1e6).toFixed(0)} MB`;
      $('txt-modelo').textContent = `Descargando modelo ${pct.toFixed(0)}%`;
    } else if (data.tipo === 'listo') {
      try { localStorage.setItem('bibliollm-activo', '1'); } catch {}
      marcarListo(`${CONFIG.MODELO_ID.split('/').pop()} · ${data.device === 'webgpu' ? 'GPU' : 'CPU'}`);
    } else if (data.tipo === 'token' && generando?.id === data.id) {
      generando.texto += data.texto;
      generando.burbuja.innerHTML = markdown(generando.texto);
      bajar();
    } else if (data.tipo === 'fin' && generando?.id === data.id) {
      generando.resolver({ texto: data.texto });
    } else if (data.tipo === 'error') {
      if (generando && generando.id === data.id) generando.resolver({ error: data.mensaje });
      else {
        $('modelo-estado').textContent = 'No se pudo cargar el modelo: ' + data.mensaje;
        $('btn-activar').disabled = false;
        $('txt-modelo').textContent = 'Modelo no disponible';
      }
    }
  };
}

function activarModelo() {
  if (!worker) crearWorker();
  $('btn-activar').disabled = true;
  $('btn-activar').textContent = 'Preparando…';
  $('barra').classList.remove('oculto');
  $('txt-modelo').textContent = 'Cargando modelo…';
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

const generarLLM = (mensajes, burbuja) =>
  CONFIG.MODO_LLM === 'servidor' ? generarServidor(mensajes, burbuja) : generarNavegador(mensajes, burbuja);
$('btn-parar').onclick = () => (CONFIG.MODO_LLM === 'servidor' ? abortador?.abort() : worker?.postMessage({ tipo: 'parar' }));

// ---------------------------------------------------------------
// Flujo principal
// ---------------------------------------------------------------
let ocupado = false;
async function enviar(pregunta) {
  pregunta = pregunta.trim();
  if (!pregunta || ocupado) return;
  if (!inventario.idx) return;
  ocupado = true;
  detenerVoz();
  msgUsuario(pregunta);
  const caja = msgBot();
  const t0 = performance.now();

  // 1) RECUPERAR (RAG) — siempre con el inventario más reciente
  const opcion = detectarOpcion(pregunta);
  let rec;
  if (esCharla(pregunta)) rec = { registros: [], total: 0 };
  else if (opcion && ultimas.registros.length) {
    // Se refrescan las fichas por si su disponibilidad cambió
    rec = { ...ultimas, registros: ultimas.registros.map((r) => inventario.porId.get(r.id) || r) };
  } else {
    rec = recuperar(inventario.idx, inventario.porId, pregunta, CONFIG.FICHAS_POR_PREGUNTA);
    if (rec.registros.length) ultimas = rec;
  }

  // 2) FUENTES PRIMERO: las fichas reales aparecen al instante (y se actualizan en vivo)
  caja.innerHTML = '';
  const burbuja = document.createElement('div');
  burbuja.className = 'burbuja';
  caja.appendChild(burbuja);
  if (opcion && rec.registros[opcion - 1]) pintarFichas(caja, [rec.registros[opcion - 1]], [opcion]);
  else pintarFichas(caja, rec.registros);
  bajar();

  // 3) GENERAR: el modelo escribe encima de las fichas mientras ya las ves
  let texto, info;
  if (modeloListo) {
    burbuja.innerHTML = '<span class="puntos"><i></i><i></i><i></i></span>';
    burbuja.classList.add('escribiendo');
    $('btn-parar').classList.remove('oculto');
    orbeAgua.estado('pensando');
    const r = await generarLLM(construirMensajes(pregunta, rec.registros, rec.total), burbuja);
    $('btn-parar').classList.add('oculto');
    burbuja.classList.remove('escribiendo');
    orbeAgua.estado('reposo');
    texto = r.error || !r.texto ? respuestaRapida(pregunta, rec, opcion) : r.texto;
    info = r.error ? '⚡ Respuesta rápida (el modelo no respondió a tiempo)' : `🧠 BiblioLLM · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  } else {
    texto = respuestaRapida(pregunta, rec, opcion);
    info = CONFIG.MODO_LLM === 'servidor' ? '⚡ Respuesta rápida (conectando con BiblioLLM…)' : '⚡ Respuesta rápida (activa BiblioLLM para respuestas conversacionales)';
  }
  burbuja.innerHTML = markdown(texto);

  const ref = await inventario.registrarConsulta({
    pregunta: pregunta.slice(0, 500), respuesta: texto.slice(0, 4000),
    ids: rec.registros.map((r) => r.id), modelo: modeloListo ? (CONFIG.MODO_LLM === 'servidor' ? 'servidor' : CONFIG.MODELO_ID) : 'rapido',
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
// Voz (reconocimiento + síntesis)
// ---------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, escuchando = false, audioCtx, analizador, buf;
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
    const prom = buf.reduce((a, b) => a + b, 0) / buf.length;
    orbeAgua.voz(prom / 70);
    requestAnimationFrame(loop);
  };
  loop();
}

function alternarVoz() {
  if (!SR) { $('txt-voz').textContent = 'Tu navegador no permite dictado (usa Chrome o Edge)'; return; }
  detenerVoz();
  if (escuchando) { rec?.stop(); return; }
  rec = new SR();
  rec.lang = 'es-CO';
  rec.interimResults = true;
  rec.onstart = () => { escuchando = true; orbe.classList.add('escuchando'); orbeAgua.estado('escuchando'); $('btn-mic-movil').classList.add('activo'); $('txt-voz').textContent = '¡Te escucho!…'; animarAudio(); };
  rec.onresult = (e) => {
    const t = [...e.results].map((r) => r[0].transcript).join('');
    $('texto').value = t;
    if (e.results[e.results.length - 1].isFinal) { rec.stop(); $('texto').value = ''; enviar(t); }
  };
  rec.onend = () => { escuchando = false; orbe.classList.remove('escuchando'); orbeAgua.estado('reposo'); $('btn-mic-movil').classList.remove('activo'); $('txt-voz').textContent = 'Toca el círculo para hablar'; };
  rec.onerror = (e) => { $('txt-voz').textContent = e.error === 'not-allowed' ? 'Permite el micrófono para hablar' : 'No te escuché, intenta de nuevo'; };
  rec.start();
}
orbe.onclick = alternarVoz;
$('btn-mic-movil').onclick = alternarVoz;

let voces = [];
const cargarVoces = () => (voces = speechSynthesis.getVoices());
if ('speechSynthesis' in window) { cargarVoces(); speechSynthesis.onvoiceschanged = cargarVoces; }

function detenerVoz() { if ('speechSynthesis' in window) speechSynthesis.cancel(); orbe.classList.remove('hablando'); if (!escuchando) orbeAgua.estado('reposo'); }

function hablar(texto) {
  if (!('speechSynthesis' in window) || !$('chk-voz').checked) return;
  let limpio = texto.replace(/\*\*/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/«|»/g, '"');
  // Solo se leen las primeras frases (la lista completa está en pantalla)
  const frases = limpio.split(/(?<=[.!?:])\s+|\n+/).filter((f) => f.trim());
  limpio = '';
  for (const f of frases) { if ((limpio + f).length > 260) break; limpio += f + ' '; }
  const u = new SpeechSynthesisUtterance(limpio || frases[0] || '');
  const voz = voces.find((v) => /es[-_](CO|MX|US|419)/i.test(v.lang) && /google|natural|sabina|paulina/i.test(v.name)) || voces.find((v) => v.lang.startsWith('es'));
  if (voz) u.voice = voz; else u.lang = 'es-CO';
  u.rate = 1.0;
  u.onstart = () => { orbe.classList.add('hablando'); orbeAgua.estado('hablando'); };
  u.onend = () => { orbe.classList.remove('hablando'); orbeAgua.estado('reposo'); };
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------
inventario.iniciar().catch((e) => { $('txt-inventario').textContent = 'Error cargando inventario'; console.error(e); });
if (CONFIG.MODO_LLM === 'servidor') {
  conectarServidor();
} else {
  let activoAntes = false;
  try { activoAntes = localStorage.getItem('bibliollm-activo') === '1'; } catch {}
  if (activoAntes) activarModelo(); // ya está en caché del navegador: carga sin descargar
}
window.__bibliollm = { inventario, enviar, normalizar };

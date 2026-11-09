#!/usr/bin/env node
// =====================================================================
// sync.mjs — Sincronizador del inventario en TIEMPO REAL
//
// 1. Descarga los 3 CSV de Janium (Unicórdoba) verificando SSL.
// 2. Agrupa por obra/edición y cuenta copias por sede y estado.
// 3. Compara con lo que hay en Firestore y escribe SOLO los shards
//    que cambiaron + un registro de "novedades".
// 4. Todas las páginas abiertas reciben el cambio al instante
//    (onSnapshot), sin recargar.
//
// Uso:
//   node sync/sync.mjs                    # una pasada (GitHub Actions)
//   node sync/sync.mjs --loop 10          # cada 10 min (PC/servidor)
//   node sync/sync.mjs --local ./csv      # usar CSV locales
//   node sync/sync.mjs --static           # además genera public/data/catalogo.json
//   node sync/sync.mjs --dry              # no escribe en Firestore
//
// Credenciales: variable FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de
// servicio) o GOOGLE_APPLICATION_CREDENTIALS (ruta al JSON). Para el
// emulador: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 y GCLOUD_PROJECT.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { Agent, ProxyAgent, fetch } from 'undici';
import {
  SEDES, URLS_FUENTE, NUM_SHARDS, construirCatalogo, repartirEnShards, textoDisponibilidad,
} from '../public/js/catalogo.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);

const log = (...m) => console.log(new Date().toISOString(), ...m);

// ---------- Descarga con la cadena SSL completa ----------
// El servidor de Unicórdoba no envía el certificado intermedio
// (GoGetSSL RSA DV SSL CA 2). En vez de desactivar la verificación
// (inseguro), lo agregamos a los certificados de confianza.
function crearDispatcher() {
  const ca = [...tls.rootCertificates, fs.readFileSync(path.join(__dir, 'gogetssl-intermedio.pem'), 'utf8')];
  if (process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) {
    ca.push(fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8'));
  }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return proxy
    ? new ProxyAgent({ uri: proxy, requestTls: { ca }, proxyTls: { ca } })
    : new Agent({ connect: { ca } });
}

async function descargarCSV(url, dispatcher) {
  const res = await fetch(url, { dispatcher, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return await res.text();
}

function parsear(texto) {
  const r = Papa.parse(texto.replace(/^﻿/, ''), { header: true, delimiter: ';', skipEmptyLines: true });
  return r.data;
}

async function obtenerFuentes() {
  const local = valor('--local');
  const fuentes = [];
  const dispatcher = local ? null : crearDispatcher();
  for (const [clave, sede] of Object.entries(SEDES)) {
    let texto;
    if (local) {
      const archivo = fs.readdirSync(local).find((f) => f.toUpperCase().includes(clave) && /\.csv$/i.test(f));
      if (!archivo) throw new Error(`No encontré el CSV de ${clave} en ${local}`);
      texto = fs.readFileSync(path.join(local, archivo), 'utf8');
    } else {
      texto = await descargarCSV(URLS_FUENTE.find((u) => u.includes(clave)), dispatcher);
    }
    const filas = parsear(texto);
    if (filas.length === 0 || !('titulo' in filas[0])) throw new Error(`CSV inválido para ${sede}`);
    fuentes.push({ sede, filas });
    log(`📥 ${sede}: ${filas.length} filas`);
  }
  return fuentes;
}

// ---------- Firestore ----------
async function abrirFirestore() {
  if (flag('--dry')) return null;
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  let opciones = {};
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    opciones = { projectId: process.env.GCLOUD_PROJECT || 'demo-bibliollm' };
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    opciones = { credential: cert(sa), projectId: sa.project_id };
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    opciones = { credential: applicationDefault() };
  } else {
    log('⚠️  Sin credenciales de Firebase: modo --dry (no se escribe nada).');
    return null;
  }
  initializeApp(opciones);
  return getFirestore();
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function compararShard(antes, despues, maxNovedades) {
  const viejo = new Map(antes.map((r) => [r.id, r]));
  const nuevo = new Map(despues.map((r) => [r.id, r]));
  const nov = [];
  for (const [id, r] of nuevo) {
    const v = viejo.get(id);
    if (!v) nov.push({ tipo: 'nuevo', id, titulo: r.t, detalle: textoDisponibilidad(r) });
    else if (JSON.stringify(v.s) !== JSON.stringify(r.s))
      nov.push({ tipo: 'disponibilidad', id, titulo: r.t, antes: textoDisponibilidad(v), detalle: textoDisponibilidad(r) });
    if (nov.length >= maxNovedades) break;
  }
  for (const [id, v] of viejo) {
    if (!nuevo.has(id) && nov.length < maxNovedades) nov.push({ tipo: 'retirado', id, titulo: v.t, detalle: 'Ya no figura en el inventario' });
  }
  return nov;
}

async function sincronizar(db) {
  const inicio = Date.now();
  const fuentes = await obtenerFuentes();
  const catalogo = construirCatalogo(fuentes);
  const shards = repartirEnShards(catalogo);
  log(`📚 ${catalogo.length} obras agrupadas en ${NUM_SHARDS} shards`);

  if (flag('--static')) {
    const destino = path.join(__dir, '..', 'public', 'data', 'catalogo.json');
    fs.writeFileSync(destino, JSON.stringify({ version: Date.now(), registros: catalogo }));
    log(`💾 Copia estática: ${destino} (${(fs.statSync(destino).size / 1e6).toFixed(1)} MB)`);
  }
  if (!db) return;

  const colShards = db.collection('catalogo_shards');
  const metaRef = db.doc('catalogo_meta/estado');
  const metaSnap = await metaRef.get();
  const metaPrevio = metaSnap.exists ? metaSnap.data() : null;

  // Protección: si la fuente trae muchísimo menos que antes (caída parcial
  // del servidor de Janium), NO borramos el inventario.
  if (metaPrevio?.total && catalogo.length < metaPrevio.total * 0.6) {
    throw new Error(`La fuente trajo ${catalogo.length} obras vs ${metaPrevio.total} antes. Se cancela por seguridad.`);
  }

  const previos = await colShards.get();
  const hashPrevio = new Map(previos.docs.map((d) => [d.id, d.data()]));
  const ahora = Date.now();
  let escritos = 0;
  const novedades = [];
  const esPrimeraCarga = previos.empty;

  // Cada shard se escribe por separado: un lote con todo superaría el
  // límite de 10 MiB por petición de Firestore.
  const escrituras = [];
  shards.forEach((regs, i) => {
    const id = String(i).padStart(2, '0');
    const data = JSON.stringify(regs);
    const h = sha(data);
    const prev = hashPrevio.get(id);
    if (prev?.hash === h) return;
    if (!esPrimeraCarga && prev) novedades.push(...compararShard(JSON.parse(prev.data), regs, 40));
    if (data.length > 1_000_000) throw new Error(`Shard ${id} supera 1 MB; sube NUM_SHARDS`);
    escrituras.push(() => colShards.doc(id).set({ data, hash: h, n: regs.length, actualizado: ahora }));
    escritos++;
  });
  for (let i = 0; i < escrituras.length; i += 4) {
    await Promise.all(escrituras.slice(i, i + 4).map((f) => f()));
  }

  const fuentesMeta = Object.fromEntries(fuentes.map((f) => [f.sede, f.filas.length]));
  await metaRef.set({
    version: ahora, total: catalogo.length, shards: NUM_SHARDS, fuentes: fuentesMeta,
    ultimaRevision: ahora, ultimoCambio: escritos ? ahora : metaPrevio?.ultimoCambio || ahora,
  });

  // Novedades (máx. 100 por pasada para cuidar la cuota gratuita)
  const novRecortadas = novedades.slice(0, 100);
  for (let i = 0; i < novRecortadas.length; i += 400) {
    const b = db.batch();
    for (const n of novRecortadas.slice(i, i + 400)) b.set(db.collection('catalogo_novedades').doc(), { ...n, ts: ahora });
    await b.commit();
  }
  log(`✅ ${escritos} shard(s) actualizados, ${novedades.length} novedad(es). ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
}

async function main() {
  const db = await abrirFirestore();
  const minutos = parseFloat(valor('--loop'));
  if (!minutos) {
    await sincronizar(db);
    return;
  }
  log(`🔁 Modo continuo: cada ${minutos} min`);
  for (;;) {
    try { await sincronizar(db); } catch (e) { log('❌', e.message); }
    await new Promise((r) => setTimeout(r, minutos * 60_000));
  }
}

main().catch((e) => { log('❌', e.message); process.exit(1); });

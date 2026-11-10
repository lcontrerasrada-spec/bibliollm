#!/usr/bin/env node
// =====================================================================
// servidor-pc/iniciar.mjs — Tu PC como servidor de BiblioLLM (gratis)
//
//  1. Arranca llama.cpp (llama-server) con el modelo en 4 bits.
//  2. Abre un túnel gratuito de Cloudflare → https://xxxx.trycloudflare.com
//  3. Publica esa dirección en Firestore (config/servidor). La web la lee
//     en tiempo real, así que no tienes que editar nada cuando cambia.
//  4. Si el túnel o el modelo se caen, los vuelve a levantar solo.
//  5. Al cerrar (Ctrl + C) marca el servidor como apagado.
//
// Uso:  npm run servidor
//       npm run servidor -- --repo usuario/bibliollm-qwen0.5b-unicordoba --archivo bibliollm-q4_k_m.gguf
// Requisitos: llama-server y cloudflared instalados (ver README).
// =====================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dir, '..');
const args = process.argv.slice(2);
const valor = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

// ---------- Configuración ----------
const archivoModelo = path.join(__dir, 'modelo.json'); // lo puedes editar tras entrenar
const guardado = fs.existsSync(archivoModelo) ? JSON.parse(fs.readFileSync(archivoModelo, 'utf8')) : {};
const REPO = valor('--repo', guardado.repo || 'Qwen/Qwen2.5-0.5B-Instruct-GGUF');
const ARCHIVO = valor('--archivo', guardado.archivo || 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
if (args.includes('--repo')) fs.writeFileSync(archivoModelo, JSON.stringify({ repo: REPO, archivo: ARCHIVO }, null, 2));
const PUERTO = parseInt(valor('--puerto', '8088'), 10);
const HILOS = parseInt(valor('--hilos', String(Math.max(2, Math.min(8, os.cpus().length - 1)))), 10);
const LLAMA = process.env.LLAMA_SERVER || 'llama-server';
const CLOUDFLARED = process.env.CLOUDFLARED || 'cloudflared';
const SOLO_LOCAL = args.includes('--sin-firestore');

const log = (...m) => console.log(new Date().toLocaleTimeString('es-CO'), ...m);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Firestore ----------
let db = null;
async function abrirFirestore() {
  if (SOLO_LOCAL) return;
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-bibliollm' });
  } else {
    const llave = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(RAIZ, 'service-account.json');
    if (!fs.existsSync(llave)) throw new Error(`No encuentro la llave ${llave}. Ponla en la carpeta del proyecto como service-account.json`);
    const sa = JSON.parse(fs.readFileSync(llave, 'utf8'));
    initializeApp({ credential: cert(sa), projectId: sa.project_id });
  }
  db = getFirestore();
}

async function publicar(datos) {
  if (!db) return;
  try {
    await db.doc('config/servidor').set({ ...datos, equipo: os.hostname(), modelo: `${REPO}/${ARCHIVO}`, actualizado: Date.now() }, { merge: true });
  } catch (e) { log('⚠️  No pude publicar en Firestore:', e.message); }
}

// ---------- Procesos hijos ----------
const hijos = new Set();
function lanzar(cmd, argumentos, alSalir) {
  const p = spawn(cmd, argumentos, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  hijos.add(p);
  p.on('error', (e) => {
    if (e.code === 'ENOENT') log(`❌ No encuentro "${cmd}". ¿Lo instalaste? (mira servidor-pc/README.md)`);
    else log(`❌ ${cmd}:`, e.message);
  });
  p.on('exit', (codigo) => { hijos.delete(p); if (!cerrando) alSalir(codigo); });
  return p;
}

async function esperarModelo() {
  for (let i = 0; i < 900; i++) { // hasta 15 min la primera vez (descarga ~400 MB)
    try {
      const r = await fetch(`http://127.0.0.1:${PUERTO}/health`);
      if (r.ok) return true;
    } catch { /* arrancando */ }
    await esperar(1000);
  }
  return false;
}

function iniciarModelo() {
  log(`🧠 Iniciando modelo ${REPO} / ${ARCHIVO} (${HILOS} hilos)…`);
  const p = lanzar(LLAMA, [
    '--hf-repo', REPO, '--hf-file', ARCHIVO,
    '--host', '127.0.0.1', '--port', String(PUERTO),
    '--alias', 'bibliollm', '-c', '4096', '-np', '2', '-t', String(HILOS),
  ], async (codigo) => {
    log(`⚠️  El modelo se detuvo (código ${codigo}). Reiniciando en 5 s…`);
    await publicar({ activo: false });
    await esperar(5000);
    iniciarModelo();
    if (await esperarModelo()) await publicar({ activo: !!urlTunel, url: urlTunel });
  });
  p.stderr.on('data', (d) => {
    const t = d.toString();
    if (/download|error|failed/i.test(t)) process.stdout.write('   ' + t.split('\n')[0].slice(0, 160) + '\n');
  });
}

let urlTunel = null;
function iniciarTunel() {
  log('🌐 Abriendo túnel de Cloudflare…');
  const p = lanzar(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PUERTO}`, '--no-autoupdate'], async (codigo) => {
    log(`⚠️  El túnel se cerró (código ${codigo}). Reabriendo en 5 s…`);
    urlTunel = null;
    await publicar({ activo: false, url: null });
    await esperar(5000);
    iniciarTunel();
  });
  const leer = async (d) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== urlTunel) {
      urlTunel = m[0];
      log(`✅ Servidor público: ${urlTunel}`);
      await publicar({ activo: true, url: urlTunel });
      log('📡 Dirección publicada en Firestore: la web ya la está usando.');
    }
  };
  p.stdout.on('data', leer);
  p.stderr.on('data', leer);
}

// ---------- Apagado limpio ----------
let cerrando = false;
async function cerrar() {
  if (cerrando) return;
  cerrando = true;
  log('🛑 Apagando servidor…');
  await publicar({ activo: false, url: null });
  for (const h of hijos) h.kill();
  process.exit(0);
}
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);

// ---------- Arranque ----------
await abrirFirestore();
iniciarModelo();
if (!(await esperarModelo())) { log('❌ El modelo no arrancó en 15 min.'); await cerrar(); }
log('🧠 Modelo listo.');
iniciarTunel();
log('Deja esta ventana abierta. Ctrl + C para apagar.');

// Latido: cada 5 min confirma en Firestore que el servidor sigue vivo
setInterval(async () => {
  try {
    const ok = (await fetch(`http://127.0.0.1:${PUERTO}/health`)).ok;
    if (ok && urlTunel) await publicar({ activo: true, url: urlTunel });
  } catch { /* el reinicio automático se encarga */ }
}, 5 * 60_000);

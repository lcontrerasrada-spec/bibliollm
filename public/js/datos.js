// =====================================================================
// datos.js — Capa de datos EN TIEMPO REAL.
// Firestore guarda el catálogo en 32 "shards". La página se suscribe con
// onSnapshot: cuando el sincronizador cambia un shard (préstamo,
// devolución, libro nuevo), Firestore empuja SOLO ese shard a todas las
// páginas abiertas y el índice de búsqueda se actualiza sin recargar.
// =====================================================================
import MiniSearch from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.js';
import { CONFIG } from './config.js';
import { crearIndice } from './rag.js';

const FB = 'https://www.gstatic.com/firebasejs/11.1.0';

export class Inventario extends EventTarget {
  constructor() {
    super();
    this.porId = new Map();
    this.idsPorShard = new Map();
    this.idx = null;
    this.meta = null;
    this.enVivo = false;
    this.db = null;
    this.fs = null;
  }

  emitir(tipo, detalle) { this.dispatchEvent(new CustomEvent(tipo, { detail: detalle })); }

  async iniciar() {
    let cfg = CONFIG.firebase;
    if (!cfg && CONFIG.USAR_EMULADOR) cfg = { projectId: 'demo-bibliollm', apiKey: 'demo-key', appId: 'demo' };
    if (cfg) {
      try { await this.iniciarFirestore(cfg); return; }
      catch (e) { console.warn('Firestore no disponible, uso copia estática:', e); }
    }
    await this.iniciarEstatico();
  }

  async iniciarEstatico() {
    const res = await fetch('data/catalogo.json');
    const { version, registros } = await res.json();
    this.idx = crearIndice(MiniSearch, registros);
    registros.forEach((r) => this.porId.set(r.id, r));
    this.meta = { version, total: registros.length, ultimaRevision: version };
    this.emitir('listo', { total: registros.length, enVivo: false });
    this.emitir('meta', this.meta);
  }

  async iniciarFirestore(cfg) {
    const { initializeApp } = await import(`${FB}/firebase-app.js`);
    const fs = await import(`${FB}/firebase-firestore.js`);
    this.fs = fs;
    const app = initializeApp(cfg);
    this.db = fs.getFirestore(app);
    if (CONFIG.USAR_EMULADOR) fs.connectFirestoreEmulator(this.db, location.hostname, 8080);

    let primera = true;
    await new Promise((resolver, rechazar) => {
      fs.onSnapshot(
        fs.collection(this.db, 'catalogo_shards'),
        (snap) => {
          if (snap.empty) return rechazar(new Error('Firestore aún no tiene catálogo (corre el sincronizador).'));
          const cambiados = [];
          for (const ch of snap.docChanges()) {
            const regs = ch.type === 'removed' ? [] : JSON.parse(ch.doc.data().data);
            if (primera) { this.cargarShardInicial(ch.doc.id, regs); continue; }
            cambiados.push(...this.reemplazarShard(ch.doc.id, regs));
          }
          if (primera) {
            primera = false;
            this.idx = crearIndice(MiniSearch, [...this.porId.values()]);
            this.enVivo = true;
            this.emitir('listo', { total: this.porId.size, enVivo: true });
            resolver();
          } else if (cambiados.length) {
            this.emitir('cambios', cambiados);
          }
        },
        (err) => (primera ? rechazar(err) : this.emitir('error', err))
      );
    });

    fs.onSnapshot(fs.doc(this.db, 'catalogo_meta/estado'), (d) => {
      if (d.exists()) { this.meta = d.data(); this.emitir('meta', this.meta); }
    });

    const q = fs.query(fs.collection(this.db, 'catalogo_novedades'), fs.orderBy('ts', 'desc'), fs.limit(12));
    fs.onSnapshot(q, (snap) => {
      this.emitir('novedades', snap.docs.map((d) => d.data()));
    });
  }

  cargarShardInicial(shardId, regs) {
    this.idsPorShard.set(shardId, new Set(regs.map((r) => r.id)));
    regs.forEach((r) => this.porId.set(r.id, r));
  }

  /** Reemplaza un shard en el índice y devuelve los ids que cambiaron. */
  reemplazarShard(shardId, regs) {
    const antes = this.idsPorShard.get(shardId) || new Set();
    const ahora = new Set(regs.map((r) => r.id));
    const cambiados = [];
    for (const id of antes) {
      if (!ahora.has(id)) { this.idx.discard(id); this.porId.delete(id); cambiados.push(id); }
    }
    for (const r of regs) {
      const previo = this.porId.get(r.id);
      if (previo && JSON.stringify(previo) === JSON.stringify(r)) continue;
      if (previo) this.idx.replace(r); else this.idx.add(r);
      this.porId.set(r.id, r);
      cambiados.push(r.id);
    }
    this.idsPorShard.set(shardId, ahora);
    return cambiados;
  }

  /** Guarda la consulta (anónima) para mejorar/reentrenar el modelo. */
  async registrarConsulta(datos) {
    if (!this.db || !CONFIG.GUARDAR_CONSULTAS) return null;
    try {
      const ref = await this.fs.addDoc(this.fs.collection(this.db, 'consultas'), { ...datos, ts: this.fs.serverTimestamp() });
      return ref;
    } catch (e) { console.warn('No se pudo registrar la consulta', e); return null; }
  }

  async valorar(ref, util) {
    if (!ref) return;
    try { await this.fs.updateDoc(ref, { util }); } catch (e) { console.warn(e); }
  }
}

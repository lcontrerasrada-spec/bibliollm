// =====================================================================
// orbe.js — Esfera de agua animada (canvas).
// Superficie con olas en capas, burbujas que suben, borde que se deforma
// como líquido y ondas expansivas. Reacciona al estado del asistente:
//   reposo · escuchando (sigue tu voz) · pensando · hablando
// =====================================================================
const ESTADOS = {
  reposo:     { vel: 1.0, ola: 5,  borde: 0.010, nivelAgua: 0.60, brillo: 0.35 },
  escuchando: { vel: 1.7, ola: 9,  borde: 0.022, nivelAgua: 0.64, brillo: 0.6 },
  pensando:   { vel: 3.2, ola: 7,  borde: 0.018, nivelAgua: 0.58, brillo: 0.5 },
  hablando:   { vel: 2.2, ola: 11, borde: 0.026, nivelAgua: 0.66, brillo: 0.7 },
};

const mezclar = (a, b, t) => a + (b - a) * t;

export class OrbeAgua {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = 0;
    this.nivelVoz = 0;           // 0..1 desde el micrófono
    this.objetivo = ESTADOS.reposo;
    this.actual = { ...ESTADOS.reposo };
    this.nombreEstado = 'reposo';
    this.burbujas = [];
    this.ondas = [];
    this.ultimaOnda = 0;
    this.reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.redimensionar();
    new ResizeObserver(() => this.redimensionar()).observe(canvas);
    let previo = performance.now();
    const cuadro = (ahora) => {
      const dt = Math.min(0.05, (ahora - previo) / 1000);
      previo = ahora;
      this.paso(dt);
      requestAnimationFrame(cuadro);
    };
    requestAnimationFrame(cuadro);
  }

  estado(nombre) {
    this.nombreEstado = nombre;
    this.objetivo = ESTADOS[nombre] || ESTADOS.reposo;
  }

  voz(nivel) { this.nivelVoz = Math.max(0, Math.min(1, nivel)); }

  redimensionar() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width, height } = this.c.getBoundingClientRect();
    this.w = width; this.h = height;
    this.c.width = Math.round(width * dpr);
    this.c.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  paso(dt) {
    const v = this.reducido ? 0.3 : 1;
    // Transición suave entre estados
    for (const k of Object.keys(this.actual)) this.actual[k] = mezclar(this.actual[k], this.objetivo[k], Math.min(1, dt * 3));
    const a = this.actual;
    const voz = this.nombreEstado === 'escuchando' ? this.nivelVoz
      : this.nombreEstado === 'hablando' ? 0.35 + 0.35 * Math.abs(Math.sin(this.t * 7.3) * Math.sin(this.t * 3.1)) : 0;
    this.t += dt * a.vel * v;

    // Ondas expansivas al escuchar / hablar
    if ((this.nombreEstado === 'escuchando' || this.nombreEstado === 'hablando') && this.t - this.ultimaOnda > 0.55 / a.vel) {
      this.ondas.push({ r: 0, vida: 1 });
      this.ultimaOnda = this.t;
    }
    // Burbujas
    if (Math.random() < dt * (3 + a.vel * 3)) {
      this.burbujas.push({ x: (Math.random() - 0.5) * 0.9, y: 0.95, r: 0.012 + Math.random() * 0.028, vy: 0.18 + Math.random() * 0.3, fase: Math.random() * 6 });
    }

    this.dibujar(a, voz, dt);
  }

  dibujar(a, voz, dt) {
    const { ctx, w, h, t } = this;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.33 * (1 + voz * 0.12);

    // Borde orgánico: radio que ondula con varias frecuencias
    const deform = a.borde + voz * 0.035;
    const forma = (ang) => R * (1 + deform * (Math.sin(ang * 3 + t * 1.7) + 0.6 * Math.sin(ang * 5 - t * 2.3) + 0.4 * Math.sin(ang * 2 + t * 0.9)));
    const trazarForma = () => {
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const ang = (i / 96) * Math.PI * 2;
        const r = forma(ang);
        const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
    };

    // Ondas expansivas (fuera de la esfera)
    this.ondas = this.ondas.filter((o) => (o.vida -= dt * 0.9) > 0);
    for (const o of this.ondas) {
      o.r += dt * R * 0.9;
      ctx.beginPath();
      ctx.arc(cx, cy, R + o.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 163, 104, ${0.35 * o.vida})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.55);
    halo.addColorStop(0, `rgba(0, 163, 104, ${0.18 + a.brillo * 0.12 + voz * 0.15})`);
    halo.addColorStop(1, 'rgba(0, 163, 104, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    trazarForma();
    ctx.clip();

    // Vidrio (fondo de la esfera)
    const vidrio = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.4, R * 0.1, cx, cy, R * 1.1);
    vidrio.addColorStop(0, '#effaf4');
    vidrio.addColorStop(0.7, '#cdeedc');
    vidrio.addColorStop(1, '#a9dfc2');
    ctx.fillStyle = vidrio;
    ctx.fillRect(cx - R * 1.3, cy - R * 1.3, R * 2.6, R * 2.6);

    // Agua: tres capas de olas
    const nivel = cy + R - 2 * R * (a.nivelAgua + 0.04 * Math.sin(t * 0.8));
    const capas = [
      { amp: 1.0, k: 1.6, vel: 1.0, fase: 0,   c1: 'rgba(52, 211, 153, 0.55)', c2: 'rgba(0, 118, 74, 0.55)' },
      { amp: 0.8, k: 2.3, vel: -1.4, fase: 2,  c1: 'rgba(16, 185, 129, 0.6)',  c2: 'rgba(0, 86, 63, 0.7)' },
      { amp: 0.6, k: 3.1, vel: 1.9, fase: 4.2, c1: 'rgba(0, 163, 104, 0.85)',  c2: 'rgba(0, 56, 42, 0.95)' },
    ];
    capas.forEach((cp, idx) => {
      const amp = (a.ola + voz * 18) * cp.amp;
      const base = nivel + idx * R * 0.08;
      ctx.beginPath();
      ctx.moveTo(cx - R * 1.3, cy + R * 1.3);
      for (let x = -1.3; x <= 1.3; x += 0.04) {
        const px = cx + x * R;
        const y = base + Math.sin(x * cp.k * Math.PI + t * cp.vel * 2 + cp.fase) * amp + Math.sin(x * 5 + t * 3.3) * amp * 0.25;
        ctx.lineTo(px, y);
      }
      ctx.lineTo(cx + R * 1.3, cy + R * 1.3);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, base - amp, 0, cy + R);
      g.addColorStop(0, cp.c1);
      g.addColorStop(1, cp.c2);
      ctx.fillStyle = g;
      ctx.fill();
    });

    // Burbujas que suben y se mecen
    this.burbujas = this.burbujas.filter((b) => b.y > -0.2);
    for (const b of this.burbujas) {
      b.y -= b.vy * dt * (0.6 + a.vel * 0.4);
      const bx = cx + (b.x + Math.sin(t * 2 + b.fase) * 0.05) * R;
      const by = cy + b.y * R;
      if (by < nivel - 4) { b.y = -1; continue; }
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(1, b.r * R), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Sombra en el borde: le da volumen de esfera
    const volumen = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 1.05);
    volumen.addColorStop(0, 'rgba(0, 56, 42, 0)');
    volumen.addColorStop(1, 'rgba(0, 56, 42, 0.35)');
    ctx.fillStyle = volumen;
    ctx.fillRect(cx - R * 1.3, cy - R * 1.3, R * 2.6, R * 2.6);

    // Reflejo de luz
    const brillo = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.45, 0, cx - R * 0.38, cy - R * 0.45, R * 0.55);
    brillo.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    brillo.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = brillo;
    ctx.fillRect(cx - R * 1.3, cy - R * 1.3, R * 2.6, R * 2.6);
    ctx.beginPath();
    ctx.ellipse(cx + R * 0.42, cy + R * 0.55, R * 0.18, R * 0.07, -0.7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fill();
    ctx.restore();

    // Borde de vidrio
    trazarForma();
    ctx.strokeStyle = 'rgba(0, 118, 74, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

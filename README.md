# 📚 BiblioLLM — Asistente con IA propia para las Bibliotecas Unicórdoba

Asistente web (texto y voz) que responde sobre el catálogo de las bibliotecas
**Central (Montería), Lorica y Berástegui** con un **modelo de lenguaje afinado por
nosotros** y con el **inventario en tiempo real** (disponibilidad y libros nuevos).

```
                 cada 5–10 min                         onSnapshot (push en vivo)
 Janium (CSV) ─────────────────►  sync.mjs  ──────►  Firestore  ─────────────────►  Web (Firebase Hosting)
 3 sedes                         (GitHub Actions    32 shards +                    ├─ RAG: MiniSearch/BM25 (fichas)
                                  o tu PC)          novedades                      └─ LLM: BiblioLLM en el navegador
                                                                                      (Transformers.js + WebGPU)
 Colab (GPU T4 gratis): dataset del catálogo → fine-tuning LoRA de Qwen2.5-0.5B → ONNX 4 bits → Hugging Face
```

## ¿Por qué fine-tuning **+** RAG? (clave para la sustentación)

| Enfoque | Problema |
|---|---|
| Solo fine-tuning (memorizar el catálogo) | El inventario cambia a cada minuto; el modelo queda desactualizado y **alucina** títulos y copias. |
| Solo RAG con un LLM genérico | Funciona, pero el modelo no es nuestro y no sigue el formato de la biblioteca. |
| **Fine-tuning + RAG (BiblioLLM)** | El modelo **aprende la habilidad** (leer fichas, responder como bibliotecario, no inventar, decir "no lo tenemos") y los **datos llegan en vivo** en cada pregunta. Un libro nuevo aparece sin reentrenar. |

Cada respuesta muestra debajo las **fichas reales** usadas como fuente; si alguien presta
o devuelve ese libro mientras miras la pantalla, la ficha se actualiza sola.

## Estructura

```
public/                 Web (Firebase Hosting)
  index.html, style.css
  js/config.js          ← ÚNICO archivo a editar (Firebase + modelo)
  js/app.js             conversación, voz, fichas en vivo
  js/datos.js           Firestore en tiempo real (o copia estática)
  js/rag.js             recuperación BM25 (compartido con el entrenamiento)
  js/catalogo.js        limpieza, agrupación y formato de fichas (compartido)
  js/orbe.js            esfera de agua animada (voz)
  js/llm-worker.js      modo opcional: el LLM dentro del navegador
servidor/               Hugging Face Space (Dockerfile con llama.cpp) que sirve el modelo
  data/catalogo.json    copia estática de respaldo
sync/sync.mjs           sincronizador Janium → Firestore (tiempo real)
entrenamiento/
  generar_dataset.mjs   crea el dataset (4.294 ejemplos, 3 fichas por pregunta) desde el catálogo
  dataset/*.jsonl       train / val / eval
  BiblioLLM_entrenamiento.ipynb   notebook de Colab (LoRA + métricas + ONNX + subida)
  exportar_onnx.py      conversión a ONNX q4 / q4f16 para el navegador
.github/workflows/      sincronización automática cada 10 min
firestore.rules         catálogo de solo lectura; consultas anónimas para reentrenar
```

---

## Puesta en marcha (≈2 horas la primera vez)

Requisitos: Node 20+ y una cuenta de Google. Todo funciona en el **plan gratis (Spark)**.

### 1. Crear el proyecto Firebase
1. [console.firebase.google.com](https://console.firebase.google.com) → *Agregar proyecto* (ej. `bibliollm-unicordoba`).
2. *Compilación → Firestore Database → Crear base de datos* → modo producción → ubicación `southamerica-east1` (o `us-east1`).
3. *⚙️ Configuración del proyecto → Tus apps → Web (`</>`)* → registra la app y copia el objeto `firebaseConfig` en `public/js/config.js` (campo `firebase`).

### 2. Instalar y subir la web
```bash
npm install
npm install -g firebase-tools
firebase login
firebase use --add            # elige tu proyecto
npm run deploy                # publica la web y las reglas de Firestore
```

### 3. Llenar Firestore con el inventario (primera vez)
*Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada* → guarda el JSON
como `service-account.json` en la carpeta del proyecto (**nunca lo subas a GitHub**; ya está en `.gitignore`).

```bash
# Windows (PowerShell)
$env:GOOGLE_APPLICATION_CREDENTIALS="service-account.json"; npm run sync
# Mac/Linux
GOOGLE_APPLICATION_CREDENTIALS=service-account.json npm run sync
```
Debe decir `✅ 32 shard(s) actualizados`. Abre tu web: el indicador dirá **"en vivo"**.

### 4. Tiempo real automático — elige una opción
- **A. GitHub Actions (gratis, recomendado):** sube el proyecto a un repositorio de GitHub →
  *Settings → Secrets and variables → Actions → New repository secret* → nombre
  `FIREBASE_SERVICE_ACCOUNT`, valor: **todo el contenido** del JSON de la cuenta de servicio.
  El flujo `Sincronizar inventario` corre cada 10 min (pestaña *Actions → Run workflow* para probarlo ya).
- **B. Un PC encendido en la biblioteca:** `npm run sync:vivo` (revisa cada 5 min).

Solo se escriben los shards que cambiaron, así que el consumo queda muy por debajo
de la cuota gratuita (≈300 escrituras/día; cada visitante gasta ~45 lecturas).

> **Sobre "tiempo real":** Janium solo publica el inventario como archivos CSV, sin avisos
> de cambios. Por eso el sistema lo **consulta cada 5–10 min**; desde que detecta un cambio,
> llega a todas las pantallas abiertas en **menos de un segundo**. Si la biblioteca habilita
> una API o webhook de Janium, basta con llamar `sync.mjs` desde ese evento.

> **SSL de Unicórdoba:** el servidor `amauta.unicordoba.edu.co` no envía su certificado
> intermedio. En lugar de desactivar la verificación (como hacía `server.js`, inseguro),
> `sync/gogetssl-intermedio.pem` completa la cadena y la conexión queda verificada.

### 5. Crear el servidor del modelo (Hugging Face Space, gratis)
Los usuarios no descargan nada: el modelo corre en tu Space y la web le envía las preguntas.
1. [huggingface.co/new-space](https://huggingface.co/new-space) → nombre `bibliollm` → SDK **Docker** (Blank) → hardware **CPU basic (gratis)** → **Public** → Create.
2. *Files → Add file → Upload files* → sube `servidor/Dockerfile` y `servidor/README.md` (reemplaza el README del Space) → Commit.
3. Espera el estado **Running** (2–4 min). Arranca con Qwen2.5-0.5B base mientras entrenas el tuyo.
4. La URL es `https://TU-USUARIO-bibliollm.hf.space`. Ponla en `SERVIDOR_URL` de `public/js/config.js` y `npm run deploy`.
5. Para que nunca se duerma: en GitHub → *Settings → Secrets and variables → Actions → Variables* → `BIBLIOLLM_SERVIDOR` = esa URL. El workflow lo visita cada 10 min.

### 6. Entrenar TU modelo (Colab, ≈50–60 min)
1. Abre [colab.research.google.com](https://colab.research.google.com) → *Subir* → `entrenamiento/BiblioLLM_entrenamiento.ipynb`.
2. *Entorno de ejecución → Cambiar tipo de entorno → **GPU T4***.
3. Crea un token **Write** en [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) y guárdalo en Colab (🔑 Secretos) como `HF_TOKEN`.
4. *Entorno de ejecución → Ejecutar todo*. Te pedirá el zip del proyecto (o pon la URL de tu repo en `REPO_GIT`).
5. Al final imprime dos variables. En tu Space → *Settings → Variables and secrets → New variable* crea `LLAMA_ARG_HF_REPO` y `LLAMA_ARG_HF_FILE` con esos valores. El Space se reinicia y responde con TU modelo; la web no se toca.

El notebook deja `metricas.csv` y `curva_perdida.png` (modelo base vs. afinado) para tu informe.
Para comparar base vs. afinado en la sustentación, crea un segundo Space con el Dockerfile sin variables (modelo base) y abre `tu-sitio.web.app/?servidor=https://TU-USUARIO-bibliollm-base.hf.space`.

### 7. Mejora continua
Cada pregunta (anónima) y su 👍/👎 se guardan en la colección `consultas`. Exporta las
marcadas 👎, corrígelas, agrégalas al dataset y vuelve a correr el notebook.
Para regenerar el dataset con el catálogo actualizado: `npm run catalogo:estatico && npm run dataset`.

---

## Detalles técnicos

- **Modelo:** Qwen2.5-0.5B-Instruct (494 M parámetros) + LoRA r=16 sobre todas las capas lineales (8,8 M parámetros entrenables, 1,75 %). Pérdida solo sobre la respuesta del asistente.
- **Dataset:** 4.294 conversaciones generadas del catálogo real con el **mismo recuperador y formato** que usa la web: búsqueda por título (con errores de tipeo), autor, tema, disponibilidad, sede, ubicación, "opción N", títulos inexistentes, charla y preguntas fuera de tema.
- **Métricas:** fidelidad (no inventa títulos), disponibilidad exacta y detección correcta de "no encontrado", antes y después del entrenamiento.
- **Servidor:** llama.cpp en un Hugging Face Space gratis (2 vCPU, 16 GB), modelo GGUF Q4_K_M (~400 MB), API compatible con OpenAI y respuesta por streaming. Las fichas se muestran al instante y el texto del modelo se escribe encima. Si el servidor no responde, la web cae a "modo rápido" con las fichas.
- **Velocidad:** 3 fichas por pregunta (menos texto que leer), máx. 220 tokens de respuesta, caché del prompt del sistema en llama.cpp y el Space se mantiene despierto con el workflow.
- **Modo navegador (opcional):** `?modo=navegador` usa el ONNX 4 bits con WebGPU (requiere `EXPORTAR_ONNX = True` en el notebook).
- **Voz:** Web Speech API (`es-CO`) para dictado y lectura en voz alta. Funciona en Chrome y Edge.
- **Privacidad:** las preguntas solo van a tu propio Space; no se envían a servicios de IA de terceros.

## Probar en local con el emulador
```bash
npm run catalogo:estatico   # copia estática (sin Firebase)
npx http-server public -p 5000          # abre http://localhost:5000
# Con tiempo real simulado:
npm run emulador                         # otra terminal:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-bibliollm npm run sync
# abre http://localhost:5000/?emulador
```

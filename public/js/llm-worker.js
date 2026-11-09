// =====================================================================
// llm-worker.js — El LLM corre AQUÍ, en un hilo aparte del navegador,
// para que la interfaz no se congele mientras el modelo "piensa".
// Transformers.js ejecuta el modelo ONNX con WebGPU (tarjeta gráfica)
// o, si no hay, con WebAssembly (CPU).
// =====================================================================
import {
  pipeline, TextStreamer, InterruptableStoppingCriteria, env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.4';

env.allowLocalModels = false;
let generador = null;
let info = null;
const parar = new InterruptableStoppingCriteria();

async function detectarDispositivo() {
  try {
    if (!self.navigator?.gpu) return { device: 'wasm', dtype: 'q4' };
    const adaptador = await navigator.gpu.requestAdapter();
    if (!adaptador) return { device: 'wasm', dtype: 'q4' };
    return { device: 'webgpu', dtype: adaptador.features.has('shader-f16') ? 'q4f16' : 'q4' };
  } catch { return { device: 'wasm', dtype: 'q4' }; }
}

async function cargar(modeloId) {
  // "local:nombre" → modelo servido por tu propio hosting en /modelos/nombre/
  if (modeloId.startsWith('local:')) {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = new URL('../modelos/', self.location.href).href;
    modeloId = modeloId.slice(6);
  }
  info = await detectarDispositivo();
  self.postMessage({ tipo: 'dispositivo', ...info });
  const archivos = new Map();
  generador = await pipeline('text-generation', modeloId, {
    device: info.device,
    dtype: info.dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        archivos.set(p.file, { cargado: p.loaded, total: p.total });
        let c = 0, t = 0;
        archivos.forEach((v) => { c += v.cargado; t += v.total; });
        self.postMessage({ tipo: 'progreso', cargado: c, total: t });
      }
    },
  });
  // Calentamiento: compila los shaders para que la 1ª respuesta sea rápida
  await generador([{ role: 'user', content: 'hola' }], { max_new_tokens: 1 });
  self.postMessage({ tipo: 'listo', ...info });
}

async function generar(id, mensajes, maxTokens) {
  parar.reset();
  let n = 0;
  const t0 = performance.now();
  const streamer = new TextStreamer(generador.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (texto) => { n++; self.postMessage({ tipo: 'token', id, texto }); },
  });
  const salida = await generador(mensajes, {
    max_new_tokens: maxTokens,
    do_sample: false,
    repetition_penalty: 1.05,
    streamer,
    stopping_criteria: parar,
  });
  const texto = salida[0].generated_text.at(-1).content;
  const seg = (performance.now() - t0) / 1000;
  self.postMessage({ tipo: 'fin', id, texto, tokensPorSeg: n / seg });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.tipo === 'cargar') await cargar(data.modeloId);
    else if (data.tipo === 'generar') await generar(data.id, data.mensajes, data.maxTokens);
    else if (data.tipo === 'parar') parar.interrupt();
  } catch (e) {
    self.postMessage({ tipo: 'error', id: data.id, mensaje: e?.message || String(e) });
  }
};

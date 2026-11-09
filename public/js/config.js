// =====================================================================
// config.js — ÚNICO archivo que debes editar para conectar tu proyecto
// =====================================================================
export const CONFIG = {
  // 1) Configuración web de Firebase
  firebase: {
    apiKey: "AIzaSyAJtwOboGNSiYW8Z4zRPgy4aW3MyyUJS_I",
    authDomain: "bibliollm-unicordoba.firebaseapp.com",
    projectId: "bibliollm-unicordoba",
    storageBucket: "bibliollm-unicordoba.firebasestorage.app",
    messagingSenderId: "320259224672",
    appId: "1:320259224672:web:4ae5ae79116986265cbf05",
    measurementId: "G-G3RLYZWQVN"
  },

  // 2) Dónde corre el modelo:
  //    'servidor'  → en tu Hugging Face Space (carpeta servidor/). El usuario NO descarga nada.
  //    'navegador' → se descarga (~0,5 GB) y corre en el navegador del usuario.
  MODO_LLM: new URLSearchParams(location.search).get('modo') || 'servidor',
  //    URL de tu Space, sin "/" al final (la cambias en la fase 6):
  SERVIDOR_URL: new URLSearchParams(location.search).get('servidor') || 'https://TU-USUARIO-bibliollm.hf.space',

  // 3) Solo para MODO_LLM = 'navegador'
  MODELO_ID: new URLSearchParams(location.search).get('modelo') || 'onnx-community/Qwen2.5-0.5B-Instruct',

  // 4) Guardar preguntas (anónimas) en Firestore para reentrenar el modelo
  GUARDAR_CONSULTAS: true,

  // Parámetros del RAG
  FICHAS_POR_PREGUNTA: 3,   // debe coincidir con K del dataset de entrenamiento
  MAX_TOKENS_RESPUESTA: 220,

  // Solo para pruebas locales con el emulador de Firestore
  USAR_EMULADOR: location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulador'),
};
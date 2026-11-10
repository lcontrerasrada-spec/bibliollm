# Tu PC como servidor de BiblioLLM (gratis, sin tarjeta)

El modelo corre en este computador con **llama.cpp** y se publica en internet con un
**túnel gratuito de Cloudflare** (no pide cuenta). La dirección del túnel cambia en cada
arranque; `iniciar.mjs` la guarda en Firestore (`config/servidor`) y la web la lee sola.

## Instalar (una vez, PowerShell)
```powershell
winget install llama.cpp
winget install --id Cloudflare.cloudflared -e
```
Cierra y abre la terminal y comprueba: `llama-server --version` y `cloudflared --version`.

Si `winget` no encuentra llama.cpp: descarga de https://github.com/ggml-org/llama.cpp/releases
el zip `llama-...-bin-win-cpu-x64.zip`, descomprímelo en `C:\llama` y antes de arrancar corre
`$env:LLAMA_SERVER="C:\llama\llama-server.exe"`.

## Encender
Requiere `service-account.json` en la carpeta del proyecto.
```powershell
npm run servidor
```
o doble clic en `iniciar-servidor.bat`. La primera vez descarga el modelo (~400 MB).
Deja la ventana abierta. `Ctrl + C` lo apaga y la web pasa a "modo rápido".

Tras entrenar en Colab (una sola vez; queda guardado en `servidor-pc/modelo.json`):
```powershell
npm run servidor -- --repo TU-USUARIO-HF/bibliollm-qwen0.5b-unicordoba --archivo bibliollm-q4_k_m.gguf
```

## Que no se apague
- Configuración → Sistema → Energía → Suspender: **Nunca** (cuando está enchufado).
- Arranque automático: `Win + R` → `shell:startup` → pega ahí un acceso directo a `iniciar-servidor.bat`.
- Si es un PC de la universidad, pide permiso a sistemas antes de dejarlo como servidor.

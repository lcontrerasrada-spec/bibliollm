---
title: BiblioLLM
emoji: 📚
colorFrom: green
colorTo: green
sdk: docker
app_port: 7860
pinned: false
short_description: Modelo de lenguaje de las Bibliotecas Unicórdoba
---

# BiblioLLM — servidor

Sirve el modelo afinado BiblioLLM (Qwen2.5-0.5B + LoRA, formato GGUF) con
[llama.cpp](https://github.com/ggml-org/llama.cpp). La web en Firebase le envía
las fichas del catálogo y la pregunta, y recibe la respuesta por streaming.

API compatible con OpenAI: `POST /v1/chat/completions`.

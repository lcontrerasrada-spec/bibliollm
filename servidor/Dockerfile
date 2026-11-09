# =====================================================================
# BiblioLLM — servidor del modelo para Hugging Face Spaces (gratis, CPU)
# llama.cpp sirve el modelo con una API compatible con OpenAI:
#   GET  /v1/models            → estado
#   POST /v1/chat/completions  → respuestas (con streaming)
#
# El modelo se elige con variables (Space → Settings → Variables):
#   LLAMA_ARG_HF_REPO = tu-usuario/bibliollm-qwen0.5b-unicordoba
#   LLAMA_ARG_HF_FILE = bibliollm-q4_k_m.gguf
# Mientras no entrenes, usa el Qwen2.5-0.5B base.
# Q4_K_M (4 bits) responde ~2x más rápido en CPU que 8 bits, con calidad casi igual.
# =====================================================================
FROM ghcr.io/ggml-org/llama.cpp:server

ENV LLAMA_CACHE=/tmp/llama-cache \
    LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=7860 \
    LLAMA_ARG_HF_REPO=Qwen/Qwen2.5-0.5B-Instruct-GGUF \
    LLAMA_ARG_HF_FILE=qwen2.5-0.5b-instruct-q4_k_m.gguf \
    LLAMA_ARG_ALIAS=bibliollm \
    LLAMA_ARG_CTX_SIZE=4096 \
    LLAMA_ARG_N_PARALLEL=2 \
    LLAMA_ARG_THREADS=2

EXPOSE 7860

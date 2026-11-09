"""
exportar_onnx.py — Convierte el modelo afinado (Hugging Face / PyTorch) a ONNX
cuantizado en 4 bits, en el formato que lee Transformers.js en el navegador.

Sigue el mismo procedimiento que el conversor oficial de Transformers.js:
  1. Exportar a ONNX con Optimum (tarea text-generation-with-past = con caché KV).
  2. q4    : pesos de las capas lineales a 4 bits (MatMulNBits, bloques de 32).
  3. q4f16 : q4 + el resto del grafo en float16 (ideal para WebGPU).

Uso:  python exportar_onnx.py <carpeta_modelo_fusionado> <carpeta_salida>
Salida:
  <salida>/config.json, tokenizer.json, ...   (archivos del tokenizador)
  <salida>/onnx/model_q4.onnx                (CPU/WASM y GPUs sin fp16)
  <salida>/onnx/model_q4f16.onnx             (WebGPU con shader-f16)
"""
import glob
import os
import shutil
import sys
import tempfile

import onnx
from onnx.external_data_helper import convert_model_to_external_data
from onnxconverter_common import float16
from onnxruntime.quantization.matmul_4bits_quantizer import MatMul4BitsQuantizer
import inspect
import torch

# PyTorch ≥2.9 usa por defecto el exportador "dynamo", que Optimum aún no
# soporta. Forzamos el exportador clásico (TorchScript) ANTES de importar Optimum.
if "dynamo" in inspect.signature(torch.onnx.export).parameters:
    _export_original = torch.onnx.export

    def _export_clasico(*args, **kwargs):
        kwargs.setdefault("dynamo", False)
        return _export_original(*args, **kwargs)

    torch.onnx.export = _export_clasico

from optimum.exporters.onnx import main_export  # noqa: E402

LIMITE = onnx.checker.MAXIMUM_PROTOBUF  # 2 GB


def guardar(modelo: onnx.ModelProto, ruta: str):
    """Guarda en un solo archivo si cabe (<2 GB); si no, con datos externos."""
    if modelo.ByteSize() < LIMITE:
        onnx.save(modelo, ruta)
    else:
        convert_model_to_external_data(modelo, all_tensors_to_one_file=True,
                                       location=os.path.basename(ruta) + "_data")
        onnx.save(modelo, ruta)


def a_fp16(modelo: onnx.ModelProto) -> onnx.ModelProto:
    m16 = float16.convert_float_to_float16(
        modelo, keep_io_types=True,
        disable_shape_infer=modelo.ByteSize() >= LIMITE,
        op_block_list=list(float16.DEFAULT_OP_BLOCK_LIST),
    )
    try:  # reordena nodos tras insertar Cast (igual que el conversor oficial)
        import onnx_graphsurgeon as gs
        g = gs.import_onnx(m16)
        g.toposort()
        m16 = gs.export_onnx(g)
    except ImportError:
        pass
    return m16


def a_q4(modelo: onnx.ModelProto) -> onnx.ModelProto:
    q = MatMul4BitsQuantizer(model=modelo, block_size=32, is_symmetric=True)
    q.process()
    return q.model.model


def exportar(origen: str, destino: str):
    os.makedirs(os.path.join(destino, "onnx"), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        print("① Exportando a ONNX (fp32)…")
        main_export(origen, output=tmp, task="text-generation-with-past", do_validation=False)
        base = os.path.join(tmp, "model.onnx")

        print("② Cuantizando q4…")
        q4 = a_q4(onnx.load(base))
        guardar(q4, os.path.join(destino, "onnx", "model_q4.onnx"))

        print("③ Cuantizando q4f16…")
        guardar(a_fp16(q4), os.path.join(destino, "onnx", "model_q4f16.onnx"))
        del q4

        for f in glob.glob(os.path.join(tmp, "*.json")) + glob.glob(os.path.join(tmp, "*.txt")):
            shutil.copy(f, destino)
    for f in glob.glob(os.path.join(origen, "*.json")) + glob.glob(os.path.join(origen, "*.txt")):
        nombre = os.path.basename(f)
        if nombre.startswith("model.safetensors"):
            continue
        if not os.path.exists(os.path.join(destino, nombre)):
            shutil.copy(f, destino)
    for f in sorted(glob.glob(os.path.join(destino, "**"), recursive=True)):
        if os.path.isfile(f):
            print(f"{os.path.getsize(f) / 1e6:9.1f} MB  {os.path.relpath(f, destino)}")


if __name__ == "__main__":
    exportar(sys.argv[1], sys.argv[2])

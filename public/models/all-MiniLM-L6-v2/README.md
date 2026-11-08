# all-MiniLM-L6-v2 (8-bit)

Sentence embedding model used on the device by Dial's accessibility understanding (`lib/access`).

- Model: [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), Apache-2.0.
- Weights taken from the npm package `@xcidos/genesis-memory-model@0.1.0-alpha.1` (fp32 ONNX, Apache-2.0) and
  quantised to int8 with `onnxruntime.quantization.quantize_dynamic` (about 23 MB).
- Served from this folder so the app works offline and nothing is fetched from a third party at runtime.

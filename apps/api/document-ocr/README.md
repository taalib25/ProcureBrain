# Local PaddleOCR worker

The API runs PP-StructureV3 locally in a long-lived Python JSON-lines worker.
It accepts PNG, JPEG, WebP, and PDF content, and returns Markdown/text per page
along with OCR confidence and layout blocks with page coordinates. Text/table
parsing stays local; the API decides whether the OCR text is sent to GLM.

## Install

Use Python 3.9 or later (Python 3.11 is the verified setup):

```bash
uv venv --python 3.11 .venv-paddleocr
uv pip install --python .venv-paddleocr/bin/python "paddlepaddle==3.2.2" \
  --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
uv pip install --python .venv-paddleocr/bin/python \
  -r apps/api/document-ocr/requirements.txt
```

Set `PADDLEOCR_PYTHON` to the environment's Python executable before starting
the API:

```bash
PADDLEOCR_PYTHON=.venv-paddleocr/bin/python pnpm --filter @procurebrain/api dev
```

The first inference downloads official PaddleX model weights to the local user
cache. Subsequent API requests reuse the worker and loaded pipeline. This
requirements set targets CPU inference. `PADDLEOCR_LANG` selects the recognition
language (default `en`); GPU use requires installing a matching PaddlePaddle GPU
build.

## Interface

Each stdin line is a JSON object with `requestId`, `mimeType`, and
`bytesBase64`. Each stdout line is exactly one JSON response. Diagnostics are
written to stderr. The worker limits individual documents to 5 MiB and returns
page-level text, layout blocks, coordinates, and recognition confidence. The
worker does not call a hosted OCR API.

The context builder is intentionally a later layer: this output preserves page
and block evidence so PO reference matching, supplier/product relationships,
and as-of-message-time event context can be composed before GLM text extraction.

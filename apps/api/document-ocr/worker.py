#!/usr/bin/env python3
"""Persistent local PP-StructureV3 JSON-lines worker for image/PDF OCR."""

from __future__ import annotations

import base64
import contextlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 5 * 1024 * 1024
SUPPORTED_MIME_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}

protocol_output = sys.stdout
pipeline: Any | None = None


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def page_result_to_json(result: Any, fallback_page_index: int) -> dict[str, Any]:
    raw = result.json
    if isinstance(raw, dict) and isinstance(raw.get("res"), dict):
        raw = raw["res"]
    if not isinstance(raw, dict):
        raise ValueError("PaddleOCR returned an invalid page result")

    markdown = result.markdown
    markdown_text = markdown.get("markdown_texts", "") if isinstance(markdown, dict) else ""
    if not isinstance(markdown_text, str):
        markdown_text = ""

    blocks = []
    for item in raw.get("parsing_res_list", []):
        if not isinstance(item, dict):
            continue
        text = item.get("block_content")
        if not isinstance(text, str) or not text.strip():
            continue
        bbox = item.get("block_bbox")
        normalized_bbox = (
            [finite_number(coordinate) for coordinate in bbox]
            if isinstance(bbox, list) and len(bbox) == 4
            else None
        )
        if normalized_bbox and any(value is None for value in normalized_bbox):
            normalized_bbox = None
        blocks.append({
            "text": text,
            "label": item.get("block_label") if isinstance(item.get("block_label"), str) else None,
            "bbox": normalized_bbox,
            "confidence": None,
        })

    ocr = raw.get("overall_ocr_res")
    scores = ocr.get("rec_scores", []) if isinstance(ocr, dict) else []
    valid_scores = [score for value in scores if (score := finite_number(value)) is not None]
    confidence = sum(valid_scores) / len(valid_scores) if valid_scores else 0.0

    page_index = raw.get("page_index")
    if isinstance(page_index, bool) or not isinstance(page_index, int):
        page_index = fallback_page_index

    return {
        "pageIndex": page_index,
        "width": finite_number(raw.get("width")),
        "height": finite_number(raw.get("height")),
        "text": markdown_text.strip() or "\n".join(block["text"] for block in blocks),
        "confidence": confidence,
        "blocks": blocks,
    }


def get_pipeline() -> Any:
    global pipeline
    if pipeline is None:
        # PP-StructureV3 is kept alive across requests to avoid reloading models.
        # Table parsing remains enabled because PO documents are table-heavy.
        from paddleocr import PPStructureV3

        with contextlib.redirect_stdout(sys.stderr):
            pipeline = PPStructureV3(
                lang=os.environ.get("PADDLEOCR_LANG", "en"),
                device=os.environ.get("PADDLEOCR_DEVICE", "cpu"),
                use_doc_orientation_classify=True,
                use_doc_unwarping=True,
                use_textline_orientation=True,
                use_seal_recognition=False,
                use_formula_recognition=False,
                use_chart_recognition=False,
            )
    return pipeline


def process(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("requestId")
    mime_type = request.get("mimeType")
    encoded = request.get("bytesBase64")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("requestId is required")
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise ValueError("Unsupported document MIME type")
    if not isinstance(encoded, str):
        raise ValueError("bytesBase64 is required")

    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("Invalid base64 document content") from error
    if not content:
        raise ValueError("Document must not be empty")
    if len(content) > MAX_INPUT_BYTES:
        raise ValueError("Document exceeds the 5 MiB limit")

    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=SUPPORTED_MIME_TYPES[mime_type], delete=False) as temporary:
            temporary.write(content)
            temporary_path = temporary.name

        with contextlib.redirect_stdout(sys.stderr):
            results = get_pipeline().predict(input=temporary_path)
        pages = [page_result_to_json(result, page_index) for page_index, result in enumerate(results)]
        pages.sort(key=lambda page: page["pageIndex"])
        text = "\n\n".join(page["text"] for page in pages if page["text"])
        total_scores = [page["confidence"] for page in pages if page["confidence"] > 0]
        confidence = sum(total_scores) / len(total_scores) if total_scores else 0.0
        return {
            "requestId": request_id,
            "mimeType": mime_type,
            "text": text,
            "confidence": confidence,
            "pages": pages,
        }
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


def main() -> int:
    for line in sys.stdin:
        request: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Request must be a JSON object")
            response = process(request)
        except Exception as error:  # Errors are returned to the caller; traceback stays local on stderr.
            request_id = request.get("requestId") if isinstance(request, dict) else None
            print(f"PaddleOCR request failed: {error}", file=sys.stderr, flush=True)
            response = {
                "requestId": request_id,
                "error": str(error) if isinstance(error, ValueError) else "PaddleOCR processing failed",
            }
        protocol_output.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        protocol_output.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

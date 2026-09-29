#!/usr/bin/env python3
"""Evaluate local PP-StructureV3 text recovery on a bounded Northwind PO sample."""

from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ARCHIVE = ROOT / "data/datasets/raw/company-documents-dataset.zip"
REFERENCE_CSV = ROOT / "data/datasets/extracted/company-documents/company-document-text.csv"


def normalized_words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.casefold()))


def normalized_text(text: str) -> str:
    return " ".join(text.casefold().split())


def load_references() -> dict[str, str]:
    references: dict[str, str] = {}
    with REFERENCE_CSV.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            if "purchase order" not in row.get("label", "").casefold():
                continue
            text = row.get("text", "")
            match = re.search(r"\border id(?:\s+[a-z]+){0,4}\s+(\d{5})\b", text, re.IGNORECASE)
            if match:
                references[match.group(1)] = text
    return references


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample-size", type=int, default=5)
    args = parser.parse_args()
    if args.sample_size < 1:
        parser.error("--sample-size must be at least 1")
    if not ARCHIVE.is_file() or not REFERENCE_CSV.is_file():
        print("Missing local dataset. See apps/api/document-ocr/README.md for dataset setup.", file=sys.stderr)
        return 2

    references = load_references()
    with zipfile.ZipFile(ARCHIVE) as archive:
        candidates = []
        for name in archive.namelist():
            match = re.search(r"PurchaseOrders/purchase_orders_(\d{5})\.pdf$", name, re.IGNORECASE)
            if match and match.group(1) in references:
                candidates.append((match.group(1), name))
        samples = candidates[: args.sample_size]
        if not samples:
            print("No purchase-order PDF/reference pairs found in the local archive.", file=sys.stderr)
            return 2

        from paddleocr import PPStructureV3

        pipeline = PPStructureV3(
            lang="en",
            device="cpu",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            use_seal_recognition=False,
            use_formula_recognition=False,
            use_chart_recognition=False,
        )
        results = []
        for order_id, member in samples:
            reference = references[order_id]
            try:
                with tempfile.NamedTemporaryFile(suffix=".pdf") as sample_file:
                    sample_file.write(archive.read(member))
                    sample_file.flush()
                    pages = pipeline.predict(input=sample_file.name)
                ocr_text = "\n".join(
                    page.markdown.get("markdown_texts", "")
                    for page in pages
                    if isinstance(page.markdown, dict)
                )
                ocr_success = bool(ocr_text.strip())
                scores = [
                    float(score)
                    for page in pages
                    for score in page.json.get("res", {}).get("overall_ocr_res", {}).get("rec_scores", [])
                ]
                confidence = statistics.mean(scores) if scores else 0
            except Exception:
                pages = []
                ocr_text = ""
                ocr_success = False
                confidence = 0

            date_match = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", reference)
            customer_match = re.search(
                r"\border id(?:\s+[a-z]+){0,4}\s+\d{5}\s+\d{4}-\d{2}-\d{2}\s+(.+?)\s+products\b",
                reference,
                re.IGNORECASE,
            )
            normalized_ocr_text = normalized_text(ocr_text)
            anchor_patterns = {
                "orderId": order_id,
                "orderDate": date_match.group(1) if date_match else None,
                "customerName": customer_match.group(1).strip() if customer_match else None,
            }
            recovered = {
                name: value is not None and normalized_text(value) in normalized_ocr_text
                for name, value in anchor_patterns.items()
            }
            normalized_ocr = normalized_words(ocr_text)
            reference_words = normalized_words(reference)
            # This is a word-overlap proxy against the dataset's supplied text,
            # not a structured-field or supplier-message accuracy benchmark.
            shared_word_count = len(normalized_ocr & reference_words)
            results.append({
                "orderId": order_id,
                "pageCount": len(pages),
                "ocrSuccess": ocr_success,
                "ocrConfidence": round(confidence, 4),
                "reviewRequiredAfterOcrFailure": not ocr_success,
                "anchorFields": recovered,
                "referenceWordRecallProxy": round(shared_word_count / len(reference_words), 4) if reference_words else 0,
            })

    field_names = results[0]["anchorFields"].keys()
    report = {
        "dataset": "AyoubChLin/CompanyDocuments (Northwind-derived)",
        "evaluationType": "OCR text recovery against dataset-provided extracted text; not structured truth",
        "sampleSize": len(results),
        "pdfOcrSuccessRate": round(sum(item["ocrSuccess"] for item in results) / len(results), 4),
        "imageSampleSize": 0,
        "imageVisionFallbackCount": None,
        "pdfVisionFallbackCount": 0,
        "pdfReviewCount": sum(item["reviewRequiredAfterOcrFailure"] for item in results),
        "imageReviewCount": None,
        "anchorFieldRecovery": {
            field: round(sum(item["anchorFields"][field] for item in results) / len(results), 4)
            for field in field_names
        },
        "meanReferenceWordRecallProxy": round(statistics.mean(item["referenceWordRecallProxy"] for item in results), 4),
        "documents": results,
        "limitation": "The supplied CSV contains dataset-extracted text, not independent structured PO gold fields; results do not measure supplier-message extraction accuracy.",
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

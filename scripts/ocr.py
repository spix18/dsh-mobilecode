#!/usr/bin/env python
"""PaddleOCR one-shot over an image; prints JSON to stdout.

Usage: python ocr.py <image.png> [lang]
Output: {"items":[{"text":str,"confidence":float,"box":[x1,y1,x2,y2]}], "error":str?}

Works with both PaddleOCR 2.x (ocr.ocr) and 3.x (ocr.predict) APIs.
The process exits after one image so the host never keeps a model resident;
PaddleOCR caches the model in ~/.paddleocr between runs.
"""
import json
import os
import sys

# Paddle 3.x PIR executor hits a oneDNN conversion bug on Windows; the CPU backend
# without mkldnn avoids it. Must be set before `import paddle`.
os.environ.setdefault("FLAGS_use_mkldnn", "0")


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing image path"}))
        return 1
    image = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "ch"
    try:
        from paddleocr import PaddleOCR
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"paddleocr import failed: {exc}"}))
        return 1

    items = []
    # enable_mkldnn=False: paddle 3.x on Windows crashes in the oneDNN PIR
    # executor (ConvertPirAttribute2RuntimeAttribute); the flag is a no-op-safe
    # on 2.x, so this single constructor keeps both stacks working (CPU only).
    # use_doc_unwarping=False (3.x only): the UVDoc unwarping model runs by
    # default and shifts coordinates on non-document images (phone screenshots
    # came out ~80px off in Y); disabling it returns pixel-accurate boxes.
    version3 = str(getattr(__import__("paddleocr"), "__version__", "")).startswith("3")
    if version3:
        ocr = PaddleOCR(lang=lang, enable_mkldnn=False, use_doc_unwarping=False)
    else:
        ocr = PaddleOCR(lang=lang, enable_mkldnn=False)
    if hasattr(ocr, "predict"):
        # PaddleOCR 3.x API.
        try:
            for result in ocr.predict(image):
                # OCRResult is a dict subclass whose dict view carries the
                # fields we need; its `.json` property has a different shape
                # ({'res': ...}), so always read the dict view first.
                data = result if isinstance(result, dict) else getattr(result, "json", result)
                if not isinstance(data, dict):
                    continue
                texts = data.get("rec_texts") or []
                scores = data.get("rec_scores") or []
                # dt_polys = list of (4,2) corner-point arrays; rec_boxes is a
                # flat [x1,y1,x2,y2] ndarray — never use `or` on an ndarray.
                boxes = data.get("dt_polys")
                if boxes is None or len(boxes) == 0:
                    boxes = data.get("rec_boxes") or []
                for text, score, box in zip(texts, scores, boxes):
                    if not text:
                        continue
                    if box is not None and len(box) == 4 and not hasattr(box[0], "__len__"):
                        flat = [float(v) for v in box]  # flat [x1,y1,x2,y2]
                    else:
                        flat = []
                        for point in box:
                            # points may be list/tuple/ndarray
                            if hasattr(point, "__len__") and len(point) >= 2:
                                flat.append(float(point[0]))
                                flat.append(float(point[1]))
                    if len(flat) < 4:
                        continue
                    xs = flat[0::2]
                    ys = flat[1::2]
                    items.append({
                        "text": str(text),
                        "confidence": round(float(score), 4),
                        "box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
                    })
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"ocr failed (3.x): {exc}"}))
            return 1
    else:
        # PaddleOCR 2.x API.
        try:
            result = ocr.ocr(image, cls=True)
            for line in result or []:
                for entry in line or []:
                    box, text_conf = entry[0], entry[1]
                    text, score = text_conf
                    if not text:
                        continue
                    xs = [float(p[0]) for p in box]
                    ys = [float(p[1]) for p in box]
                    items.append({
                        "text": str(text),
                        "confidence": round(float(score), 4),
                        "box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
                    })
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"ocr failed (2.x): {exc}"}))
            return 1

    print(json.dumps({"items": items}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

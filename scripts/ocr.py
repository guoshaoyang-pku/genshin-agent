import json, sys, time
from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()

def ocr(path, min_score=0.5):
    t0 = time.time()
    result, _ = engine(path)
    items = []
    for box, text, score in (result or []):
        if float(score) < min_score:
            continue
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        items.append({"text": text, "x1": int(min(xs)), "y1": int(min(ys)),
                      "x2": int(max(xs)), "y2": int(max(ys)), "score": round(float(score), 3)})
    items.sort(key=lambda a: (a["y1"] // 25, a["x1"]))
    return items

if __name__ == "__main__":
    path = sys.argv[1]
    min_score = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
    items = ocr(path, min_score)
    print(json.dumps(items, ensure_ascii=False))

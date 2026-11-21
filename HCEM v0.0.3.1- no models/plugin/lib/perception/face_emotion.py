# HSEmotion 人脸情绪推理（Python 侧）
# 用法：python face_emotion.py <image> <model.tflite>
# 输出：{"faces":[{"emotion":"neutral","score":0.93,"box":[x,y,w,h]}]}
import sys
import json

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter

EMOTIONS = ["anger", "contempt", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"]


def detect_faces(img):
    """用 mediapipe 检测人脸；失败时回退到整图（当作一张脸）"""
    try:
        import mediapipe as mp

        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        face_detection = mp.solutions.face_detection.FaceDetection(model_selection=0, min_detection_confidence=0.5)
        results = face_detection.process(rgb)
        boxes = []
        if results.detections:
            for det in results.detections[:5]:
                bb = det.location_data.relative_bounding_box
                x = int(bb.xmin * w)
                y = int(bb.ymin * h)
                bw = int(bb.width * w)
                bh = int(bb.height * h)
                boxes.append((x, y, bw, bh))
        face_detection.close()
        return boxes
    except Exception:
        h, w = img.shape[:2]
        return [(0, 0, w, h)]


def classify(interp, img, box):
    x, y, w, h = [int(v) for v in box]
    crop = img[max(0, y):y + h, max(0, x):x + w]
    if crop.size == 0:
        return None
    crop = cv2.resize(crop, (224, 224))
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    rgb = (rgb - mean) / std
    tensor = np.transpose(rgb, (2, 0, 1))[None, ...]
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]
    interp.set_tensor(inp["index"], tensor)
    interp.invoke()
    logits = interp.get_tensor(out["index"])[0]
    exp = np.exp(logits - logits.max())
    probs = exp / exp.sum()
    idx = int(np.argmax(probs))
    return {"emotion": EMOTIONS[idx], "score": float(probs[idx]), "box": [x, y, w, h]}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"faces": [], "error": "usage: face_emotion.py <image> <model>"}))
        return
    image_path, model_path = sys.argv[1], sys.argv[2]
    img = cv2.imread(image_path)
    if img is None:
        print(json.dumps({"faces": [], "error": "cannot read image"}))
        return
    faces = detect_faces(img)
    if len(faces) == 0:
        print(json.dumps({"faces": []}))
        return
    interp = Interpreter(model_path=model_path)
    interp.allocate_tensors()
    results = []
    for box in faces[:5]:
        r = classify(interp, img, box)
        if r:
            results.append(r)
    print(json.dumps({"faces": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()

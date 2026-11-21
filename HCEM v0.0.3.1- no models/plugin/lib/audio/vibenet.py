"""VibeNet 音乐情感（本地版 models/vibenet-main）：wav → valence/energy JSON
用法：python vibenet.py <wav>
输出：{"ok":true,"valence":0.8,"energy":0.6,"acousticness":...,"instrumentalness":...}
"""
import sys
import os
import json

HERE = os.path.dirname(os.path.abspath(__file__))
VIBENET_DIR = os.path.join(HERE, "..", "..", "..", "models", "vibenet-main")
sys.path.insert(0, VIBENET_DIR)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: python vibenet.py <wav>"}))
        return
    wav = sys.argv[1]
    try:
        import vibenet
        m = vibenet.load_model()
        r = m.predict(wav)[0]
        print(json.dumps({
            "ok": True,
            "valence": round(float(r.valence), 3),
            "energy": round(float(r.energy), 3),
            "acousticness": round(float(r.acousticness), 3),
            "instrumentalness": round(float(r.instrumentalness), 3),
        }))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:200]}))


if __name__ == "__main__":
    main()

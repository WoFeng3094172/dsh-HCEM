// HSEmotion 人脸情绪（P1）：OpenCV 人脸检测 + TFLite 情绪分类
// 依赖：Python（bundled）+ opencv-python-headless + ai-edge-litert
import { execFile } from 'node:child_process'
import '../home.mjs'
import { resolvePython } from '../audio/python.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(__dirname, '..', '..')
const MODELS_DIR = join(`${globalThis.__HCEM_HOME__}`, 'models')
const SCRIPT = join(__dirname, 'face_emotion.py')

export const EMOTIONS = ['anger', 'contempt', 'disgust', 'fear', 'happiness', 'neutral', 'sadness', 'surprise']

/**
 * 检测人脸并识别情绪
 * @param {string} imagePath 图片路径
 * @param {object} opts { python, modelsDir }
 * @returns {Promise<{ ok: boolean, faces: Array<{emotion:string,score:number,box:any}>, error?: string }>}
 */
export function detectFaceEmotion(imagePath, opts = {}) {
  // 走 HCEM 自己的 venv 优先（而不是 PATH 里随便一个 python）
  const python = opts.python || process.env.HCEM_PYTHON || resolvePython()
  const modelsDir = opts.modelsDir || MODELS_DIR
  const model = join(modelsDir, 'hsemotion', 'hsemotion_b0_fp16.tflite')
  if (!existsSync(model)) return Promise.resolve({ ok: false, faces: [], error: `model not found: ${model}` })
  if (!existsSync(SCRIPT)) return Promise.resolve({ ok: false, faces: [], error: `script not found: ${SCRIPT}` })
  return new Promise((resolve) => {
    execFile(
      python,
      [SCRIPT, imagePath, model],
      { timeout: 30000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, faces: [], error: String(error.message || error) })
          return
        }
        try {
          const data = JSON.parse(String(stdout).trim())
          resolve({ ok: true, faces: data.faces || [] })
        } catch (e) {
          resolve({ ok: false, faces: [], error: `parse error: ${String(e.message || e)}` })
        }
      },
    )
  })
}

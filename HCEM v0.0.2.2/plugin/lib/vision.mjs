// HCEM 视觉扩展点（v0.0.2）
// 规划：AI 看用户桌面、程序窗口、视频 → 生成「视觉记忆」（带 α/β/γ 与感官强度 sensory）
// v0.0.1 不实现任何真实捕获，只保留契约，调用即抛错，避免静默失败。
export const VISION_ENABLED = false

/**
 * 从一帧视觉输入生成记忆参数（未来由视觉模型/截屏服务提供）
 * @param {{ text?: string, embedding?: number[], alpha?: {H:number,S:number}, beta?: {H:number,S:number}, sensory?: number }} input
 * @returns 与 putMemory 兼容的记忆参数
 */
export function visionToMemory(input = {}) {
  return {
    text: String(input.text ?? '[视觉] 未命名画面'),
    summary: String(input.summary ?? input.text ?? '[视觉记忆]'),
    embedding: input.embedding ?? null,
    alphaH: input.alpha?.H ?? null,
    alphaS: input.alpha?.S ?? null,
    betaH: input.beta?.H ?? null,
    gammaValue: input.gamma ?? null,
    modality: 'vision',
    sensory: Math.max(0, Math.min(1, Number(input.sensory ?? 1))),
    zone: 'context',
    L: 1.0,
    level: 'full',
  }
}

/** 截取当前画面（v0.0.2 实现） */
export async function captureFrame() {
  throw new Error('vision: captureFrame 未实现（v0.0.2）')
}

/** 视觉输入 → 记忆条目（v0.0.2 实现） */
export async function ingestVisual() {
  throw new Error('vision: ingestVisual 未实现（v0.0.2）')
}
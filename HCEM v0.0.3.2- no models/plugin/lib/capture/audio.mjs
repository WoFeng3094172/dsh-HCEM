// 音频捕获（P0 接口）：真实 WASAPI loopback 后续接入（VB-CABLE / ffmpeg dshow）
// 当前为占位实现，保证 manager 与设置页可跑通
export class AudioCapture {
  constructor(opts = {}) {
    this.opts = opts
    this.running = false
  }

  start() {
    this.running = true
    return { ok: true, mode: 'placeholder', note: 'WASAPI loopback 待接入' }
  }

  stop() {
    this.running = false
    return { ok: true }
  }

  status() {
    return { running: this.running, mode: 'placeholder' }
  }
}

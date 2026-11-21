// 安装根目录解析（支持任意盘符/路径）
//
// 优先级：HCEM_HOME 环境变量 > 插件所在位置往上两级（<root>/plugin/lib → <root>）
// 数据和模型目录还可以用 HCEM_DATA_DIR / HCEM_MODELS_DIR 单独覆盖。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const HCEM_HOME = process.env.HCEM_HOME ? resolve(process.env.HCEM_HOME) : resolve(here, '../..')
export const HCEM_DATA = process.env.HCEM_DATA_DIR ? resolve(process.env.HCEM_DATA_DIR) : join(HCEM_HOME, 'data')
export const HCEM_MODELS = process.env.HCEM_MODELS_DIR ? resolve(process.env.HCEM_MODELS_DIR) : join(HCEM_HOME, 'models')
export const HCEM_TMP = join(HCEM_HOME, '.tmp')
export const HCEM_LOGS = join(HCEM_HOME, 'logs')

// 供「不 import 本模块」的地方兜底读取（例如被单独 spawn 的脚本）
globalThis.__HCEM_HOME__ = HCEM_HOME
globalThis.__HCEM_DATA__ = HCEM_DATA
globalThis.__HCEM_MODELS__ = HCEM_MODELS
globalThis.__HCEM_TMP__ = HCEM_TMP

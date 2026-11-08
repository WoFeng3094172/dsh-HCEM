import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

// 从 HuggingFace 国内镜像下载模型（hf-mirror.com 已验证可通）
env.remoteHost = 'https://hf-mirror.com';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.allowRemoteModels = true;
env.cacheDir = 'E:/HCEM/HCEM v0.0.2/embedding-service/.cache';

const MODEL = 'Xenova/bge-small-zh-v1.5';
const PORT = Number(process.env.HCEM_EMBED_PORT || 8081);
const ONNX_DIR = 'E:/HCEM/HCEM v0.0.2/embedding-service/.cache/Xenova/bge-small-zh-v1.5/onnx';
const HAS_QUANTIZED = existsSync(join(ONNX_DIR, 'model_quantized.onnx'));

console.log(`[embedding] loading model ${MODEL} (${HAS_QUANTIZED ? 'q8 quantized' : 'fp32'}) ...`);
const extractor = await pipeline('feature-extraction', MODEL, HAS_QUANTIZED ? { dtype: 'q8' } : {});
console.log('[embedding] model loaded');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: MODEL }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  try {
    const body = JSON.parse(await readBody(req));
    const input = body.input;
    const inputs = Array.isArray(input) ? input : [input];
    const data = [];
    for (let i = 0; i < inputs.length; i++) {
      const out = await extractor(String(inputs[i]), { pooling: 'mean', normalize: true });
      data.push({ object: 'embedding', index: i, embedding: Array.from(out.data) });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data, model: MODEL }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[embedding] listening on http://127.0.0.1:${PORT}/v1/embeddings`);
});

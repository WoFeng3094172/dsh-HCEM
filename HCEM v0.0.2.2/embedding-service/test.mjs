const res = await fetch('http://127.0.0.1:8081/v1/embeddings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ input: ['你好，鲸鲸今天很开心。', 'Hello world'] }),
});
const j = await res.json();
if (!res.ok) {
  console.log('HTTP', res.status, JSON.stringify(j));
  process.exit(1);
}
console.log('status', res.status, 'model', j.model);
for (const d of j.data) {
  console.log('index', d.index, 'dim', d.embedding.length, 'head', d.embedding.slice(0, 4).map((x) => x.toFixed(4)));
}

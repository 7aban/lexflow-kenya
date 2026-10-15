import { createServer } from 'vite';
if (!process.env.LEXFLOW_104B_WORK) throw new Error('Isolated timer validation required');
const server = await createServer({ server: { host: '127.0.0.1', port: 5184, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5294', changeOrigin: true } } } });
await server.listen();
console.log('Synthetic timer UI: http://127.0.0.1:5184');

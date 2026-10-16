import { createServer } from 'vite';
if (!process.env.LEXFLOW_DS1A_EVIDENCE) throw new Error('Synthetic DS1A validation required');
const server = await createServer({ server: { host: '127.0.0.1', port: 5187, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5297', changeOrigin: true } } } });
await server.listen();

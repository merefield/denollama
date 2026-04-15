import { createApp } from './app.ts';

const port = Number(Deno.env.get('PORT') ?? '5000');
const app = createApp({
  apiKey: Deno.env.get('API_KEY') ?? '',
});

console.log(`Starting Deno server on http://localhost:${port}`);
console.log('Ollama host: http://localhost:11434');

Deno.serve({ port }, app.fetch);

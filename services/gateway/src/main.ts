import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(config);
await app.listen({ port: config.port, host: '0.0.0.0' });

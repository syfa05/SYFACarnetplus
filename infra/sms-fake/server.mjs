// Faux prestataire SMS pour le développement : journalise, n'envoie rien.
import { createServer } from 'node:http';

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(`[sms-fake] ${req.method} ${req.url} ${body}`);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
}).listen(8090, () => console.log('[sms-fake] écoute sur :8090'));

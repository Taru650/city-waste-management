// Transparent HTTP proxy between ZAP and the API that records what the scan actually exercised:
// method, path template, status. A clean DAST report means little if every request was a 401.
//   node log-proxy.mjs <listenPort> <targetPort> <out.csv>
import { createWriteStream } from 'node:fs';
import http from 'node:http';

const [listen, target, outFile] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const out = createWriteStream(outFile, { flags: 'w' });
out.write('method,path,status,auth\n');
const template = (url) => url.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (r) => {
    out.write(`${req.method},${template(req.url)},${r.statusCode},${req.headers.authorization ? req.headers.authorization.slice(0, 16).replace(/,/g, ' ') : 'none'}\n`);
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(listen, '127.0.0.1');

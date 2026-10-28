import { createServer, Server } from 'net';

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Minimal clamd stand-in speaking the INSTREAM protocol; flags anything containing the EICAR string. */
export function fakeClamd(): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = 'zINSTREAM\0';
      if (buf.length < cmd.length) return;
      let off = cmd.length;
      const chunks: Buffer[] = [];
      while (buf.length >= off + 4) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          const body = Buffer.concat(chunks);
          received.push(body);
          sock.end(body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < off + 4 + len) return;
        chunks.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, received })));
}

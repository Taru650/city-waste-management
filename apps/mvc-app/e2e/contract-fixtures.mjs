// Writes the few facts the Dart contract test needs about the freshly seeded demo database.
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { appEnv, PASSWORD } from './env.mjs';

const out = process.argv[2];
const c = await mysql.createConnection({ host: appEnv.DB_HOST, port: Number(appEnv.DB_PORT), user: appEnv.DB_USER, password: appEnv.DB_PASSWORD, database: appEnv.DB_NAME });
// A ward of the first demo ULB that belongs to Supervisor North's area, and its centre.
const [[site]] = await c.query(
  `SELECT w.number, ST_AsGeoJSON(b.geom) AS gj
     FROM wards w JOIN ward_boundaries b ON b.ward_id = w.id JOIN areas a ON a.id = w.area_id JOIN users s ON s.id = a.supervisor_id JOIN ulbs u ON u.id = w.ulb_id
    WHERE u.lgd_code = 800001 AND s.name LIKE '%(Supervisor, North)%' ORDER BY w.number LIMIT 1`);
const [[home]] = await c.query(`SELECT w.id FROM wards w JOIN ulbs u ON u.id = w.ulb_id WHERE u.lgd_code = 800001 ORDER BY w.number DESC LIMIT 1`);
await c.end();
// MySQL has no centroid for geographic shapes: average the outer ring (a ward is a simple rectangle here).
const gj = typeof site.gj === 'string' ? JSON.parse(site.gj) : site.gj; // the driver may already have parsed it
const ring = gj.coordinates[0].slice(0, -1);
const mean = (i) => ring.reduce((a, p) => a + p[i], 0) / ring.length;
const [a, b] = [mean(0), mean(1)];
const [lat, lng] = Math.abs(a) <= 90 && Math.abs(b) > 90 ? [a, b] : Math.abs(a) > Math.abs(b) ? [b, a] : [a, b]; // whichever order MySQL printed
writeFileSync(out, JSON.stringify({
  password: PASSWORD, supervisor: '9000000004', worker: '9000000006', subAdmin: '9000000003',
  site: { lat, lng, wardNumber: site.number }, homeWardId: home.id,
}));

import type { Knex } from 'knex';
import { one, run } from '@/db/sql';
import { DEMO_PASSWORD, DEMO_USERS, ensureUser } from '@/db/seed-helpers';
import { consentNoticeVersion } from '@/lib/notice';
import { newId } from '@/lib/ids';

/** One login for every role (listed in README.md, all with the same demo password). Safe to run again. */
export async function seed(knex: Knex): Promise<void> {
  const row = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(knex, sql, params))?.id as string;
  const districts = { ONE: await row(`SELECT id FROM districts WHERE lgd_code = 1001`), TWO: await row(`SELECT id FROM districts WHERE lgd_code = 1002`) };
  const ulbs = {
    A: await row(`SELECT id FROM ulbs WHERE lgd_code = 800001`),
    B: await row(`SELECT id FROM ulbs WHERE lgd_code = 800002`),
    C: await row(`SELECT id FROM ulbs WHERE lgd_code = 800101`),
  };
  const areas = {
    NORTH: await row(`SELECT id FROM areas WHERE ulb_id = ? AND name = 'North Zone'`, [ulbs.A]),
    SOUTH: await row(`SELECT id FROM areas WHERE ulb_id = ? AND name = 'South Zone'`, [ulbs.A]),
  };
  const ulbDistrict = { A: districts.ONE, B: districts.ONE, C: districts.TWO };

  const ids: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const base = { role: u.role, status: 'ACTIVE' as const, name: u.name, mobile: u.mobile, email: u.email, password: DEMO_PASSWORD, preferredLanguage: 'en' as const };
    if (u.role === 'CITIZEN') {
      const wardId = await row(`SELECT w.id FROM wards w WHERE w.ulb_id = ? AND w.number = ?`, [ulbs.A, u.ward ?? 1]);
      ids[u.key] = await ensureUser(knex, { ...base, homeDistrictId: districts.ONE, homeUlbId: ulbs.A, homeWardId: wardId });
      // Demo citizens have accepted the privacy notice (a real citizen does this at registration).
      const has = await one(knex, `SELECT 1 AS x FROM consents WHERE user_id = ? AND notice_version = ?`, [ids[u.key], consentNoticeVersion()]);
      if (!has) await run(knex, `INSERT INTO consents (id, user_id, purpose, notice_version, language) VALUES (?,?,?,?,?)`, [newId(), ids[u.key], 'GRIEVANCE_SERVICE', consentNoticeVersion(), 'en']);
    } else if (u.role === 'WEB_ADMIN') {
      ids[u.key] = await ensureUser(knex, base);
    } else if (u.role === 'DISTRICT_ADMIN') {
      ids[u.key] = await ensureUser(knex, { ...base, districtId: districts[u.district ?? 'ONE'] });
    } else {
      const ulbKey = u.ulb ?? 'A';
      ids[u.key] = await ensureUser(knex, { ...base, districtId: ulbDistrict[ulbKey], ulbId: ulbs[ulbKey], areaId: u.area ? areas[u.area] : null });
    }
  }
  // Each supervisor runs their area.
  await run(knex, `UPDATE areas SET supervisor_id = ? WHERE id = ? AND supervisor_id IS NULL`, [ids.supervisorNorth, areas.NORTH]);
  await run(knex, `UPDATE areas SET supervisor_id = ? WHERE id = ? AND supervisor_id IS NULL`, [ids.supervisorSouth, areas.SOUTH]);

  const n = await one<{ n: number }>(knex, `SELECT COUNT(*) AS n FROM users`);
  console.log(`  users: ${n?.n} accounts (password for every demo account: ${DEMO_PASSWORD})`);
}

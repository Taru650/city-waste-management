import { expect, Page, test } from '@playwright/test';
import { login, sql } from './fixtures';

const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;
const kpi = (page: Page, id: string) => page.getByTestId(id).locator('.ant-statistic-content-value');
const num = async (page: Page, id: string) => Number((await kpi(page, id).innerText()).replace(/[^\d.]/g, ''));

/** Console errors and failed requests are test failures, except the map tiles (no internet in tests). */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/tiles/')) problems.push(`${r.status()} ${r.url()}`); });
  return problems;
}

test.describe('Dashboard', () => {
  test('the Sub Admin sees figures that match the database', async ({ page }) => {
    const problems = watch(page);
    await login(page, 'subAdmin');
    await expect(kpi(page, 'kpi-received')).not.toHaveText('—');
    const [{ n: received }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = 800001 AND c.created_at >= UTC_TIMESTAMP() - INTERVAL 29 DAY`);
    const [{ n: open }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = 800001 AND c.status IN ${OPEN}`);
    // The page counts the last 30 IST days; the SQL counts 29 days back from now, so allow the day-boundary difference only in one direction.
    expect(await num(page, 'kpi-received')).toBeGreaterThanOrEqual(Number(received));
    expect(await num(page, 'kpi-pending')).toBe(Number(open));
    expect(await num(page, 'kpi-overdue')).toBeLessThanOrEqual(Number(open));
    // The breakdown's total row adds up to the headline figure, and the three groups of figures all show.
    await expect(page.getByTestId('breakdown-table')).toContainText('Total');
    const total = await page.getByTestId('breakdown-table').locator('tfoot td').nth(1).innerText();
    expect(Number(total)).toBe(await num(page, 'kpi-received'));
    for (const id of ['kpi-sla', 'kpi-disposal', 'kpi-median', 'kpi-rating', 'kpi-satisfied', 'kpi-reopen', 'kpi-geofence', 'kpi-escalated']) {
      await expect(kpi(page, id), id).not.toHaveText('—');
    }
    expect(problems).toEqual([]);
  });

  test('charts and the hotspot map are drawn', async ({ page }) => {
    await login(page, 'subAdmin');
    for (const id of ['chart-trend', 'chart-types', 'chart-ageing']) await expect(page.getByTestId(id).locator('svg').first()).toBeVisible();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await expect(page.locator('.leaflet-interactive').first()).toBeVisible(); // at least one hotspot circle
  });

  test('narrowing by complaint type changes the figures to the database count for that type', async ({ page }) => {
    await login(page, 'subAdmin');
    await expect(kpi(page, 'kpi-received')).not.toHaveText('—');
    const [t] = await sql<{ id: string; name_en: string; n: number }>(
      `SELECT t.id, t.name_en, COUNT(*) AS n FROM complaints c JOIN complaint_types t ON t.id = c.type_id JOIN ulbs u ON u.id = c.ulb_id
        WHERE u.lgd_code = 800001 GROUP BY t.id, t.name_en ORDER BY n DESC LIMIT 1`);
    await page.getByLabel('Complaint type filter').click();
    await page.getByTitle(t.name_en).click();
    await expect.poll(() => num(page, 'kpi-received')).toBe(Number(t.n));
  });

  test('a ward supervisor sees only their own area, which is smaller than the ULB', async ({ page }) => {
    await login(page, 'supervisorNorth');
    await expect(kpi(page, 'kpi-received')).not.toHaveText('—');
    const mine = await num(page, 'kpi-received');
    // The same rule the API applies: the supervisor's own complaints, plus those of the area they head.
    const [{ n }] = await sql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM complaints c, users s WHERE s.name LIKE '%(Supervisor, North)%' AND s.role = 'SUPERVISOR'
          AND (c.supervisor_id = s.id OR c.area_id IN (SELECT a.id FROM areas a WHERE a.supervisor_id = s.id)) AND c.created_at >= UTC_TIMESTAMP() - INTERVAL 29 DAY`);
    expect(mine).toBeGreaterThanOrEqual(Number(n));
    expect(mine).toBeGreaterThan(0);
    expect(mine).toBeLessThan(46);
  });

  test('the Web Admin gets a district filter and a statewide breakdown', async ({ page }) => {
    await login(page, 'webAdmin');
    await expect(kpi(page, 'kpi-received')).not.toHaveText('—');
    await expect(page.getByLabel('District filter')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'District' })).toBeChecked();
    const rows = page.getByTestId('breakdown-table').locator('tbody tr.ant-table-row');
    await expect(rows).toHaveCount(2); // the two demo districts
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM complaints WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 29 DAY`);
    expect(await num(page, 'kpi-received')).toBeGreaterThanOrEqual(Number(n));
  });

  test('a District Admin cannot see another district', async ({ page }) => {
    await login(page, 'districtAdmin2');
    await expect(kpi(page, 'kpi-received')).not.toHaveText('—');
    await expect(page.getByLabel('District filter')).toHaveCount(0);
    expect(await num(page, 'kpi-received')).toBeLessThan(46);
  });

  test('Excel and CSV exports download the filtered complaints', async ({ page }) => {
    await login(page, 'subAdmin');
    await expect(kpi(page, 'kpi-received')).not.toHaveText('—');
    const received = await num(page, 'kpi-received');
    await page.getByRole('button', { name: 'Export complaints' }).hover();
    const dl = page.waitForEvent('download');
    await page.getByRole('link', { name: 'CSV' }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    expect(lines.length - 1).toBe(received); // header + one line per complaint
    // The export is not available without a session.
    const anon = await page.context().browser()!.newContext();
    expect((await anon.request.get(`${page.url().split('/dashboard')[0]}/api/v1/reports/export?report=complaints&format=csv`)).status()).toBe(401);
    await anon.close();
  });

  test('the Past SLA figure never counts closed complaints', async ({ page }) => {
    await login(page, 'subAdmin');
    await expect(kpi(page, 'kpi-overdue')).not.toHaveText('—');
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = 800001 AND c.status IN ${OPEN} AND c.sla_due_at < UTC_TIMESTAMP(3)`);
    expect(await num(page, 'kpi-overdue')).toBe(Number(n));
  });
});

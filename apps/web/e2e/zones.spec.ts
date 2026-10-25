import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { login, seed, sql } from './fixtures';

const FORMAT = 'DD MMM YYYY, HH:mm';

test.describe('Event zones (M8)', () => {
  test('Sub Admin creates an event zone in the browser; its drawer and dashboard show the zone complaints', async ({ page }, info) => {
    mkdirSync(info.outputDir, { recursive: true });
    const file = join(info.outputDir, 'mela.geojson');
    // Inside ward A1 (25.00–25.01 N, 80.00–80.01 E).
    writeFileSync(file, JSON.stringify({ type: 'Polygon', coordinates: [[[80.002, 25.002], [80.006, 25.002], [80.006, 25.006], [80.002, 25.006], [80.002, 25.002]]] }));

    await login(page, 'subAdminA');
    await page.goto('/event-zones');
    await page.getByTestId('new-zone').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Rajim Mela E2E');
    const start = dialog.locator('.ant-picker-range input').nth(0);
    const end = dialog.locator('.ant-picker-range input').nth(1);
    await start.click();
    await start.fill(dayjs().subtract(1, 'hour').format(FORMAT));
    await start.press('Enter');
    await end.fill(dayjs().add(2, 'day').format(FORMAT));
    await end.press('Enter');
    await dialog.getByLabel('Zone supervisor').click();
    await page.getByTitle('Ramesh Supervisor').click();
    await dialog.getByLabel('Deadline hours').fill('4');
    await dialog.locator('input[type=file]').setInputFiles(file);
    await expect(dialog.locator('.leaflet-container')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Event zone saved')).toBeVisible();
    const row = page.getByTestId('zones-table').locator('tr', { hasText: 'Rajim Mela E2E' });
    await expect(row.getByText('Running')).toBeVisible();
    await expect(row.getByText('4 h')).toBeVisible();

    // A complaint filed inside the zone (seeded directly, the routing rule itself is covered by the API tests).
    const [z] = await sql<{ id: string }>(`SELECT id FROM event_zones WHERE name = 'Rajim Mela E2E'`);
    const { users, wards } = seed();
    const [type] = await sql<{ id: string }>(`SELECT id FROM complaint_types WHERE code = 'GARBAGE_HEAP'`);
    const [c] = await sql<{ id: string }>(
      `INSERT INTO complaints (complaint_no, citizen_id, district_id, ulb_id, ward_id, ward_source, type_id, description, location, status,
                               sla_due_at, supervisor_id, event_zone_id)
       SELECT '9901990001' || to_char(now(), 'YY') || '99' || lpad((floor(random()*9000)+1000)::text, 4, '0'), $1, u.district_id, u.id, $2, 'GPS', $3, 'Mela gate garbage',
              ST_SetSRID(ST_MakePoint(80.004, 25.004), 4326), 'ASSIGNED', now() + interval '4 hours', $4, $5
         FROM ulbs u WHERE u.id = $6 RETURNING id`,
      [users.citizen.id, wards.A1, type.id, users.supervisorA.id, z.id, seed().ulbs.A],
    );
    expect(c.id).toBeTruthy();

    await row.getByText('Rajim Mela E2E').click();
    await expect(page.getByTestId('zone-stats')).toHaveText(/1 total · 1 open/);
    await page.getByRole('button', { name: 'Open dashboard' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?eventZoneId=${z.id}`));
    await expect(page.getByLabel('Event zone filter').locator('..')).toContainText('Event: Rajim Mela E2E');
    await expect(page.getByTestId('kpi-received')).toContainText('1');
  });

  test('Sub Admin adds temporary event staff; the staff list shows when access ends', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto('/users');
    await page.getByRole('button', { name: 'Add staff' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill('Mela Helper');
    await dialog.getByLabel('Mobile').fill('9199999950');
    const ends = dayjs().add(5, 'day').hour(18).minute(0);
    const input = dialog.getByLabel('Access ends');
    await input.click();
    await input.fill(ends.format('DD MMM YYYY, HH:mm'));
    await input.press('Enter');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    const row = page.getByTestId('staff-table').locator('tr', { hasText: 'Mela Helper' });
    await expect(row.getByText(`Temporary until ${ends.format('DD MMM, HH:mm')}`)).toBeVisible();
    const [u] = await sql<{ access_expires_at: Date }>(`SELECT access_expires_at FROM users WHERE name = 'Mela Helper'`);
    expect(dayjs(u.access_expires_at).format('YYYY-MM-DD HH:mm')).toBe(ends.format('YYYY-MM-DD HH:mm'));
  });
});

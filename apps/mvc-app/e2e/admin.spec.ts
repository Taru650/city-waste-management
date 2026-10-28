import { APIRequestContext, expect, Page, test } from '@playwright/test';
import { login, sql } from './fixtures';

const ULB_A = 800001;
type Geometry = { type: string; coordinates: number[][][] };

const ulbIdA = async () => (await sql<{ id: string }>(`SELECT id FROM ulbs WHERE lgd_code = ${ULB_A}`))[0].id;

/** Ward boundaries as the API serves them (the same GeoJSON the map draws). */
async function wardGeometry(page: Page, number: number): Promise<Geometry> {
  const res = await page.request.get(`/api/v1/masters/ulbs/${await ulbIdA()}/boundaries`);
  const fc = await res.json();
  return fc.features.find((f: { properties: { number: number } }) => f.properties.number === number).geometry;
}
const shift = (g: Geometry, dLat: number, dLng = 0): Geometry => ({ ...g, coordinates: g.coordinates.map((ring) => ring.map(([x, y]) => [x + dLng, y + dLat])) });
const geojson = (g: unknown) => ({ name: 'boundary.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(g)) });
const centroid = (g: Geometry) => {
  const pts = g.coordinates[0];
  return { lng: pts.reduce((a, p) => a + p[0], 0) / pts.length, lat: pts.reduce((a, p) => a + p[1], 0) / pts.length };
};

/** Creates a worker through the same API the Staff page uses (the page itself is tested separately). */
async function createWorker(page: Page, name: string, mobile: string): Promise<{ tempPassword: string }> {
  return page.evaluate(async ([n, m]) => {
    const r = await fetch('/api/v1/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cwm-csrf': '1' }, credentials: 'same-origin',
      body: JSON.stringify({ role: 'WORKER', name: n, mobile: m }) });
    return r.json();
  }, [name, mobile]);
}

/** An app-style sign-in (token in the answer) from a client that carries no cookies. */
async function apiLogin(request: APIRequestContext, identifier: string, password: string) {
  const r = await request.post('/api/v1/auth/login', { data: { identifier, password }, headers: { cookie: '' } });
  return { status: r.status(), token: r.ok() ? (await r.json()).accessToken : undefined };
}

test.describe('Masters: wards and areas (Sub Admin)', () => {
  test('lists the ULB’s wards with their boundary status', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/masters', expectPath: /\/masters$/ });
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM wards w JOIN ulbs u ON u.id = w.ulb_id WHERE u.lgd_code = ${ULB_A} AND w.active = 1`);
    const rows = page.locator('tbody tr.ant-table-row');
    await expect(rows).toHaveCount(Number(n));
    await expect(page.getByText('Mapped', { exact: true })).toHaveCount(Number(n));
    await expect(page.locator('.leaflet-container')).toBeVisible();
    // A Sub Admin manages one ULB: no district/ULB or complaint-type tabs.
    await expect(page.getByRole('tab')).toHaveText(['Wards', 'Areas & supervisors']);
  });

  test('a ward added from a GeoJSON file is saved, drawn, and found by GPS routing', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/masters', expectPath: /\/masters$/ });
    const far = shift(await wardGeometry(page, 1), 0.05); // 5 km away: overlaps nothing
    await page.getByRole('button', { name: 'Add ward' }).click();
    await page.getByLabel('Ward number').fill('90');
    await page.getByLabel('Ward name (optional)').fill('E2E Ward');
    await page.locator('.ant-modal input[type=file]').setInputFiles(geojson({ type: 'Feature', properties: {}, geometry: far }));
    await expect(page.locator('.ant-modal .leaflet-container')).toBeVisible(); // the preview of what will be saved
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Ward saved')).toBeVisible();
    const [w] = await sql<{ id: string; has_b: number }>(`SELECT w.id, EXISTS (SELECT 1 FROM ward_boundaries b WHERE b.ward_id = w.id) AS has_b FROM wards w WHERE w.number = 90 AND w.ulb_id = ?`, [await ulbIdA()]);
    expect(w).toBeTruthy();
    expect(Number(w.has_b)).toBe(1);
    await expect(page.getByRole('row', { name: /90 E2E Ward/ })).toContainText('Mapped');
    // A complaint filed at the middle of the new ward is routed to it.
    const c = centroid(far);
    const located = await (await page.request.get(`/api/v1/masters/locate?lat=${c.lat}&lng=${c.lng}`)).json();
    expect(JSON.stringify(located)).toContain(w.id);
  });

  test('a boundary that overlaps another ward is refused and nothing is saved', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/masters', expectPath: /\/masters$/ });
    const same = await wardGeometry(page, 1);
    await page.getByRole('button', { name: 'Add ward' }).click();
    await page.getByLabel('Ward number').fill('91');
    await page.locator('.ant-modal input[type=file]').setInputFiles(geojson(same));
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.ant-message-error')).toBeVisible();
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM wards WHERE number = 91 AND ulb_id = ?`, [await ulbIdA()]);
    expect(Number(n)).toBe(0);
  });

  test('a file that is not a polygon is explained before anything is sent', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/masters', expectPath: /\/masters$/ });
    await page.getByRole('button', { name: 'Add ward' }).click();
    await page.locator('.ant-modal input[type=file]').setInputFiles(geojson({ type: 'Point', coordinates: [81.6, 21.2] }));
    await expect(page.getByRole('dialog').locator('.ant-alert-error')).toContainText('Polygon');
    await page.locator('.ant-modal input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
    await expect(page.getByRole('dialog').locator('.ant-alert-error')).toContainText('not valid JSON');
  });

  test('an area gets a supervisor and wards, and the wards point back at it', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/masters', expectPath: /\/masters$/ });
    await page.getByRole('tab', { name: 'Areas & supervisors' }).click();
    await page.getByRole('button', { name: 'Add area' }).click();
    await page.getByLabel('Area name').fill('E2E Area');
    await page.getByLabel('Area supervisor').click();
    await page.locator('.ant-select-item-option', { hasText: 'Supervisor, South' }).click();
    await page.getByLabel('Wards in this area').click();
    await page.locator('.ant-select-item-option', { hasText: 'E2E Ward' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Area saved')).toBeVisible();
    const [a] = await sql<{ id: string; sup: string }>(`SELECT a.id, s.name AS sup FROM areas a JOIN users s ON s.id = a.supervisor_id WHERE a.name = 'E2E Area'`);
    expect(a.sup).toContain('Supervisor, South');
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM wards WHERE area_id = ? AND number = 90`, [a.id]);
    expect(Number(n)).toBe(1);
    await expect(page.getByRole('row', { name: /E2E Area/ })).toContainText('Ward 90');
  });
});

test.describe('Masters: districts, ULBs and complaint types (Web Admin)', () => {
  test('adds a district and a ULB, and a repeated LGD code is refused', async ({ page }) => {
    await login(page, 'webAdmin', { next: '/masters', expectPath: /\/masters$/ });
    await page.getByRole('button', { name: 'Add district' }).click();
    await page.getByLabel('LGD code').fill('1900');
    await page.getByLabel('Name (English)').fill('E2E District');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
    expect((await sql(`SELECT id FROM districts WHERE lgd_code = 1900`)).length).toBe(1);
    await page.getByRole('button', { name: 'Add district' }).click();
    await page.getByLabel('LGD code').fill('1900');
    await page.getByLabel('Name (English)').fill('Same code again');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('.ant-message-error')).toBeVisible();
    expect((await sql(`SELECT id FROM districts WHERE lgd_code = 1900`)).length).toBe(1);
  });

  test('changing a complaint type’s deadline is saved', async ({ page }) => {
    await login(page, 'webAdmin', { next: '/masters', expectPath: /\/masters$/ });
    await page.getByRole('tab', { name: 'Complaint types & SLA' }).click();
    const [t] = await sql<{ id: string; name_en: string; sla_hours: number }>(`SELECT id, name_en, sla_hours FROM complaint_types WHERE active = 1 ORDER BY sort_order LIMIT 1`);
    const input = page.getByLabel(`SLA hours for ${t.name_en}`);
    await input.fill(String(t.sla_hours + 5));
    await input.blur();
    await expect(page.getByText('Saved')).toBeVisible();
    expect(Number((await sql<{ s: number }>(`SELECT sla_hours AS s FROM complaint_types WHERE id = ?`, [t.id]))[0].s)).toBe(t.sla_hours + 5);
    await input.fill(String(t.sla_hours)); // put it back for the other tests
    await input.blur();
    await expect.poll(async () => Number((await sql<{ s: number }>(`SELECT sla_hours AS s FROM complaint_types WHERE id = ?`, [t.id]))[0].s)).toBe(t.sla_hours);
  });

  test('only the Web Admin can change complaint types, whatever the page shows', async ({ page }) => {
    await login(page, 'subAdmin');
    const [t] = await sql<{ id: string }>(`SELECT id FROM complaint_types LIMIT 1`);
    const r = await page.evaluate(async (id) => (await fetch(`/api/v1/masters/complaint-types/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-cwm-csrf': '1' }, body: JSON.stringify({ slaHours: 1 }), credentials: 'same-origin',
    })).status, t.id);
    expect(r).toBe(403);
  });
});

test.describe('Staff', () => {
  test('a Sub Admin sees exactly the staff of their ULB', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/users', expectPath: /\/users$/ });
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM users u JOIN ulbs b ON b.id = u.ulb_id WHERE b.lgd_code = ${ULB_A} AND u.role <> 'CITIZEN'`);
    await expect(page.getByTestId('staff-table').locator('tbody tr.ant-table-row')).toHaveCount(Number(n));
    await expect(page.getByTestId('staff-table')).not.toContainText('Parishad');
  });

  test('a new worker gets a temporary password, which only works for changing it', async ({ page, request }) => {
    await login(page, 'subAdmin', { next: '/users', expectPath: /\/users$/ });
    const mobile = `96${Date.now().toString().slice(-8)}`;
    await page.getByRole('button', { name: 'Add staff' }).click();
    // A Sub Admin can only create the two field roles.
    await page.getByLabel('Role').click();
    await expect(page.locator('.ant-select-item-option')).toHaveText(['Area Supervisor', 'Sanitation Worker']);
    await page.locator('.ant-select-item-option', { hasText: 'Sanitation Worker' }).click();
    await page.getByLabel('Full name').fill('Wanda Worker');
    await page.getByLabel('Mobile').fill(mobile);
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    const temp = (await page.getByTestId('temp-password').innerText()).trim();
    expect(temp.length).toBeGreaterThanOrEqual(10);
    const [u] = await sql<{ must: number; ulb: string }>(`SELECT must_change_password AS must, ulb_id AS ulb FROM users WHERE name = 'Wanda Worker'`);
    expect(Number(u.must)).toBe(1);
    expect(u.ulb).toBe(await ulbIdA());
    const { token } = await apiLogin(request, mobile, temp);
    expect(token).toBeTruthy();
    const blocked = await request.get('/api/v1/users/workers', { headers: { authorization: `Bearer ${token}` } });
    expect(blocked.status()).toBe(403); // must change the password first
  });

  test('disabling signs the person out at once; enabling lets them back in', async ({ page, playwright, baseURL }) => {
    await login(page, 'subAdmin');
    const mobile = `95${Date.now().toString().slice(-8)}`;
    const made = await createWorker(page, 'Dinesh Disable', mobile);
    // Give them a real password so they can use the API.
    const other = await playwright.request.newContext({ baseURL });
    const login1 = await other.post('/api/v1/auth/login', { data: { identifier: mobile, password: made.tempPassword, session: 'cookie' }, headers: { 'x-cwm-csrf': '1' } });
    expect(login1.status()).toBe(200);
    const changed = await other.post('/api/v1/auth/change-password', { data: { currentPassword: made.tempPassword, newPassword: 'Worker#Pass2026', session: 'cookie' }, headers: { 'x-cwm-csrf': '1', origin: baseURL! } });
    expect(changed.status()).toBe(200);
    expect((await other.get('/api/v1/auth/me')).status()).toBe(200);

    await page.goto('/users');
    const row = page.getByRole('row', { name: /Dinesh Disable/ });
    await row.getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Updated')).toBeVisible();
    expect((await other.get('/api/v1/auth/me')).status()).toBe(401); // the very next request, not when the token expires
    expect((await apiLogin(other, mobile, 'Worker#Pass2026')).status).toBe(401);

    await row.getByRole('button', { name: 'Enable' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => (await apiLogin(other, mobile, 'Worker#Pass2026')).status).toBe(200);
    await other.dispose();
  });

  test('resetting a password ends the old sessions and the old password', async ({ page, playwright, baseURL }) => {
    await login(page, 'subAdmin');
    const mobile = `94${Date.now().toString().slice(-8)}`;
    const made = await createWorker(page, 'Rina Reset', mobile);
    const other = await playwright.request.newContext({ baseURL });
    await other.post('/api/v1/auth/login', { data: { identifier: mobile, password: made.tempPassword, session: 'cookie' }, headers: { 'x-cwm-csrf': '1' } });
    expect((await other.get('/api/v1/auth/me')).status()).toBe(200);
    await page.goto('/users');
    await page.getByRole('row', { name: /Rina Reset/ }).getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    const fresh = (await page.getByTestId('temp-password').innerText()).trim();
    expect(fresh).not.toBe(made.tempPassword);
    expect((await other.get('/api/v1/auth/me')).status()).toBe(401);
    expect((await apiLogin(other, mobile, made.tempPassword)).status).toBe(401);
    expect((await apiLogin(other, mobile, fresh)).status).toBe(200);
    await other.dispose();
  });

  test('a Web Admin creates District Admins, and picks the district', async ({ page }) => {
    await login(page, 'webAdmin', { next: '/users', expectPath: /\/users$/ });
    await page.getByRole('button', { name: 'Add staff' }).click();
    await expect(page.getByLabel('District')).toBeVisible();
    await page.getByLabel('Role').click();
    await expect(page.locator('.ant-select-item-option')).toHaveText(['District Admin']);
  });

  test('a supervisor has no Staff or Masters menu and gets no staff data', async ({ page }) => {
    await login(page, 'supervisorNorth');
    await expect(page.getByRole('link', { name: 'Staff' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Masters' })).toHaveCount(0);
    await page.goto('/users');
    const status = await page.evaluate(async () => (await fetch('/api/v1/users', { credentials: 'same-origin' })).status);
    expect(status).toBe(403);
    await expect(page.getByTestId('staff-table').getByText('Kavita Rao')).toHaveCount(0);
  });
});

test.describe('Event zones', () => {
  test('lists the running demo zone and its drawer shows the complaints inside it', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/event-zones', expectPath: /\/event-zones$/ });
    const row = page.getByRole('row', { name: /Demo Mela Ground/ });
    await expect(row).toContainText('Running');
    await row.getByText('Demo Mela Ground').click();
    const [{ total }] = await sql<{ total: number }>(`SELECT COUNT(*) AS total FROM complaints c JOIN event_zones z ON z.id = c.event_zone_id WHERE z.name = 'Demo Mela Ground'`);
    await expect(page.getByTestId('zone-stats')).toContainText(`${total} total`);
    await expect(page.getByRole('dialog').locator('.leaflet-container')).toBeVisible();
  });

  test('an upcoming zone can be created from a boundary file, then cancelled', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/event-zones', expectPath: /\/event-zones$/ });
    const zone = await wardGeometry(page, 2);
    await page.getByTestId('new-zone').click();
    await page.getByLabel('Name').fill('E2E Festival');
    const pickers = page.getByRole('dialog').locator('.ant-picker-input input');
    await pickers.nth(0).click();
    await pickers.nth(0).fill('01 Dec 2026, 09:00');
    await page.keyboard.press('Enter');
    await pickers.nth(1).fill('03 Dec 2026, 21:00');
    await page.keyboard.press('Enter');
    await page.getByLabel('Deadline hours').fill('6');
    await page.locator('.ant-modal input[type=file]').setInputFiles(geojson(zone));
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Event zone saved')).toBeVisible();
    await expect(page.getByRole('row', { name: /E2E Festival/ })).toContainText('Upcoming');
    expect(Number((await sql<{ n: number }>(`SELECT sla_hours AS n FROM event_zones WHERE name = 'E2E Festival'`))[0].n)).toBe(6);

    await page.getByRole('row', { name: /E2E Festival/ }).getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('row', { name: /E2E Festival/ })).toContainText('Cancelled');
    expect(Number((await sql<{ a: number }>(`SELECT active AS a FROM event_zones WHERE name = 'E2E Festival'`))[0].a)).toBe(0);
  });

  test('a supervisor sees the zones but cannot create or cancel them', async ({ page }) => {
    await login(page, 'supervisorNorth', { next: '/event-zones', expectPath: /\/event-zones$/ });
    await expect(page.getByRole('row', { name: /Demo Mela Ground/ })).toBeVisible();
    await expect(page.getByTestId('new-zone')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    const status = await page.evaluate(async () => (await fetch('/api/v1/event-zones', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cwm-csrf': '1' }, credentials: 'same-origin', body: '{}' })).status);
    expect(status).toBe(403);
  });
});

import { expect, Page, test } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { login, sql } from './fixtures';

const ULB_A = 800001;
const rowsOf = (page: Page) => page.getByTestId('complaints-table').locator('tbody tr.ant-table-row');

async function pickComplaint(where: string): Promise<{ id: string; complaint_no: string; description: string }> {
  const rows = await sql<{ id: string; complaint_no: string; description: string }>(
    `SELECT c.id, c.complaint_no, c.description FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = ${ULB_A} AND ${where} ORDER BY c.created_at DESC LIMIT 1`);
  expect(rows.length, `a demo complaint matching: ${where}`).toBe(1);
  return rows[0];
}
/**
 * A private open complaint for one test (a copy of an existing assigned one), so tests that change complaints
 * never run out of fixtures or depend on each other. Generated columns are left out of the copy.
 */
async function freshOpenComplaint(): Promise<{ id: string; complaint_no: string }> {
  const [base] = await sql<{ id: string }>(`SELECT c.id FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = ${ULB_A} AND c.status = 'ASSIGNED' AND c.supervisor_id IS NOT NULL ORDER BY c.created_at LIMIT 1`);
  const cols = (await sql<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'complaints' AND EXTRA NOT LIKE '%STORED GENERATED%' AND EXTRA NOT LIKE '%VIRTUAL GENERATED%' ORDER BY ordinal_position`)).map((r) => r.COLUMN_NAME);
  const id = (await sql<{ id: string }>(`SELECT UUID() AS id`))[0].id;
  const no = `9999800001${26}${randomInt(100000, 999999)}`; // district 9999, ULB 800001, year 26, a sequence the seeder never uses
  const select = cols.map((c) => (c === 'id' ? '?' : c === 'complaint_no' ? '?' : c)).join(', ');
  await sql(`INSERT INTO complaints (${cols.join(', ')}) SELECT ${select} FROM complaints WHERE id = ?`, [id, no, base.id]);
  await sql(`UPDATE complaints SET worker_id = NULL, escalated = 0, status = 'ASSIGNED', sla_due_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR), created_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id]);
  return { id, complaint_no: no };
}
const eventsOf = (id: string) => sql<{ action: string; remark: string | null; to_status: string }>(`SELECT action, remark, to_status FROM complaint_events WHERE complaint_id = ? ORDER BY id`, [id]);
const statusOf = async (id: string) => (await sql<{ status: string; worker_id: string | null; duplicate_of: string | null; resolution_remark: string | null }>(
  `SELECT status, worker_id, duplicate_of, resolution_remark FROM complaints WHERE id = ?`, [id]))[0];

test.describe('Complaint list', () => {
  test('lists the ULB’s complaints, 25 to a page, with the same total as the database', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/complaints', expectPath: /\/complaints$/ });
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = ${ULB_A}`);
    await expect(page.getByText(`${n} matching complaints`)).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(25);
    await page.getByRole('listitem', { name: '2' }).click();
    await expect(rowsOf(page)).toHaveCount(Number(n) - 25);
    await expect(page).toHaveURL(/page=2/);
  });

  test('the status filter and the Past SLA filter agree with the database', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/complaints', expectPath: /\/complaints$/ });
    const [{ n: closed }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = ${ULB_A} AND c.status = 'CLOSED'`);
    await page.getByLabel('Status filter').click();
    await page.getByTitle('Closed').click();
    await expect(page.getByText(`${closed} matching complaints`)).toBeVisible();
    await expect(page).toHaveURL(/status=CLOSED/);
    await page.locator('button', { hasText: /^Clear$/ }).click();
    const [{ n: late }] = await sql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id WHERE u.lgd_code = ${ULB_A} AND c.status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED') AND c.sla_due_at < UTC_TIMESTAMP(3)`);
    await page.getByRole('checkbox', { name: 'Past SLA' }).click();
    await expect(page.getByText(`${late} matching complaint`)).toBeVisible();
  });

  test('a supervisor’s list holds only complaints of their own area', async ({ page }) => {
    await login(page, 'supervisorSouth', { next: '/complaints', expectPath: /\/complaints$/ });
    const [{ n }] = await sql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM complaints c, users s WHERE s.name LIKE '%(Supervisor, South)%' AND (c.supervisor_id = s.id OR c.area_id IN (SELECT a.id FROM areas a WHERE a.supervisor_id = s.id))`);
    await expect(page.getByText(`${n} matching complaints`)).toBeVisible();
    for (const t of await page.getByTestId('complaints-table').locator('tbody tr.ant-table-row td:nth-child(7)').allInnerTexts()) expect(t).toContain('Kavita Rao');
  });
});

test.describe('Complaint detail', () => {
  test('shows the complaint, its whole history and photo that really loads', async ({ page }) => {
    const c = await pickComplaint(`c.status = 'CLOSED' AND EXISTS (SELECT 1 FROM complaint_media m WHERE m.complaint_id = c.id AND m.stage = 'RESOLUTION')`);
    await login(page, 'subAdmin', { next: `/complaints/${c.id}`, expectPath: /\/complaints\/[0-9a-f-]{36}$/ });
    await expect(page.getByTestId('complaint-no')).toHaveText(c.complaint_no.replace(/^(\d{4})(\d{6})(\d{2})(\d{6})$/, '$1-$2-$3-$4')); // stored as digits, shown with dashes
    await expect(page.getByTestId('complaint-description')).toHaveText(c.description);
    const events = await eventsOf(c.id);
    await expect(page.locator('.ant-timeline-item')).toHaveCount(events.length);
    const imgs = page.getByTestId('evidence').locator('img');
    await expect(imgs.first()).toBeVisible();
    await expect.poll(() => imgs.evaluateAll((els) => els.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await expect(page.getByText('After work (proof)')).toBeVisible();
    await expect(page.getByText('Citizen feedback')).toBeVisible();
  });

  test('a complaint of another ULB shows an error and none of its content', async ({ page }) => {
    const c = await pickComplaint(`c.status = 'ASSIGNED'`);
    await login(page, 'subAdminParishad', { next: `/complaints/${c.id}`, expectPath: /\/complaints\// });
    await expect(page.locator('.ant-alert-error')).toBeVisible();
    await expect(page.getByText(c.description)).toHaveCount(0);
    await expect(page.getByText(c.complaint_no)).toHaveCount(0);
  });

  test('a supervisor cannot open a complaint of the other area', async ({ page }) => {
    const c = await pickComplaint(`c.supervisor_id = (SELECT id FROM users WHERE name LIKE '%(Supervisor, North)%') AND c.area_id NOT IN (SELECT a.id FROM areas a WHERE a.supervisor_id = (SELECT id FROM users WHERE name LIKE '%(Supervisor, South)%'))`);
    await login(page, 'supervisorSouth', { next: `/complaints/${c.id}`, expectPath: /\/complaints\// });
    await expect(page.locator('.ant-alert-error')).toBeVisible();
    await expect(page.getByText(c.description)).toHaveCount(0);
  });
});

test.describe('Triage actions', () => {
  test('assigning a worker is saved, shown in the history and notified', async ({ page }) => {
    const c = await freshOpenComplaint();
    await login(page, 'subAdmin', { next: `/complaints/${c.id}`, expectPath: /\/complaints\// });
    await page.getByRole('button', { name: 'Assign worker' }).click();
    await page.getByLabel('Sanitation worker').click();
    await page.locator('.ant-select-item-option').first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
    await expect.poll(async () => (await statusOf(c.id)).worker_id).not.toBeNull();
    expect((await eventsOf(c.id)).map((e) => e.action)).toContain('ASSIGN');
    await expect(page.getByRole('button', { name: 'Reassign' })).toBeVisible();
    await expect(page.locator('.ant-timeline')).toContainText('Assigned');
  });

  test('rejecting needs a reason, and the reason and the citizen notice are recorded', async ({ page }) => {
    const c = await freshOpenComplaint();
    await login(page, 'subAdmin', { next: `/complaints/${c.id}`, expectPath: /\/complaints\// });
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toContainText('Please enter'); // nothing sent without a reason
    expect((await statusOf(c.id)).status).toBe('ASSIGNED');
    await page.getByRole('dialog').getByRole('textbox').fill('Not a municipal matter: private property');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('complaint-status')).toHaveText('Rejected');
    expect((await statusOf(c.id)).status).toBe('REJECTED');
    const ev = (await eventsOf(c.id)).find((e) => e.action === 'REJECT')!;
    expect(ev.remark).toBe('Not a municipal matter: private property');
    await expect(page.getByText('“Not a municipal matter: private property”')).toBeVisible();
    const [{ n }] = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE complaint_id = ? AND type = 'COMPLAINT_REJECTED'`, [c.id]);
    expect(Number(n)).toBeGreaterThan(0);
    // A closed-out complaint offers no further actions.
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  });

  test('resolving from the web records the remark and closes the action buttons', async ({ page }) => {
    const c = await freshOpenComplaint();
    await login(page, 'subAdmin', { next: `/complaints/${c.id}`, expectPath: /\/complaints\// });
    await page.getByRole('button', { name: 'Resolve' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('Cleared by the sweeping team on site');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('complaint-status')).toHaveText('Resolved');
    const s = await statusOf(c.id);
    expect(s.status).toBe('RESOLVED');
    expect(s.resolution_remark).toBe('Cleared by the sweeping team on site');
    await expect(page.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  });

  test('marking a duplicate offers only nearby complaints of the same type and links them', async ({ page }) => {
    // Private open complaints: b is the one being marked; a is at the same spot and of the same type, an hour older;
    // far is the same type 1 km away; other is at the same spot but of another type. Only a may be offered.
    const [a, b, far, other] = [await freshOpenComplaint(), await freshOpenComplaint(), await freshOpenComplaint(), await freshOpenComplaint()];
    const show = (no: string) => no.replace(/^(\d{4})(\d{6})(\d{2})(\d{6})$/, '$1-$2-$3-$4');
    await sql(`UPDATE complaints o, complaints t SET t.type_id = o.type_id, t.location = o.location, t.created_at = DATE_SUB(o.created_at, INTERVAL 1 HOUR) WHERE o.id = ? AND t.id = ?`, [b.id, a.id]);
    await sql(`UPDATE complaints o, complaints t SET t.type_id = o.type_id, t.created_at = o.created_at,
                 t.location = ST_PointFromText(CONCAT('POINT(', o.lng, ' ', o.lat + 0.01, ')'), 4326, 'axis-order=long-lat') WHERE o.id = ? AND t.id = ?`, [b.id, far.id]);
    await sql(`UPDATE complaints o, complaints t SET t.location = o.location, t.created_at = o.created_at,
                 t.type_id = (SELECT id FROM complaint_types WHERE id <> o.type_id ORDER BY id LIMIT 1) WHERE o.id = ? AND t.id = ?`, [b.id, other.id]);
    await login(page, 'subAdmin', { next: `/complaints/${b.id}`, expectPath: /\/complaints\// });
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.getByRole('dialog').getByRole('combobox').click();
    const options = page.locator('.ant-select-item-option');
    await expect(options.first()).toBeVisible();
    const labels = await options.allInnerTexts();
    expect(labels.some((l) => l.includes(show(a.complaint_no)))).toBe(true);
    expect(labels.some((l) => l.includes(show(far.complaint_no)))).toBe(false);
    expect(labels.some((l) => l.includes(show(other.complaint_no)))).toBe(false);
    expect(labels.some((l) => l.includes(show(b.complaint_no)))).toBe(false); // never itself
    await options.filter({ hasText: show(a.complaint_no) }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Merge' }).click();
    await expect(page.getByTestId('complaint-status')).toHaveText('Duplicate');
    expect((await statusOf(b.id)).duplicate_of).toBe(a.id);
    await expect(page.getByRole('link', { name: 'Original complaint' })).toHaveAttribute('href', `/complaints/${a.id}`);
  });

  test('the worker list offers only workers of the Sub Admin’s own ULB', async ({ page }) => {
    const c = await pickComplaint(`c.status IN ('ASSIGNED','WORK_IN_PROGRESS') AND c.escalated = 1`);
    await login(page, 'subAdmin', { next: `/complaints/${c.id}`, expectPath: /\/complaints\// });
    await page.getByRole('button', { name: /Assign worker|Reassign/ }).click();
    await page.getByLabel('Sanitation worker').click();
    const labels = await page.locator('.ant-select-item-option').allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    const foreign = await sql<{ name: string }>(`SELECT w.name FROM users w JOIN ulbs u ON u.id = w.ulb_id WHERE w.role = 'WORKER' AND u.lgd_code <> ${ULB_A}`);
    for (const f of foreign) for (const l of labels) expect(l).not.toContain(f.name);
  });
});

test.describe('Notifications', () => {
  test('unread notices are counted, can be read one by one and all at once', async ({ page }) => {
    await login(page, 'subAdmin', { next: '/notifications', expectPath: /\/notifications$/ });
    const unread = async () => Number((await sql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name LIKE 'Rakesh Gupta%' AND n.read_at IS NULL`))[0].n);
    const before = await unread();
    expect(before).toBeGreaterThan(0);
    await expect(page.getByTestId('notifications').locator('.ant-list-item').first()).toBeVisible();
    await expect(page.getByRole('link', { name: `Notifications, ${before} unread` })).toBeVisible();
    await page.getByTestId('notifications').locator('.ant-badge-dot').first().locator('xpath=ancestor::li').click();
    await expect.poll(unread).toBe(before - 1);
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect.poll(unread).toBe(0);
    await expect(page.getByRole('link', { name: /Notifications, \d+ unread/ })).toHaveCount(0);
  });

  test('a user only sees their own notifications', async ({ page }) => {
    await login(page, 'supervisorNorth', { next: '/notifications', expectPath: /\/notifications$/ });
    const res = await page.request.get('/api/v1/notifications?page=1&pageSize=100');
    const body = await res.json();
    const mine = await sql<{ id: string }>(`SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name LIKE '%(Supervisor, North)%'`);
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual(mine.map((m) => m.id).sort());
  });
});

import type { Knex } from 'knex';
import { getConfig } from '@/config/env';
import { one } from '@/db/sql';
import { square } from '@/lib/geo';
import { newId } from '@/lib/ids';
import { AreaModel, DistrictModel, UlbModel, WardModel } from '@/models/MasterModel';

/**
 * Demo geography around DEMO_CENTER_LAT / DEMO_CENTER_LNG (set them in .env to where you will test the phone):
 *   District ONE: Nagar Nigam (6 wards, 3 x 2 grid of ~1.1 km squares, two areas) and Nagar Parishad (3 wards)
 *   District TWO: one Nagar Parishad (2 wards), far enough away to show how jurisdictions stay separate.
 * Safe to run again: everything is looked up by its LGD code or number first.
 */
export async function seed(knex: Knex): Promise<void> {
  const { lat, lng } = getConfig().demoCenter;
  const S = 0.01;

  const district = async (lgd: number, name: string, nameHi: string) => {
    const found = await DistrictModel.findByLgd(knex, lgd);
    if (found) return found.id;
    const id = newId();
    await DistrictModel.insert(knex, { id, lgdCode: lgd, name, nameHi });
    return id;
  };
  const ulb = async (districtId: string, lgd: number, type: 'NAGAR_NIGAM' | 'NAGAR_PARISHAD', name: string, nameHi: string) => {
    const found = await UlbModel.findByLgd(knex, lgd);
    if (found) return found.id;
    const id = newId();
    await UlbModel.insert(knex, { id, districtId, lgdCode: lgd, type, name, nameHi });
    return id;
  };
  const ward = async (ulbId: string, number: number, name: string, sw: { lat: number; lng: number }) => {
    const found = await WardModel.findByNumber(knex, ulbId, number);
    if (found) return found.id;
    const id = newId();
    await WardModel.insert(knex, { id, ulbId, number, name });
    await WardModel.setBoundary(knex, id, square(sw.lat, sw.lng, S));
    return id;
  };

  const d1 = await district(1001, 'Demo District', 'डेमो जिला');
  const d2 = await district(1002, 'Second Demo District', 'दूसरा डेमो जिला');
  const ulbA = await ulb(d1, 800001, 'NAGAR_NIGAM', 'Demo Nagar Nigam', 'डेमो नगर निगम');
  const ulbB = await ulb(d1, 800002, 'NAGAR_PARISHAD', 'Demo Nagar Parishad', 'डेमो नगर परिषद');
  const ulbC = await ulb(d2, 800101, 'NAGAR_PARISHAD', 'Other District Nagar Parishad', 'अन्य जिला नगर परिषद');

  // ULB A: 3 columns x 2 rows, numbered row by row from the south-west corner.
  const originA = { lat: lat - S, lng: lng - 1.5 * S };
  const wardsA: string[] = [];
  const names = ['Gandhi Nagar', 'Nehru Colony', 'Shastri Chowk', 'Tilak Marg', 'Patel Basti', 'Azad Vihar'];
  for (let i = 0; i < 6; i++) {
    wardsA.push(await ward(ulbA, i + 1, names[i], { lat: originA.lat + Math.floor(i / 3) * S, lng: originA.lng + (i % 3) * S }));
  }
  // ULB B: three wards to the east, ULB C: two wards well away.
  for (let i = 0; i < 3; i++) await ward(ulbB, i + 1, `Parishad Ward ${i + 1}`, { lat: lat - S, lng: lng + 0.06 + i * S });
  for (let i = 0; i < 2; i++) await ward(ulbC, i + 1, `Other Ward ${i + 1}`, { lat: lat + 0.2, lng: lng + 0.2 + i * S });

  // Two areas for ULB A (supervisors are attached when the users are seeded).
  const area = async (name: string, wardIds: string[]) => {
    const found = await AreaModel.findByName(knex, ulbA, name);
    const id = found?.id ?? newId();
    if (!found) await AreaModel.insert(knex, { id, ulbId: ulbA, name });
    await AreaModel.assignWards(knex, id, ulbA, wardIds);
  };
  await area('South Zone', wardsA.slice(0, 3));
  await area('North Zone', wardsA.slice(3));

  const n = await one<{ n: number }>(knex, `SELECT COUNT(*) AS n FROM wards`);
  console.log(`  geography: 3 districts/ULBs, ${n?.n} wards around (${lat}, ${lng})`);
}

import type { Knex } from 'knex';
import { blindIndex, encrypt } from '@/lib/crypto';
import { hashPassword } from '@/lib/password';
import { newId } from '@/lib/ids';
import type { Role, UserStatus } from '@/lib/enums';
import { one } from '@/db/sql';
import { UserModel } from '@/models/UserModel';

/** Every demo account uses this password. For demonstration only: change it before any real use. */
export const DEMO_PASSWORD = 'Demo@12345';

export interface DemoUser {
  key: string;
  role: Role;
  name: string;
  mobile: string;
  email: string;
  ulb?: 'A' | 'B' | 'C';
  area?: 'NORTH' | 'SOUTH';
  district?: 'ONE' | 'TWO';
  ward?: number;
}

/** The demo logins (also listed in README.md). Mobile numbers are the sign-in names. */
export const DEMO_USERS: DemoUser[] = [
  { key: 'webAdmin', role: 'WEB_ADMIN', name: 'Anil Kumar (Web Admin)', mobile: '9000000001', email: 'admin@demo.example.in' },
  { key: 'districtAdmin', role: 'DISTRICT_ADMIN', name: 'Meena Singh (District Admin)', mobile: '9000000002', email: 'district@demo.example.in', district: 'ONE' },
  { key: 'subAdminA', role: 'SUB_ADMIN', name: 'Rakesh Gupta (Sub Admin, Nagar Nigam)', mobile: '9000000003', email: 'subadmin@demo.example.in', ulb: 'A' },
  { key: 'supervisorNorth', role: 'SUPERVISOR', name: 'Suresh Patel (Supervisor, North)', mobile: '9000000004', email: 'supervisor.north@demo.example.in', ulb: 'A', area: 'NORTH' },
  { key: 'supervisorSouth', role: 'SUPERVISOR', name: 'Kavita Rao (Supervisor, South)', mobile: '9000000005', email: 'supervisor.south@demo.example.in', ulb: 'A', area: 'SOUTH' },
  { key: 'worker1', role: 'WORKER', name: 'Ramesh Yadav (Worker)', mobile: '9000000006', email: 'worker1@demo.example.in', ulb: 'A', area: 'NORTH' },
  { key: 'worker2', role: 'WORKER', name: 'Sunita Devi (Worker)', mobile: '9000000007', email: 'worker2@demo.example.in', ulb: 'A', area: 'SOUTH' },
  { key: 'subAdminB', role: 'SUB_ADMIN', name: 'Vikram Joshi (Sub Admin, Nagar Parishad)', mobile: '9000000008', email: 'subadmin.b@demo.example.in', ulb: 'B' },
  { key: 'districtAdminTwo', role: 'DISTRICT_ADMIN', name: 'Neha Verma (District Admin, second district)', mobile: '9000000009', email: 'district2@demo.example.in', district: 'TWO' },
  { key: 'citizen1', role: 'CITIZEN', name: 'Priya Sharma', mobile: '9100000001', email: 'priya@demo.example.in', ward: 1 },
  { key: 'citizen2', role: 'CITIZEN', name: 'Mohit Agarwal', mobile: '9100000002', email: 'mohit@demo.example.in', ward: 5 },
  { key: 'citizen3', role: 'CITIZEN', name: 'Anita Kulkarni', mobile: '9100000003', email: 'anita@demo.example.in', ward: 2 },
];

export interface EnsureUserInput {
  role: Role;
  status: UserStatus;
  name: string;
  mobile: string;
  email?: string;
  password: string;
  preferredLanguage?: 'hi' | 'en';
  districtId?: string | null;
  ulbId?: string | null;
  areaId?: string | null;
  homeDistrictId?: string | null;
  homeUlbId?: string | null;
  homeWardId?: string | null;
  mustChangePassword?: boolean;
  createdBy?: string | null;
}

/** Inserts a user unless the mobile number is already registered; returns the user's id either way. */
export async function ensureUser(knex: Knex, u: EnsureUserInput): Promise<string> {
  const { mobile, email, password, ...rest } = u;
  const existing = await one<{ id: string }>(knex, `SELECT id FROM users WHERE mobile_hash = ?`, [blindIndex(mobile)]);
  if (existing) return existing.id;
  const id = newId();
  await UserModel.insert(knex, {
    ...rest,
    id,
    mobileEnc: encrypt(mobile),
    mobileHash: blindIndex(mobile),
    emailEnc: email ? encrypt(email) : null,
    emailHash: email ? blindIndex(email) : null,
    passwordHash: await hashPassword(password),
  });
  return id;
}

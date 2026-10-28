export const ROLES = ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN', 'SUPERVISOR', 'WORKER', 'CITIZEN'] as const;
export type Role = (typeof ROLES)[number];
export const Role = Object.fromEntries(ROLES.map((r) => [r, r])) as { [K in Role]: K };

export const STAFF_ROLES: Role[] = ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN', 'SUPERVISOR', 'WORKER'];

/** Which role each role may create: one level down the hierarchy. */
export const CREATABLE_ROLES: Record<Role, Role[]> = {
  WEB_ADMIN: ['DISTRICT_ADMIN'],
  DISTRICT_ADMIN: ['SUB_ADMIN'],
  SUB_ADMIN: ['SUPERVISOR', 'WORKER'],
  SUPERVISOR: [],
  WORKER: [],
  CITIZEN: [],
};

export type UserStatus = 'ACTIVE' | 'UNVERIFIED_MOBILE' | 'DISABLED';
export type UlbType = 'NAGAR_NIGAM' | 'NAGAR_PARISHAD' | 'NAGAR_PANCHAYAT';
export const ULB_TYPES: UlbType[] = ['NAGAR_NIGAM', 'NAGAR_PARISHAD', 'NAGAR_PANCHAYAT'];

export const COMPLAINT_STATUSES = ['PENDING', 'ASSIGNED', 'WORK_IN_PROGRESS', 'RESOLVED', 'REJECTED', 'DUPLICATE', 'REOPENED', 'CLOSED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const OPEN_STATUSES: ComplaintStatus[] = ['PENDING', 'ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'];

export type WardSource = 'GPS' | 'MANUAL';

export enum Role {
  WEB_ADMIN = 'WEB_ADMIN',
  DISTRICT_ADMIN = 'DISTRICT_ADMIN',
  SUB_ADMIN = 'SUB_ADMIN',
  SUPERVISOR = 'SUPERVISOR',
  WORKER = 'WORKER',
  CITIZEN = 'CITIZEN',
}

export const STAFF_ROLES = [Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN, Role.SUPERVISOR, Role.WORKER];

/** Roles that must use TOTP as a second factor. */
export const MFA_REQUIRED_ROLES = [Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN];

/** Which role each role is allowed to create (one level down the hierarchy). */
export const CREATABLE_ROLES: Record<Role, Role[]> = {
  [Role.WEB_ADMIN]: [Role.DISTRICT_ADMIN],
  [Role.DISTRICT_ADMIN]: [Role.SUB_ADMIN],
  [Role.SUB_ADMIN]: [Role.SUPERVISOR, Role.WORKER],
  [Role.SUPERVISOR]: [],
  [Role.WORKER]: [],
  [Role.CITIZEN]: [],
};

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  UNVERIFIED_MOBILE = 'UNVERIFIED_MOBILE',
  DISABLED = 'DISABLED',
}

export enum UlbType {
  NAGAR_NIGAM = 'NAGAR_NIGAM',
  NAGAR_PARISHAD = 'NAGAR_PARISHAD',
  NAGAR_PANCHAYAT = 'NAGAR_PANCHAYAT',
}

export enum ComplaintStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  WORK_IN_PROGRESS = 'WORK_IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
  DUPLICATE = 'DUPLICATE',
  REOPENED = 'REOPENED',
  CLOSED = 'CLOSED',
}

export enum WardSource {
  GPS = 'GPS',
  MANUAL = 'MANUAL',
}

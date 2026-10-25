import dayjs from 'dayjs';

export const STATUS_COLORS: Record<string, string> = {
  PENDING: 'gold', ASSIGNED: 'blue', WORK_IN_PROGRESS: 'cyan', RESOLVED: 'green', CLOSED: 'default',
  REJECTED: 'red', DUPLICATE: 'purple', REOPENED: 'volcano',
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending', ASSIGNED: 'Assigned', WORK_IN_PROGRESS: 'Work in progress', RESOLVED: 'Resolved', CLOSED: 'Closed',
  REJECTED: 'Rejected', DUPLICATE: 'Duplicate', REOPENED: 'Reopened',
};

export const ROLE_LABELS: Record<string, string> = {
  WEB_ADMIN: 'Web Admin', DISTRICT_ADMIN: 'District Admin', SUB_ADMIN: 'Sub Admin (ULB)', SUPERVISOR: 'Area Supervisor',
  WORKER: 'Sanitation Worker', CITIZEN: 'Citizen',
};

export const fmtDateTime = (v?: string | null) => (v ? dayjs(v).format('DD MMM YYYY, HH:mm') : '—');
export const fmtNum = (v?: number | null, suffix = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-IN')}${suffix}`);

'use client';

import { createContext, useContext } from 'react';

export interface Me {
  id: string;
  role: 'WEB_ADMIN' | 'DISTRICT_ADMIN' | 'SUB_ADMIN' | 'SUPERVISOR' | 'WORKER' | 'CITIZEN';
  name: string;
  mobile: string;
  email: string | null;
  districtId: string | null;
  ulbId: string | null;
  mustChangePassword: boolean;
  preferredLanguage: 'hi' | 'en';
}

const SessionContext = createContext<Me | null>(null);
export const SessionProvider = SessionContext.Provider;

export function useMe(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useMe outside the portal layout');
  return me;
}

export const isAdmin = (me: Me) => ['WEB_ADMIN', 'DISTRICT_ADMIN', 'SUB_ADMIN'].includes(me.role);
export const canTriage = (me: Me) => ['SUB_ADMIN', 'SUPERVISOR'].includes(me.role);

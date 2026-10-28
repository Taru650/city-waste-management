'use client';

import { Result, Spin } from 'antd';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { endSession, renewSession } from '@/views/lib/api';
import { hardNavigate } from '@/views/lib/navigate';
import { safeNext } from '@/views/lib/safe-next';

const KEY = 'cwm-session-check';

/**
 * Where the portal sends a browser whose access cookie is missing, expired or no longer accepted. One
 * silent renewal with the refresh cookie; if that fails (or already happened a moment ago and the page was
 * rejected again) the session is ended so the browser can never bounce between a page and the sign-in page.
 */
function Check() {
  const next = safeNext(useSearchParams().get('next'));
  useEffect(() => {
    void (async () => {
      let recent = false;
      try {
        recent = Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 10_000;
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        // Storage can be blocked; renewal then simply is not rate limited here.
      }
      if (!recent && (await renewSession())) return hardNavigate(next);
      await endSession(next);
    })();
  }, [next]);
  return <Result icon={<Spin size="large" />} title="Checking your session…" />;
}

export function SessionCheck() {
  return <Suspense><Check /></Suspense>;
}

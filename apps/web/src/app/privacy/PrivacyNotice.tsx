'use client';

import { Card, Divider, Typography } from 'antd';
import Link from 'next/link';

export interface Notice {
  version: string;
  grievanceOfficer: { name: string; email: string; phone: string };
  en: { title: string; sections: { heading: string; body: string }[] };
  hi: { title: string; sections: { heading: string; body: string }[] };
}

/** antd components are client components (Typography.Title cannot be used from a server component). */
export function PrivacyNotice({ n }: { n: Notice | null }) {
  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: 16 }}>
      <Card>
        {!n ? (
          <Typography.Paragraph>The privacy notice is temporarily unavailable.</Typography.Paragraph>
        ) : (
          <>
            {(['en', 'hi'] as const).map((lang) => (
              <section key={lang} lang={lang === 'hi' ? 'hi' : 'en'}>
                <Typography.Title level={3} data-testid={`notice-${lang}`}>{n[lang].title}</Typography.Title>
                {n[lang].sections.map((s) => (
                  <div key={s.heading}>
                    <Typography.Title level={5}>{s.heading}</Typography.Title>
                    <Typography.Paragraph>{s.body}</Typography.Paragraph>
                  </div>
                ))}
                <Divider />
              </section>
            ))}
            {n.grievanceOfficer.name && (
              <Typography.Paragraph data-testid="grievance-officer">
                <strong>Grievance Officer / शिकायत अधिकारी:</strong> {n.grievanceOfficer.name}
                {n.grievanceOfficer.email && <> · {n.grievanceOfficer.email}</>}
                {n.grievanceOfficer.phone && <> · {n.grievanceOfficer.phone}</>}
              </Typography.Paragraph>
            )}
            <Typography.Text type="secondary">Version {n.version}</Typography.Text>
          </>
        )}
        <div style={{ marginTop: 16 }}><Link href="/login">Sign in</Link></div>
      </Card>
    </div>
  );
}

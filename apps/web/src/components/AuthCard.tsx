import { CheckCircleFilled } from '@ant-design/icons';
import { Card, Typography } from 'antd';
import { Brand } from '@/components/Brand';

const POINTS = [
  'Complaints routed to the right ward supervisor from the citizen’s GPS location',
  'Geotagged before-and-after photo proof for every resolution',
  'Pendency, SLA and quality reports for ULB and district officers',
];

/** Sign-in, forgot and reset password: brand panel beside the form on wide screens, stacked on phones. */
export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__panel" aria-hidden="true">
        <Brand light />
        <div>
          <h1 className="auth__headline">Cleaner cities, accountable service.</h1>
          <ul className="auth__points">
            {POINTS.map((p) => <li key={p}><CheckCircleFilled style={{ color: '#5eead4' }} /> <span>{p}</span></li>)}
          </ul>
        </div>
        <div className="auth__foot">For authorised officials of Urban Local Bodies and district administration.</div>
      </aside>
      <main className="auth__main">
        <div className="auth__mobile-brand"><Brand /></div>
        <Card className="auth__card">
          <Typography.Title level={3} style={{ marginTop: 0, color: '#0b2545' }}>{title}</Typography.Title>
          {children}
        </Card>
        <p className="auth__legal">Swachh Seva · Grievance portal · शिकायत पोर्टल</p>
      </main>
    </div>
  );
}

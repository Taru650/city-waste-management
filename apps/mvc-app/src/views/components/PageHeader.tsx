import { Typography } from 'antd';

/**
 * Page title block used by every portal page. Title and actions wrap onto separate lines on narrow
 * screens (the title is never squeezed by the buttons).
 */
export function PageHeader({ title, subtitle, eyebrow, actions }: {
  title: React.ReactNode; subtitle?: React.ReactNode; eyebrow?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header__titles">
        {eyebrow && <div className="page-header__eyebrow">{eyebrow}</div>}
        <Typography.Title level={3} className="page-header__title">{title}</Typography.Title>
        {subtitle && <div className="page-header__subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-header__actions no-print">{actions}</div>}
    </div>
  );
}

/** Printed above reports only: portal, report title, scope and when it was generated. */
export function PrintHeader({ title, scope }: { title: string; scope?: string }) {
  return (
    <div className="print-only report-print-header">
      <div style={{ fontSize: 11, color: '#475569' }}>Swachh Seva Grievance Portal · Official report</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#0b2545' }}>{title}</div>
      <div style={{ fontSize: 11, color: '#475569' }}>
        {scope ? `${scope} · ` : ''}Generated {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST
      </div>
    </div>
  );
}

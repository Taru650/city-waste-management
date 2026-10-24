import { Card, Typography } from 'antd';

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Typography.Title level={3} style={{ marginTop: 0, color: '#1f7a4d' }}>Swachh Seva</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>Grievance portal · शिकायत पोर्टल</Typography.Paragraph>
        <Typography.Title level={4}>{title}</Typography.Title>
        {children}
      </Card>
    </div>
  );
}

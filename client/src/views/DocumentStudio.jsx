import { useEffect, useState } from 'react';
import { listDocumentTemplates } from '../lib/apiClient.js';
import { styles, theme } from '../theme.jsx';
import { Alert, Badge, Card, Empty, Skeleton } from '../components/ui.jsx';

export default function DocumentStudio({ notify }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await listDocumentTemplates();
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Could not load document templates.');
      notify?.({ type: 'danger', message: err.message || 'Could not load document templates.' });
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <Skeleton />;

  if (error) return <Alert tone="danger">{error}</Alert>;

  const hint = templates.length === 1 ? '1 template configured' : `${templates.length} templates configured`;

  return (
    <Card title="Active Templates" hint={hint}>
      {templates.length === 0 ? (
        <Empty title="No templates configured" text="Contact your administrator." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, padding: '8px 0' }}>
          {templates.map(t => (
            <div key={t.id} style={{ border: `1px solid ${theme.line}`, borderRadius: 10, padding: '16px 18px', background: '#fff', display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: theme.ink, wordBreak: 'break-word' }}>{t.name}</div>
              {t.description && (
                <div style={{ fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>{t.description}</div>
              )}
              {(t.practiceArea || t.category) && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  {t.practiceArea && <Badge tone="blue">{t.practiceArea}</Badge>}
                  {t.category && <Badge tone="blue">{t.category}</Badge>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

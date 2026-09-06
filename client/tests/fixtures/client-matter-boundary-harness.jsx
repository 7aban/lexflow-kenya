import React from 'react';
import { createRoot } from 'react-dom/client';
import { Clients, Matters } from '../../src/views/StaffViews.jsx';
import { StyleTag } from '../../src/theme.jsx';

window.__boundaryNotices = [];
const root = createRoot(document.getElementById('root'));
window.renderBoundary = ({ role, view, data }) => {
  localStorage.setItem('lexflowSession', JSON.stringify({ token: 'synthetic-browser-session', user: { role, fullName: role === 'advocate' ? 'Advocate A' : 'Boundary Admin' } }));
  const props = { canManage: ['admin', 'advocate'].includes(role), reload: async () => {}, notify: notice => window.__boundaryNotices.push(notice) };
  root.render(<><StyleTag />{view === 'clients'
    ? <Clients {...props} isAdmin={role === 'admin'} clients={data.clients} matters={data.matters} />
    : <Matters {...props} data={data} />}</>);
};
window.__boundaryHarnessReady = true;

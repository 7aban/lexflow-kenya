import React from 'react';
import { createRoot } from 'react-dom/client';
import Communications from '../../src/views/Communications.jsx';
import ClientChatWidget from '../../src/components/ClientChatWidget.jsx';
import { StyleTag } from '../../src/theme.jsx';

window.__communicationsNotices = [];
const root = createRoot(document.getElementById('root'));
window.renderCommunications = ({ role, clients, matters }) => {
 const user = { role, fullName: role === 'client' ? 'Portal Client' : 'Firm User', clientId: role === 'client' ? 'shared' : '' };
 localStorage.setItem('lexflowSession', JSON.stringify({ token: 'synthetic-browser-session', user }));
 const notify = notice => window.__communicationsNotices.push(notice);
 root.render(<><StyleTag />{role === 'client'
  ? <ClientChatWidget firm={{ name: 'Boundary Firm' }} matters={matters} user={user} notify={notify} open />
  : <Communications clients={clients} matters={matters} notify={notify} />}</>);
};
window.__communicationsHarnessReady = true;

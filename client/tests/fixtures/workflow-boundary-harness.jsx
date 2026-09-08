import React from 'react';
import { createRoot } from 'react-dom/client';
import DeadlineCenter from '../../src/views/DeadlineCenter.jsx';
import { Tasks } from '../../src/views/StaffViews.jsx';
import { StyleTag } from '../../src/theme.jsx';
const root = createRoot(document.getElementById('root'));
window.renderWorkflow = ({ role, view, data }) => {
  localStorage.setItem('lexflowSession', JSON.stringify({ token: 'synthetic-browser-session', user: { role, fullName: 'Advocate A' } }));
  window.workflowNotices = [];
  const props = { data, canManage: role !== 'assistant', notify: notice => window.workflowNotices.push(notice), reload: async () => {} };
  root.render(<><StyleTag />{view === 'tasks' ? <Tasks {...props} /> : <DeadlineCenter {...props} />}</>);
};

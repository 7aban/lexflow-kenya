import React from 'react';
import { createRoot } from 'react-dom/client';
import MatterDocuments from '../../src/components/MatterDocuments.jsx';
import { StyleTag } from '../../src/theme.jsx';

localStorage.setItem('lexflowSession', JSON.stringify({ token: 'mock-token', user: { role: 'admin' } }));

const root = createRoot(document.getElementById('root'));

window.__matterNotices = [];
window.renderMatterDocuments = ({ matterId, canManage, clientMode, focusTarget = null }) => {
  root.render(React.createElement(
    React.Fragment,
    null,
    React.createElement(StyleTag),
    React.createElement(MatterDocuments, {
      key: [matterId, canManage, clientMode].join(':'),
      matterId,
      canManage,
      clientMode,
      focusTarget,
      notify: notice => window.__matterNotices.push(notice),
      onChooseAction: () => {},
      onOpenDocumentStudio: () => {},
    }),
  ));
};
window.__matterHarnessReady = true;

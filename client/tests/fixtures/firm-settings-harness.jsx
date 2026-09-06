import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FirmSettings } from '../../src/views/StaffViews.jsx';
import { StyleTag } from '../../src/theme.jsx';
import { api } from '../../src/lib/apiClient.js';

localStorage.setItem('lexflowSession', JSON.stringify({ token: 'synthetic-browser-session', user: { role: 'admin' } }));
window.__settingsNotices = [];
function Harness({ initialSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  return <><StyleTag /><FirmSettings settings={settings}
    reload={async () => setSettings(await api('/firm-settings'))}
    notify={notice => window.__settingsNotices.push(notice)} /></>;
}
const root = createRoot(document.getElementById('root'));
window.renderFirmSettings = initialSettings => root.render(<Harness initialSettings={initialSettings} />);
window.__settingsHarnessReady = true;

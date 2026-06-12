const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('LOCAL-PILOT-FIX-16 client portal crash guard', () => {
  test('ClientChatWidget keeps FAQ tab state declared before use', () => {
    const source = read('client/src/components/ClientChatWidget.jsx');
    const declaration = "const [tab, setTab] = useState('FAQ');";
    const firstSetTabUse = source.indexOf('setTab(');

    expect(source).toContain(declaration);
    expect(source.indexOf(declaration)).toBeLessThan(firstSetTabUse);
    expect(source).toContain('onOpen?.();');
    expect(read('client/src/views/ClientApp.jsx')).toContain('onOpen={() => setChatOpen(true)}');
  });

  test('client portal is wrapped in the shared error boundary with a client-safe fallback', () => {
    const app = read('client/src/App.jsx');
    const boundary = read('client/src/components/ViewErrorBoundary.jsx');

    expect(app).toContain("import ViewErrorBoundary from './components/ViewErrorBoundary.jsx';");
    expect(app).toMatch(/user\?\.role === 'client'[\s\S]*<ViewErrorBoundary[\s\S]*title="Something went wrong"[\s\S]*<ClientApp/);
    expect(app).toContain('reloadLabel="Refresh portal"');
    expect(boundary).toContain('window.location.reload()');
    expect(boundary).not.toContain('this.state.error.stack');
  });
});

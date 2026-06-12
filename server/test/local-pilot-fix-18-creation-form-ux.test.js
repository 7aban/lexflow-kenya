const fs = require('fs');
const path = require('path');

const staffViewsPath = path.resolve(__dirname, '../../client/src/views/StaffViews.jsx');

describe('LOCAL-PILOT-FIX-18 creation form UX guardrails', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(staffViewsPath, 'utf8');
  });

  test('clients creation panel is user-triggered and closes on save or cancel', () => {
    expect(source).toContain('const [clientFormOpen, setClientFormOpen] = useState(false);');
    expect(source).toContain('+ New client');
    expect(source).toContain('clientFormOpen ? <Card title={editing ? \'Edit client\' : \'New client\'}');
    expect(source).toContain('setClientFormOpen(false);');
    expect(source).toContain('onClick={closeClientForm}>Cancel</button>');
  });

  test('matters creation panel is user-triggered without changing the cockpit', () => {
    expect(source).toContain('const [matterFormOpen, setMatterFormOpen] = useState(false);');
    expect(source).toContain('+ New matter');
    expect(source).toContain('canManage && matterFormOpen &&');
    expect(source).toContain('setMatterFormOpen(false);');
    expect(source).toContain('matterDetailRef.current?.scrollIntoView');
    expect(source).toContain('function startMatterEdit() { if (!detail) return; setEditingMatter(true); setMatterFormOpen(true);');
  });

  test('tasks global creation is hidden while matter workspace task creation remains available', () => {
    expect(source).toContain('const [taskFormOpen, setTaskFormOpen] = useState(false);');
    expect(source).toContain('+ New task');
    expect(source).toContain('canManage && taskFormOpen ?');
    expect(source).toContain('setTaskFormOpen(false);');
    expect(source).toContain('async function createMatterTask(event)');
    expect(source).toContain('Task added to this matter.');
  });
});

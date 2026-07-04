const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('LOCAL-PILOT-FIX-17 quick UI polish guards', () => {
  test('staff sidebar uses clear open groups and no typed chevrons', () => {
    const app = read('client/src/App.jsx');
    expect(app).toContain("{ title: 'Primary', collapsible: false, showTitle: false, items: [['Dashboard'");
    expect(app).toContain("{ title: 'Tools', collapsible: true, items: [");
    expect(app).toContain("{ title: 'Admin', collapsible: true, items: [['Users'");
    expect(app).toContain('<IconChevronDown');
    expect(app).not.toContain("openNavGroups.has(group.title) ? 'v' : '>'");
  });

  test('global search shortcut, hero contrast, and timekeeper clearance are present', () => {
    const app = read('client/src/App.jsx');
    const client = read('client/src/views/ClientApp.jsx');
    const theme = read('client/src/theme.jsx');

    expect(app).toContain('searchInputRef.current?.focus()');
    expect(app).toContain("event.key.toLowerCase() !== 'k'");
    expect(client).toContain("style={{ color: '#fff'");
    expect(theme).toContain("pageInner: { padding: '24px 28px 124px'");
  });

  test('fake stat initials and visible enum codes are replaced with friendly display', () => {
    const ui = read('client/src/components/ui.jsx');
    const staff = read('client/src/views/StaffViews.jsx');

    expect(ui).toContain('IconChartBar');
    expect(ui).not.toContain("label.slice(0, 2).toUpperCase()");
    expect(staff).toContain('firm_sent_message');
    expect(staff).toContain('friendlyEnumLabel(channel)');
    expect(staff).toContain('className="lf-hr-tabs"');
  });
});

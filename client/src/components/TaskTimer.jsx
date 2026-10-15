import { styles } from '../theme.jsx';
import { useWorkSessions, workClock } from '../lib/workSessions.jsx';

// Task entry point into the same durable timer as the staff shell. There is
// no independent clock, rounding, reset or legacy time-entry creation here.
export default function TaskTimer({ task, matterId }) {
  const work = useWorkSessions();
  const session = work?.sessions.find(row => row.taskId === task.id && row.status !== 'recorded');
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
    <button type="button" disabled={!work?.ready || work?.busy} style={styles.tinyButton} onClick={() => {
      if (session) { work.setSelectedId(session.id); work.setExpanded(true); }
      else work.openStart({ matterId, taskId: task.id, description: task.title });
    }}>{session ? 'Open work session' : 'Start task work'}</button>
    {session && <small>{session.status} · {workClock(session.accumulatedSeconds)} confirmed</small>}
  </div>;
}

// FilesTab -- file system event charts + event list
import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { queryDb, queryAll, queryOne } from '../../db';
import {
  FILE_STATS_SQL, FILE_ACTIONS_SQL, FILE_EVENTS_OVER_TIME_SQL,
  FILE_EVENTS_ALL_SQL, FILE_EVENTS_SEARCH_SQL,
} from '../../sql';
import { colors } from '../../css-var';
import StatCards from './StatCards';
import DetailPanel from './DetailPanel';
import { showToast } from '../../stores/toast';
import type { DetailSelection } from '../../types';

interface FileStats { total: number; created: number; modified: number; deleted: number }
interface ActionRow { action: string; cnt: number }
interface OverTime { bucket: number; action: string; cnt: number }
interface FileEvent { id: number; timestamp: string; action: string; path: string; size: number | null }

const ACTION_COLORS: Record<string, string> = {
  created: colors.fileCreated,
  modified: colors.fileModified,
  deleted: colors.fileDeleted,
};

export default function FilesTab() {
  const [stats, setStats] = useState<FileStats | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [timeline, setTimeline] = useState<Record<string, unknown>[]>([]);
  const [events, setEvents] = useState<FileEvent[]>([]);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<DetailSelection | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, actionRes, timeRes, evRes] = await Promise.all([
        queryDb(FILE_STATS_SQL),
        queryDb(FILE_ACTIONS_SQL),
        queryDb(FILE_EVENTS_OVER_TIME_SQL),
        search
          ? queryDb(FILE_EVENTS_SEARCH_SQL, [`%${search}%`])
          : queryDb(FILE_EVENTS_ALL_SQL),
      ]);
      setStats(queryOne<FileStats>(statsRes));
      setActions(queryAll<ActionRow>(actionRes));
      setEvents(queryAll<FileEvent>(evRes));

      // Pivot timeline by action
      const raw = queryAll<OverTime>(timeRes);
      const allActions = [...new Set(raw.map((r) => r.action))];
      const bucketMap = new Map<number, Record<string, unknown>>();
      for (const r of raw) {
        if (!bucketMap.has(r.bucket)) bucketMap.set(r.bucket, { bucket: r.bucket });
        const row = bucketMap.get(r.bucket)!;
        row[r.action] = ((row[r.action] as number) ?? 0) + r.cnt;
      }
      setTimeline(Array.from(bucketMap.values()));
    } catch (e) {
      console.error('FilesTab load failed:', e);
      showToast('Failed to load file data', 'error');
    }
  }, [search]);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 5000);
    return () => clearInterval(iv);
  }, [loadData]);

  const actionPieData = actions.map((a) => ({
    name: a.action,
    value: a.cnt,
    fill: ACTION_COLORS[a.action] ?? colors.providerFallback,
  }));

  const actionKeys = [...new Set(actions.map((a) => a.action))];

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {stats && (
          <StatCards cards={[
            { label: 'Total Events', value: stats.total },
            { label: 'Created', value: stats.created, color: colors.fileCreated },
            { label: 'Modified', value: stats.modified, color: colors.fileModified },
            { label: 'Deleted', value: stats.deleted, color: colors.fileDeleted },
          ]} />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Timeline */}
          <div className="glass border border-edge rounded-lg p-3 shadow-xs">
            <h3 className="text-xs font-semibold text-content/70 mb-2">Events Over Time</h3>
            {timeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={timeline}>
                  <XAxis dataKey="bucket" tick={false} />
                  <YAxis width={40} />
                  <Tooltip />
                  {actionKeys.map((action) => (
                    <Bar
                      key={action}
                      dataKey={action}
                      stackId="a"
                      fill={ACTION_COLORS[action] ?? colors.providerFallback}
                      name={action}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-44 text-content/30 text-sm">No data yet</div>
            )}
          </div>

          {/* Actions pie */}
          <div className="glass border border-edge rounded-lg p-3 shadow-xs">
            <h3 className="text-xs font-semibold text-content/70 mb-2">Actions</h3>
            {actionPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={actionPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label={({ name }: { name: string }) => name}>
                    {actionPieData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-44 text-content/30 text-sm">No data yet</div>
            )}
          </div>
        </div>

        {/* Event list */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold text-content/70">Events</h3>
            <input
              type="text"
              placeholder="Search paths..."
              className="w-48 rounded-md border border-edge bg-surface-alt px-2 py-1 text-xs text-content/80 placeholder:text-content/20 focus:outline-none focus:ring-1 focus:ring-interactive/40"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search file events"
            />
            {search && (
              <span className="text-xs text-content/40">{events.length} result{events.length !== 1 ? 's' : ''}</span>
            )}
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Path</th>
                  <th className="text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 200).map((ev) => (
                  <tr
                    key={ev.id}
                    className="hover:bg-surface-alt"
                    onClick={() => setDetail({ type: 'file_event', data: ev as unknown as Record<string, unknown> })}
                  >
                    <td className="font-mono text-xs">{ev.timestamp?.split('T')[1]?.slice(0, 8) ?? ''}</td>
                    <td>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] text-white rounded-full" style={{ backgroundColor: ACTION_COLORS[ev.action] ?? undefined }}>
                        {ev.action}
                      </span>
                    </td>
                    <td className="font-mono text-xs truncate max-w-52">{ev.path}</td>
                    <td className="text-right font-mono text-xs">{ev.size != null ? ev.size : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {detail && <DetailPanel selection={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

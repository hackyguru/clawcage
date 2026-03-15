// ToolsTab -- tool usage charts + event list
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { queryDb, queryAll, queryOne } from '../../db';
import {
  TOOLS_STATS_SQL, TOOLS_TOP_TOOLS_SQL, TOOLS_TOP_SERVERS_SQL,
  TOOLS_OVER_TIME_SQL, TOOLS_UNIFIED_SQL, TOOLS_UNIFIED_SEARCH_SQL,
} from '../../sql';
import { colors, serverColor } from '../../css-var';
import StatCards from './StatCards';
import DetailPanel from './DetailPanel';
import type { DetailSelection } from '../../types';

interface ToolStats { total: number; native: number; mcp: number; allowed: number; denied: number }
interface TopTool { tool_name: string; cnt: number; source: string }
interface TopServer { server_name: string; cnt: number }
interface OverTime { bucket: number; native: number; mcp: number }
interface UnifiedRow {
  timestamp: string; process_name: string | null; server_name: string;
  tool_name: string; method: string | null; decision: string;
  duration_ms: number; bytes: number; arguments: string | null;
  response_preview: string | null; error_message: string | null; source: string;
}

export default function ToolsTab() {
  const [stats, setStats] = useState<ToolStats | null>(null);
  const [topTools, setTopTools] = useState<TopTool[]>([]);
  const [topServers, setTopServers] = useState<TopServer[]>([]);
  const [timeline, setTimeline] = useState<OverTime[]>([]);
  const [events, setEvents] = useState<UnifiedRow[]>([]);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<DetailSelection | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, toolsRes, serversRes, timeRes, eventsRes] = await Promise.all([
        queryDb(TOOLS_STATS_SQL),
        queryDb(TOOLS_TOP_TOOLS_SQL),
        queryDb(TOOLS_TOP_SERVERS_SQL),
        queryDb(TOOLS_OVER_TIME_SQL),
        search
          ? queryDb(TOOLS_UNIFIED_SEARCH_SQL, [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`])
          : queryDb(TOOLS_UNIFIED_SQL),
      ]);
      setStats(queryOne<ToolStats>(statsRes));
      setTopTools(queryAll<TopTool>(toolsRes));
      setTopServers(queryAll<TopServer>(serversRes));
      setTimeline(queryAll<OverTime>(timeRes));
      setEvents(queryAll<UnifiedRow>(eventsRes));
    } catch (e) {
      console.error('ToolsTab load failed:', e);
    }
  }, [search]);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 5000);
    return () => clearInterval(iv);
  }, [loadData]);

  const toolPieData = useMemo(() =>
    topTools.map((t, i) => ({
      name: t.tool_name,
      value: t.cnt,
      fill: t.source === 'mcp' ? serverColor(t.tool_name, i) : colors.allowed,
    })),
  [topTools]);

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {stats && (
          <StatCards cards={[
            { label: 'Total Calls', value: stats.total },
            { label: 'Native', value: stats.native },
            { label: 'MCP', value: stats.mcp },
            { label: 'Allowed', value: stats.allowed, color: colors.allowed },
          ]} />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Timeline */}
          <div className="bg-[--color-base-100] rounded-lg p-3">
            <h3 className="text-xs font-semibold text-base-content/70 mb-2">Calls Over Time</h3>
            {timeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={timeline}>
                  <XAxis dataKey="bucket" tick={false} />
                  <YAxis width={40} />
                  <Tooltip />
                  <Bar dataKey="native" stackId="a" fill={colors.allowed} name="Native" />
                  <Bar dataKey="mcp" stackId="a" fill={colors.providerMistral} name="MCP" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-44 text-base-content/30 text-sm">No data yet</div>
            )}
          </div>

          {/* Top tools pie */}
          <div className="bg-[--color-base-100] rounded-lg p-3">
            <h3 className="text-xs font-semibold text-base-content/70 mb-2">Top Tools</h3>
            {toolPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={toolPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label={({ name }) => name}>
                    {toolPieData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-44 text-base-content/30 text-sm">No data yet</div>
            )}
          </div>
        </div>

        {/* Event list */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold text-base-content/70">Events</h3>
            <input
              type="text"
              placeholder="Search tools..."
              className="input input-xs input-bordered w-48"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="table table-xs table-pin-rows">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Tool</th>
                  <th>Server</th>
                  <th>Source</th>
                  <th>Decision</th>
                  <th className="text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 200).map((ev, i) => (
                  <tr
                    key={i}
                    className="cursor-pointer hover:bg-base-300"
                    onClick={() => setDetail({
                      type: ev.source === 'mcp' ? 'mcp_call' : 'tool',
                      data: ev as unknown as Record<string, unknown>,
                    })}
                  >
                    <td className="font-mono text-xs">{ev.timestamp?.split('T')[1]?.slice(0, 8) ?? ''}</td>
                    <td className="font-mono text-xs truncate max-w-32">{ev.tool_name ?? ev.method ?? '-'}</td>
                    <td className="text-xs">{ev.server_name}</td>
                    <td><span className={`badge badge-xs ${ev.source === 'mcp' ? 'badge-accent' : 'badge-ghost'}`}>{ev.source}</span></td>
                    <td><span className={`text-xs ${ev.decision === 'allowed' ? 'text-success' : 'text-error'}`}>{ev.decision}</span></td>
                    <td className="text-right font-mono text-xs">{ev.duration_ms ? `${ev.duration_ms}ms` : '-'}</td>
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

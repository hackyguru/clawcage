// NetworkTab -- network request charts + event list
import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { queryDb, queryAll, queryOne } from '../../db';
import {
  NET_STATS_SQL, NET_REQUESTS_OVER_TIME_SQL, NET_METHODS_SQL,
  NET_TOP_DOMAINS_SQL, NET_EVENTS_ALL_SQL, NET_EVENTS_SEARCH_SQL,
} from '../../sql';
import { colors } from '../../css-var';
import StatCards from './StatCards';
import DetailPanel from './DetailPanel';
import type { DetailSelection } from '../../types';

interface NetStats { total: number; allowed: number; denied: number; avg_latency: number }
interface OverTime { bucket: number; allowed: number; denied: number }
interface MethodRow { method: string; cnt: number }
interface DomainRow { domain: string; allowed: number; denied: number }
interface NetEvent {
  id: number; timestamp: string; domain: string; port: number; decision: string;
  method: string | null; path: string | null; query: string | null;
  status_code: number | null; bytes_sent: number; bytes_received: number;
  duration_ms: number; matched_rule: string | null;
  request_headers: string | null; response_headers: string | null;
  request_body_preview: string | null; response_body_preview: string | null;
}

const METHOD_COLORS: Record<string, string> = {
  GET: colors.allowed,
  POST: colors.providerOpenai,
  PUT: colors.providerAnthropic,
  DELETE: colors.denied,
  CONNECT: colors.providerGoogle,
};

export default function NetworkTab() {
  const [stats, setStats] = useState<NetStats | null>(null);
  const [timeline, setTimeline] = useState<OverTime[]>([]);
  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [events, setEvents] = useState<NetEvent[]>([]);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<DetailSelection | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, timeRes, methodRes, domainRes, evRes] = await Promise.all([
        queryDb(NET_STATS_SQL),
        queryDb(NET_REQUESTS_OVER_TIME_SQL),
        queryDb(NET_METHODS_SQL),
        queryDb(NET_TOP_DOMAINS_SQL),
        search
          ? queryDb(NET_EVENTS_SEARCH_SQL, [`%${search}%`, `%${search}%`, `%${search}%`])
          : queryDb(NET_EVENTS_ALL_SQL),
      ]);
      setStats(queryOne<NetStats>(statsRes));
      setTimeline(queryAll<OverTime>(timeRes));
      setMethods(queryAll<MethodRow>(methodRes));
      setDomains(queryAll<DomainRow>(domainRes));
      setEvents(queryAll<NetEvent>(evRes));
    } catch (e) {
      console.error('NetworkTab load failed:', e);
    }
  }, [search]);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 5000);
    return () => clearInterval(iv);
  }, [loadData]);

  const methodPieData = methods.map((m) => ({
    name: m.method,
    value: m.cnt,
    fill: METHOD_COLORS[m.method] ?? colors.providerFallback,
  }));

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {stats && (
          <StatCards cards={[
            { label: 'Total Requests', value: stats.total },
            { label: 'Allowed', value: stats.allowed, color: colors.allowed },
            { label: 'Denied', value: stats.denied, color: colors.denied },
            { label: 'Avg Latency', value: `${Math.round(stats.avg_latency)}ms` },
          ]} />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Timeline */}
          <div className="bg-[--color-base-100] rounded-lg p-3">
            <h3 className="text-xs font-semibold text-neutral-700 mb-2">Requests Over Time</h3>
            {timeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={timeline}>
                  <XAxis dataKey="bucket" tick={false} />
                  <YAxis width={40} />
                  <Tooltip />
                  <Bar dataKey="allowed" stackId="a" fill={colors.allowed} name="Allowed" />
                  <Bar dataKey="denied" stackId="a" fill={colors.denied} name="Denied" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-44 text-neutral-300 text-sm">No data yet</div>
            )}
          </div>

          {/* Methods pie */}
          <div className="bg-[--color-base-100] rounded-lg p-3">
            <h3 className="text-xs font-semibold text-neutral-700 mb-2">Methods</h3>
            {methodPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={methodPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label={({ name }: { name: string }) => name}>
                    {methodPieData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-44 text-neutral-300 text-sm">No data yet</div>
            )}
          </div>
        </div>

        {/* Top domains */}
        {domains.length > 0 && (
          <div className="bg-[--color-base-100] rounded-lg p-3">
            <h3 className="text-xs font-semibold text-neutral-700 mb-2">Top Domains</h3>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={domains} layout="vertical">
                <XAxis type="number" />
                <YAxis dataKey="domain" type="category" width={120} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="allowed" stackId="a" fill={colors.allowed} name="Allowed" />
                <Bar dataKey="denied" stackId="a" fill={colors.denied} name="Denied" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Event list */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold text-neutral-700">Events</h3>
            <input
              type="text"
              placeholder="Search domain/path..."
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
                  <th>Domain</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Decision</th>
                  <th className="text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 200).map((ev) => (
                  <tr
                    key={ev.id}
                    className="cursor-pointer hover:bg-neutral-200"
                    onClick={() => setDetail({ type: 'net_event', data: ev as unknown as Record<string, unknown> })}
                  >
                    <td className="font-mono text-xs">{ev.timestamp?.split('T')[1]?.slice(0, 8) ?? ''}</td>
                    <td className="font-mono text-xs truncate max-w-28">{ev.domain}</td>
                    <td className="text-xs">{ev.method ?? '-'}</td>
                    <td className="font-mono text-xs truncate max-w-32">{ev.path ?? '/'}</td>
                    <td className="font-mono text-xs">{ev.status_code ?? '-'}</td>
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

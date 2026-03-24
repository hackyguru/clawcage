// SystemTab -- live CPU, memory, and disk usage from the guest VM
import { useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useSystemMetrics, startSystemMetrics, stopSystemMetrics } from '../../stores/system';
import { chartTooltipStyle } from './chart-utils';
import StatCards from './StatCards';
import type { StatCard } from './StatCards';

function fmtMb(kb: number): string {
  const mb = kb / 1024;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb.toFixed(0) + ' MB';
}

function fmtPct(n: number): string {
  return n.toFixed(1) + '%';
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const CPU_COLOR = 'oklch(0.7 0.15 250)';     // blue
const MEM_COLOR = 'oklch(0.72 0.14 145)';    // green
const DISK_COLOR = 'oklch(0.75 0.14 60)';    // orange

export default function SystemTab() {
  const { latest, history } = useSystemMetrics();

  useEffect(() => {
    startSystemMetrics();
    return () => stopSystemMetrics();
  }, []);

  if (!latest || latest.updated_at === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-content/30 text-sm">
        Waiting for system metrics...
      </div>
    );
  }

  const memPct = latest.mem_total_kb > 0 ? (latest.mem_used_kb / latest.mem_total_kb) * 100 : 0;
  const diskPct = latest.disk_total_kb > 0 ? (latest.disk_used_kb / latest.disk_total_kb) * 100 : 0;

  const cards: StatCard[] = [
    { label: 'CPU', value: fmtPct(latest.cpu_percent), color: CPU_COLOR },
    { label: 'Memory', value: fmtPct(memPct), detail: `${fmtMb(latest.mem_used_kb)} / ${fmtMb(latest.mem_total_kb)}` , color: MEM_COLOR },
    { label: 'Disk', value: fmtPct(diskPct), detail: `${fmtMb(latest.disk_used_kb)} / ${fmtMb(latest.disk_total_kb)}`, color: DISK_COLOR },
  ];

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      <StatCards cards={cards} />

      {/* CPU over time */}
      <div className="glass border border-edge rounded-lg p-3 shadow-xs">
        <div className="text-[10px] text-content/40 uppercase tracking-widest font-semibold mb-2">CPU Usage</div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={history}>
            <defs>
              <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CPU_COLOR} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CPU_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tickFormatter={fmtTime} tick={{ fontSize: 10, fill: 'var(--color-content)', opacity: 0.4 }} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => v + '%'} tick={{ fontSize: 10, fill: 'var(--color-content)', opacity: 0.4 }} width={40} />
            <Tooltip
              labelFormatter={fmtTime}
              formatter={(v: number) => [fmtPct(v), 'CPU']}
              contentStyle={chartTooltipStyle}
            />
            <Area type="monotone" dataKey="cpu" stroke={CPU_COLOR} fill="url(#cpuGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Memory over time */}
      <div className="glass border border-edge rounded-lg p-3 shadow-xs">
        <div className="text-[10px] text-content/40 uppercase tracking-widest font-semibold mb-2">Memory Usage</div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={history}>
            <defs>
              <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={MEM_COLOR} stopOpacity={0.3} />
                <stop offset="95%" stopColor={MEM_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tickFormatter={fmtTime} tick={{ fontSize: 10, fill: 'var(--color-content)', opacity: 0.4 }} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => v + '%'} tick={{ fontSize: 10, fill: 'var(--color-content)', opacity: 0.4 }} width={40} />
            <Tooltip
              labelFormatter={fmtTime}
              formatter={(v: number) => [fmtPct(v), 'Memory']}
              contentStyle={chartTooltipStyle}
            />
            <Area type="monotone" dataKey="memUsedPct" stroke={MEM_COLOR} fill="url(#memGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Disk over time */}
      <div className="glass border border-edge rounded-lg p-3 shadow-xs">
        <div className="text-[10px] text-content/40 uppercase tracking-widest font-semibold mb-2">Disk Usage</div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={history}>
            <defs>
              <linearGradient id="diskGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={DISK_COLOR} stopOpacity={0.3} />
                <stop offset="95%" stopColor={DISK_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tickFormatter={fmtTime} tick={{ fontSize: 10, fill: 'var(--color-content)', opacity: 0.4 }} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => v + '%'} tick={{ fontSize: 10, fill: 'var(--color-content)', opacity: 0.4 }} width={40} />
            <Tooltip
              labelFormatter={fmtTime}
              formatter={(v: number) => [fmtPct(v), 'Disk']}
              contentStyle={chartTooltipStyle}
            />
            <Area type="monotone" dataKey="diskUsedPct" stroke={DISK_COLOR} fill="url(#diskGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

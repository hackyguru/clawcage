// LogsView -- unified session log viewer (network, model calls, tool calls, MCP, filesystem)
import { useState, useEffect, useCallback } from 'react';
import { queryDb } from '../api';

type LogTab = 'network' | 'model' | 'tools' | 'mcp' | 'files';

interface TabDef {
  id: LogTab;
  label: string;
  sql: string;
}

const TABS: TabDef[] = [
  {
    id: 'network',
    label: 'Network',
    sql: `SELECT id, timestamp, domain, method, path, status_code, decision, duration_ms, bytes_sent, bytes_received, matched_rule FROM net_events ORDER BY id DESC LIMIT 200`,
  },
  {
    id: 'model',
    label: 'Model Calls',
    sql: `SELECT id, timestamp, provider, model, input_tokens, output_tokens, estimated_cost_usd, duration_ms, stop_reason, status_code FROM model_calls ORDER BY id DESC LIMIT 200`,
  },
  {
    id: 'tools',
    label: 'Tool Calls',
    sql: `SELECT tc.id, mc.timestamp, tc.tool_name, tc.origin, tc.call_id, substr(tc.arguments, 1, 120) as arguments, tr.is_error, substr(tr.content_preview, 1, 120) as response FROM tool_calls tc LEFT JOIN model_calls mc ON tc.model_call_id = mc.id LEFT JOIN tool_responses tr ON tc.call_id = tr.call_id AND tc.model_call_id = tr.model_call_id ORDER BY tc.id DESC LIMIT 200`,
  },
  {
    id: 'mcp',
    label: 'MCP',
    sql: `SELECT id, timestamp, server_name, method, tool_name, decision, duration_ms, error_message FROM mcp_calls ORDER BY id DESC LIMIT 200`,
  },
  {
    id: 'files',
    label: 'Files',
    sql: `SELECT id, timestamp, action, path, size FROM fs_events ORDER BY id DESC LIMIT 200`,
  },
];

function DecisionBadge({ value }: { value: string }) {
  const v = String(value).toLowerCase();
  if (v === 'allowed') return <span className="text-allowed text-[10px] font-semibold uppercase">allowed</span>;
  if (v === 'denied') return <span className="text-denied text-[10px] font-semibold uppercase">denied</span>;
  if (v === 'error') return <span className="text-denied/70 text-[10px] font-semibold uppercase">error</span>;
  if (v === 'warned') return <span className="text-caution text-[10px] font-semibold uppercase">warned</span>;
  return <span className="text-content/50 text-[10px] uppercase">{value}</span>;
}

function StatusBadge({ code }: { code: number | null }) {
  if (code == null) return <span className="text-content/30">-</span>;
  const color = code < 300 ? 'text-allowed' : code < 400 ? 'text-caution' : 'text-denied';
  return <span className={`${color} font-mono text-xs`}>{code}</span>;
}

function FileActionBadge({ action }: { action: string }) {
  const a = String(action).toLowerCase();
  if (a === 'created') return <span className="text-file-created text-[10px] font-semibold uppercase">created</span>;
  if (a === 'modified') return <span className="text-file-modified text-[10px] font-semibold uppercase">modified</span>;
  if (a === 'deleted') return <span className="text-file-deleted text-[10px] font-semibold uppercase">deleted</span>;
  return <span className="text-content/50 text-[10px] uppercase">{action}</span>;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ts; }
}

function formatBytes(n: number | null): string {
  if (n == null || n === 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms === 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd: number | null): string {
  if (usd == null || usd === 0) return '-';
  return `$${usd.toFixed(4)}`;
}

/** Map column arrays + row arrays into objects keyed by column name. */
function toObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map(row => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// Per-tab table renderers
function NetworkTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Decision</th>
          <th>Method</th>
          <th>Domain</th>
          <th>Path</th>
          <th className="text-right">Status</th>
          <th className="text-right">Duration</th>
          <th className="text-right">Sent</th>
          <th className="text-right">Received</th>
          <th>Rule</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r, i) => (
          <tr key={i}>
            <td className="text-content/50 whitespace-nowrap">{formatTimestamp(r.timestamp as string)}</td>
            <td><DecisionBadge value={r.decision as string} /></td>
            <td className="font-mono text-xs">{r.method as string ?? '-'}</td>
            <td className="text-interactive max-w-48 truncate">{r.domain as string}</td>
            <td className="text-content/60 max-w-56 truncate font-mono text-xs">{r.path as string ?? '-'}</td>
            <td className="text-right"><StatusBadge code={r.status_code as number | null} /></td>
            <td className="text-right text-content/50">{formatDuration(r.duration_ms as number)}</td>
            <td className="text-right text-content/40">{formatBytes(r.bytes_sent as number)}</td>
            <td className="text-right text-content/40">{formatBytes(r.bytes_received as number)}</td>
            <td className="text-content/40 max-w-32 truncate text-xs">{r.matched_rule as string ?? '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ModelTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Provider</th>
          <th>Model</th>
          <th className="text-right">Status</th>
          <th className="text-right">In Tokens</th>
          <th className="text-right">Out Tokens</th>
          <th className="text-right">Cost</th>
          <th className="text-right">Duration</th>
          <th>Stop Reason</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r, i) => (
          <tr key={i}>
            <td className="text-content/50 whitespace-nowrap">{formatTimestamp(r.timestamp as string)}</td>
            <td className="font-medium">{r.provider as string}</td>
            <td className="text-interactive max-w-40 truncate text-xs">{r.model as string ?? '-'}</td>
            <td className="text-right"><StatusBadge code={r.status_code as number | null} /></td>
            <td className="text-right font-mono text-xs text-token-input">{(r.input_tokens as number)?.toLocaleString() ?? '-'}</td>
            <td className="text-right font-mono text-xs text-token-output">{(r.output_tokens as number)?.toLocaleString() ?? '-'}</td>
            <td className="text-right font-mono text-xs">{formatCost(r.estimated_cost_usd as number)}</td>
            <td className="text-right text-content/50">{formatDuration(r.duration_ms as number)}</td>
            <td className="text-content/50 text-xs">{r.stop_reason as string ?? '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ToolsTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Tool</th>
          <th>Origin</th>
          <th>Call ID</th>
          <th>Arguments</th>
          <th>Error</th>
          <th>Response</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r, i) => (
          <tr key={i}>
            <td className="text-content/50 whitespace-nowrap">{formatTimestamp(r.timestamp as string)}</td>
            <td className="text-interactive font-medium">{r.tool_name as string}</td>
            <td className="text-content/50 text-xs">{r.origin as string}</td>
            <td className="text-content/40 font-mono text-xs max-w-24 truncate">{r.call_id as string ?? '-'}</td>
            <td className="text-content/50 font-mono text-xs max-w-56 truncate">{r.arguments as string ?? '-'}</td>
            <td>{(r.is_error as number) ? <span className="text-denied text-[10px] font-semibold">ERR</span> : <span className="text-content/30">-</span>}</td>
            <td className="text-content/50 text-xs max-w-56 truncate">{r.response as string ?? '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function McpTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Server</th>
          <th>Method</th>
          <th>Tool</th>
          <th>Decision</th>
          <th className="text-right">Duration</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r, i) => (
          <tr key={i}>
            <td className="text-content/50 whitespace-nowrap">{formatTimestamp(r.timestamp as string)}</td>
            <td className="text-interactive font-medium">{r.server_name as string}</td>
            <td className="font-mono text-xs">{r.method as string}</td>
            <td className="text-content/60 text-xs">{r.tool_name as string ?? '-'}</td>
            <td><DecisionBadge value={r.decision as string} /></td>
            <td className="text-right text-content/50">{formatDuration(r.duration_ms as number)}</td>
            <td className="text-denied/70 text-xs max-w-48 truncate">{r.error_message as string ?? '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FilesTable({ data }: { data: Record<string, unknown>[] }) {
  return (
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
        {data.map((r, i) => (
          <tr key={i}>
            <td className="text-content/50 whitespace-nowrap">{formatTimestamp(r.timestamp as string)}</td>
            <td><FileActionBadge action={r.action as string} /></td>
            <td className="font-mono text-xs text-content/70 max-w-96 truncate">{r.path as string}</td>
            <td className="text-right text-content/40">{formatBytes(r.size as number)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const TABLE_COMPONENTS: Record<LogTab, React.FC<{ data: Record<string, unknown>[] }>> = {
  network: NetworkTable,
  model: ModelTable,
  tools: ToolsTable,
  mcp: McpTable,
  files: FilesTable,
};

export default function LogsView() {
  const [tab, setTab] = useState<LogTab>('network');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (t: LogTab) => {
    setLoading(true);
    setError(null);
    try {
      const tabDef = TABS.find(td => td.id === t)!;
      const result = await queryDb(tabDef.sql);
      setData(toObjects(result.columns, result.rows));
    } catch (e) {
      setError(String(e));
      setData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(tab); }, [tab, fetchData]);

  const TableComponent = TABLE_COMPONENTS[tab];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Logs</h2>
          <p className="text-xs text-content/50 mt-0.5">
            {data.length} {data.length === 1 ? 'row' : 'rows'}
          </p>
        </div>
        <button
          className="text-xs text-content/40 hover:text-content/70 transition-colors"
          onClick={() => fetchData(tab)}
        >
          Refresh
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-4 py-2 border-b border-edge shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
              tab === t.id
                ? 'bg-interactive/15 text-interactive font-medium'
                : 'text-content/40 hover:text-content/70 hover:bg-content/5'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <span className="spinner w-5 h-5 text-content/30" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-denied/70 text-xs">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-content/30 text-xs gap-1">
            <span>No log entries</span>
            <span className="text-content/20">Events will appear here when the VM is running</span>
          </div>
        ) : (
          <TableComponent data={data} />
        )}
      </div>
    </div>
  );
}

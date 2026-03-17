// AITab -- AI model usage charts + trace viewer
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { queryDb, queryAll, queryOne } from '../../db';
import {
  AI_USAGE_PER_PROVIDER_SQL, AI_TOKENS_OVER_TIME_BY_MODEL_SQL,
  AI_MODEL_USAGE_SQL, TRACES_SQL, TRACE_DETAIL_SQL,
  TRACE_TOOL_CALLS_SQL, TRACE_TOOL_RESPONSES_SQL,
} from '../../sql';
import { providerColor, modelColor, colors } from '../../css-var';
import StatCards from './StatCards';
import DetailPanel from './DetailPanel';
import { showToast } from '../../stores/toast';
import type { TraceSummary, TraceModelCall, ToolCallEntry, ToolResponseEntry, DetailSelection } from '../../types';
import { ChevronRight, ChevronDown } from '../../icons/Icons';

interface ProviderUsage {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  call_count: number;
}

interface ModelUsage {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  tokens: number;
  cost: number;
  call_count: number;
}

interface TokenOverTime {
  bucket: number;
  model: string;
  provider: string;
  tokens: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n: number): string {
  if (n < 0.01 && n > 0) return '<$0.01';
  return '$' + n.toFixed(4);
}

function fmtDuration(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

export default function AITab() {
  const [providers, setProviders] = useState<ProviderUsage[]>([]);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [tokenTimeline, setTokenTimeline] = useState<Record<string, unknown>[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);
  const [traceCalls, setTraceCalls] = useState<TraceModelCall[]>([]);
  const [traceToolCalls, setTraceToolCalls] = useState<ToolCallEntry[]>([]);
  const [traceToolResponses, setTraceToolResponses] = useState<ToolResponseEntry[]>([]);
  const [detail, setDetail] = useState<DetailSelection | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [provResult, modelResult, tokenResult, traceResult] = await Promise.all([
        queryDb(AI_USAGE_PER_PROVIDER_SQL),
        queryDb(AI_MODEL_USAGE_SQL),
        queryDb(AI_TOKENS_OVER_TIME_BY_MODEL_SQL),
        queryDb(TRACES_SQL, [50]),
      ]);
      setProviders(queryAll<ProviderUsage>(provResult));
      setModels(queryAll<ModelUsage>(modelResult));
      setTraces(queryAll<TraceSummary>(traceResult));

      // Pivot token timeline by model
      const raw = queryAll<TokenOverTime>(tokenResult);
      const allModels = [...new Set(raw.map((r) => r.model))];
      const bucketMap = new Map<number, Record<string, unknown>>();
      for (const r of raw) {
        if (!bucketMap.has(r.bucket)) bucketMap.set(r.bucket, { bucket: r.bucket });
        const row = bucketMap.get(r.bucket)!;
        row[r.model] = ((row[r.model] as number) ?? 0) + r.tokens;
        // Store provider for color lookup
        row[`__provider_${r.model}`] = r.provider;
      }
      setTokenTimeline(Array.from(bucketMap.values()));
    } catch (e) {
      console.error('AITab load failed:', e);
      showToast('Failed to load AI data', 'error');
    }
  }, []);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 5000);
    return () => clearInterval(iv);
  }, [loadData]);

  // Load trace detail when expanding
  const toggleTrace = useCallback(async (traceId: string) => {
    if (expandedTrace === traceId) {
      setExpandedTrace(null);
      setTraceCalls([]);
      setTraceToolCalls([]);
      setTraceToolResponses([]);
      setDetail(null);
      return;
    }
    setExpandedTrace(traceId);
    try {
      const [callResult, toolResult, respResult] = await Promise.all([
        queryDb(TRACE_DETAIL_SQL, [traceId]),
        queryDb(TRACE_TOOL_CALLS_SQL, [traceId]),
        queryDb(TRACE_TOOL_RESPONSES_SQL, [traceId]),
      ]);
      setTraceCalls(queryAll<TraceModelCall>(callResult));
      setTraceToolCalls(queryAll<ToolCallEntry>(toolResult));
      setTraceToolResponses(queryAll<ToolResponseEntry>(respResult));
    } catch (e) {
      console.error('Trace detail load failed:', e);
      showToast('Failed to load trace details', 'error');
    }
  }, [expandedTrace]);

  const totalTokens = useMemo(() => providers.reduce((s, p) => s + p.input_tokens + p.output_tokens, 0), [providers]);
  const totalCost = useMemo(() => providers.reduce((s, p) => s + p.cost, 0), [providers]);
  const totalCalls = useMemo(() => providers.reduce((s, p) => s + p.call_count, 0), [providers]);
  const modelNames = useMemo(() => [...new Set(models.map((m) => m.model))], [models]);

  // Pie chart data for cost by provider
  const costPieData = useMemo(() =>
    providers.filter((p) => p.cost > 0).map((p) => ({
      name: p.provider,
      value: p.cost,
      fill: providerColor(p.provider),
    })),
  [providers]);

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Stat cards */}
        <StatCards cards={[
          { label: 'Total Tokens', value: fmtTokens(totalTokens) },
          { label: 'Total Cost', value: fmtCost(totalCost) },
          { label: 'API Calls', value: totalCalls },
          { label: 'Models', value: models.length },
        ]} />

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Token timeline (stacked bar by model) */}
          <div className="bg-surface border border-edge rounded-lg p-3 shadow-xs">
            <h3 className="text-xs font-semibold text-content/70 mb-2">Tokens Over Time</h3>
            {tokenTimeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={tokenTimeline}>
                  <XAxis dataKey="bucket" tick={false} />
                  <YAxis width={50} tickFormatter={fmtTokens} />
                  <Tooltip formatter={(v: number) => fmtTokens(v)} />
                  {modelNames.map((m) => (
                    <Bar
                      key={m}
                      dataKey={m}
                      stackId="tokens"
                      fill={modelColor(m, models.find((md) => md.model === m)?.provider ?? 'unknown')}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-48 text-content/30 text-sm">No data yet</div>
            )}
          </div>

          {/* Cost by provider pie */}
          <div className="bg-surface border border-edge rounded-lg p-3 shadow-xs">
            <h3 className="text-xs font-semibold text-content/70 mb-2">Cost by Provider</h3>
            {costPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={costPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name }) => name}>
                    {costPieData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtCost(v)} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-48 text-content/30 text-sm">No data yet</div>
            )}
          </div>
        </div>

        {/* Model breakdown table */}
        {models.length > 0 && (
          <div className="bg-surface border border-edge rounded-lg p-3 shadow-xs">
            <h3 className="text-xs font-semibold text-content/70 mb-2">Models</h3>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Provider</th>
                    <th className="text-right">Input</th>
                    <th className="text-right">Output</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.model}>
                      <td className="font-mono text-xs">{m.model}</td>
                      <td>
                        <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: providerColor(m.provider) }} />
                        {m.provider}
                      </td>
                      <td className="text-right font-mono">{fmtTokens(m.input_tokens)}</td>
                      <td className="text-right font-mono">{fmtTokens(m.output_tokens)}</td>
                      <td className="text-right font-mono">{fmtCost(m.cost)}</td>
                      <td className="text-right font-mono">{m.call_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Trace viewer */}
        <div>
          <h3 className="text-xs font-semibold text-content/70 mb-2">Recent Traces</h3>
          {traces.length === 0 ? (
            <div className="text-content/30 text-sm py-4 text-center">No traces yet</div>
          ) : (
            <div className="space-y-1">
              {traces.map((trace) => (
                <div key={trace.trace_id} className="bg-surface rounded-lg overflow-hidden">
                  {/* Trace header row */}
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-alt transition-colors"
                    onClick={() => toggleTrace(trace.trace_id)}
                  >
                    {expandedTrace === trace.trace_id ? (
                      <ChevronDown className="size-3 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0" />
                    )}
                    <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: providerColor(trace.provider) }} />
                    <span className="text-xs font-mono truncate flex-1">{trace.model}</span>
                    <span className="text-xs text-content/50">{fmtTokens(trace.total_input_tokens + trace.total_output_tokens)} tok</span>
                    <span className="text-xs text-content/50">{fmtDuration(trace.total_duration_ms)}</span>
                    <span className="text-xs text-content/50">{fmtCost(trace.total_cost)}</span>
                    {trace.total_tool_calls > 0 && (
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full bg-surface-alt text-content/60">{trace.total_tool_calls} tools</span>
                    )}
                  </button>

                  {/* Expanded trace detail */}
                  {expandedTrace === trace.trace_id && (
                    <div className="border-t border-edge px-3 py-2 space-y-1">
                      {traceCalls.map((call) => {
                        const callTools = traceToolCalls.filter((t) => t.model_call_id === call.id);
                        return (
                          <div key={call.id} className="space-y-1">
                            {/* Model call row */}
                            <div className="flex items-center gap-2 text-xs">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: modelColor(call.model, call.provider) }} />
                              <span className="font-mono truncate">{call.model}</span>
                              <span className="text-content/50">{fmtTokens(call.input_tokens + call.output_tokens)}</span>
                              <span className="text-content/50">{fmtDuration(call.duration_ms)}</span>
                              <span className="flex-1" />
                              {call.thinking_content && (
                                <button
                                  className="px-1.5 py-0.5 text-xs rounded hover:bg-surface-alt text-allowed transition-colors"
                                  onClick={() => setDetail({ type: 'thinking', data: call as unknown as Record<string, unknown> })}
                                >
                                  thinking
                                </button>
                              )}
                              {call.text_content && (
                                <button
                                  className="px-1.5 py-0.5 text-xs rounded hover:bg-surface-alt transition-colors"
                                  onClick={() => setDetail({ type: 'text', data: call as unknown as Record<string, unknown> })}
                                >
                                  response
                                </button>
                              )}
                            </div>
                            {/* Tool calls within this model call */}
                            {callTools.map((tc) => {
                              const resp = traceToolResponses.find((r) => r.call_id === tc.call_id && r.model_call_id === tc.model_call_id);
                              return (
                                <button
                                  key={tc.id}
                                  className="flex items-center gap-2 text-xs pl-5 w-full text-left hover:bg-surface-alt rounded py-0.5 transition-colors"
                                  onClick={() => setDetail({
                                    type: 'tool',
                                    data: { ...tc, response_preview: resp?.content_preview, is_error: resp?.is_error } as unknown as Record<string, unknown>,
                                  })}
                                >
                                  <span className="text-warning">⚡</span>
                                  <span className="font-mono truncate">{tc.tool_name}</span>
                                  {resp?.is_error ? <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full bg-denied/15 text-denied">err</span> : null}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {detail && <DetailPanel selection={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// DetailPanel -- shows detail for a selected span in the trace viewer
import { useMemo } from 'react';
import { CloseIcon } from '../../icons/Icons';
import type { DetailSelection } from '../../types';

interface Props {
  selection: DetailSelection;
  onClose: () => void;
}

/** Safely coerce an unknown value to a renderable string. */
function str(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

function highlightJson(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    const pretty = JSON.stringify(obj, null, 2);
    return pretty
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"([^"]+)":/g, '<span class="text-info">"$1"</span>:')
      .replace(/: "([^"]*)"/g, ': <span class="text-success">"$1"</span>')
      .replace(/: (\d+\.?\d*)/g, ': <span class="text-warning">$1</span>')
      .replace(/: (true|false|null)/g, ': <span class="text-error">$1</span>');
  } catch {
    return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function formatContent(content: string | null | undefined): string {
  if (!content) return '';
  return content;
}

export default function DetailPanel({ selection, onClose }: Props) {
  const { type, data } = selection;

  const title = useMemo(() => {
    switch (type) {
      case 'thinking': return 'Thinking';
      case 'text': return 'Response';
      case 'tool': return `Tool: ${data.tool_name ?? 'unknown'}`;
      case 'net_event': return `Network: ${data.method ?? ''} ${data.domain ?? ''}`;
      case 'mcp_call': return `MCP: ${data.tool_name ?? data.method ?? 'call'}`;
      case 'file_event': return `File: ${data.action ?? ''} ${data.path ?? ''}`;
      default: return 'Detail';
    }
  }, [type, data]);

  const renderThinking = () => (
  <div className="whitespace-pre-wrap text-sm font-mono text-neutral-800 leading-relaxed">
      {formatContent(str(data.thinking_content))}
    </div>
  );

  const renderText = () => (
  <div className="whitespace-pre-wrap text-sm text-neutral-900 leading-relaxed">
      {formatContent(str(data.text_content))}
    </div>
  );

  const renderTool = () => (
    <div className="space-y-3">
      <div>
  <div className="text-xs text-neutral-500 mb-1">Tool Name</div>
        <div className="font-mono text-sm">{str(data.tool_name)}</div>
      </div>
      {!!data.arguments && (
        <div>
          <div className="text-xs text-neutral-500 mb-1">Arguments</div>
          <pre
            className="text-xs font-mono bg-neutral-200 rounded p-2 overflow-auto max-h-60"
            dangerouslySetInnerHTML={{ __html: highlightJson(str(data.arguments)) }}
          />
        </div>
      )}
      {!!data.response_preview && (
        <div>
          <div className="text-xs text-neutral-500 mb-1">Response</div>
          <pre className="text-xs font-mono bg-neutral-200 rounded p-2 overflow-auto max-h-60">
            {str(data.response_preview)}
          </pre>
        </div>
      )}
      {data.is_error ? (
        <div className="badge badge-error badge-sm">Error</div>
      ) : null}
    </div>
  );

  const renderNetEvent = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs text-neutral-500">Domain</div>
          <div className="font-mono">{str(data.domain)}</div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Method</div>
          <div className="font-mono">{str(data.method) || '-'}</div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Status</div>
          <div className="font-mono">{str(data.status_code) || '-'}</div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Decision</div>
          <div className={`font-mono ${data.decision === 'allowed' ? 'text-success' : 'text-error'}`}>
            {str(data.decision)}
          </div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Path</div>
          <div className="font-mono truncate">{str(data.path) || '/'}</div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Duration</div>
          <div className="font-mono">{data.duration_ms ? `${data.duration_ms}ms` : '-'}</div>
        </div>
      </div>
      {!!data.request_body_preview && (
        <div>
          <div className="text-xs text-neutral-500 mb-1">Request Body</div>
          <pre className="text-xs font-mono bg-neutral-200 rounded p-2 overflow-auto max-h-40">
            {str(data.request_body_preview)}
          </pre>
        </div>
      )}
      {!!data.response_body_preview && (
        <div>
          <div className="text-xs text-neutral-500 mb-1">Response Body</div>
          <pre className="text-xs font-mono bg-neutral-200 rounded p-2 overflow-auto max-h-40">
            {str(data.response_body_preview)}
          </pre>
        </div>
      )}
    </div>
  );

  const renderMcpCall = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs text-neutral-500">Server</div>
          <div className="font-mono">{str(data.server_name)}</div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Tool</div>
          <div className="font-mono">{str(data.tool_name) || str(data.method)}</div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Decision</div>
          <div className={`font-mono ${data.decision === 'allowed' ? 'text-success' : 'text-error'}`}>
            {str(data.decision)}
          </div>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Duration</div>
          <div className="font-mono">{data.duration_ms ? `${data.duration_ms}ms` : '-'}</div>
        </div>
      </div>
      {!!data.arguments && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Arguments</div>
          <pre
            className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-60"
            dangerouslySetInnerHTML={{ __html: highlightJson(str(data.arguments)) }}
          />
        </div>
      )}
      {!!data.response_preview && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Response</div>
          <pre className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-60">
            {str(data.response_preview)}
          </pre>
        </div>
      )}
    </div>
  );

  const renderFileEvent = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs text-base-content/50">Action</div>
          <div className="font-mono">{str(data.action)}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Path</div>
          <div className="font-mono truncate">{str(data.path)}</div>
        </div>
        {data.size != null && (
          <div>
            <div className="text-xs text-base-content/50">Size</div>
            <div className="font-mono">{str(data.size)} bytes</div>
          </div>
        )}
      </div>
    </div>
  );

  return (
  <div className="border-l border-base-300 bg-[--color-base-100] w-80 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-base-300">
        <h3 className="text-sm font-semibold truncate">{title}</h3>
        <button className="btn btn-ghost btn-xs" onClick={onClose}>
          <CloseIcon className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {type === 'thinking' && renderThinking()}
        {type === 'text' && renderText()}
        {type === 'tool' && renderTool()}
        {type === 'net_event' && renderNetEvent()}
        {type === 'mcp_call' && renderMcpCall()}
        {type === 'file_event' && renderFileEvent()}
      </div>
    </div>
  );
}

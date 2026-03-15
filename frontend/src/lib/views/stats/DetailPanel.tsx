// DetailPanel -- shows detail for a selected span in the trace viewer
import { useState, useMemo } from 'react';
import { CloseIcon } from '../../icons/Icons';
import type { DetailSelection, SpanType } from '../../types';

interface Props {
  selection: DetailSelection;
  onClose: () => void;
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
    <div className="whitespace-pre-wrap text-sm font-mono text-base-content/80 leading-relaxed">
      {formatContent(data.thinking_content as string)}
    </div>
  );

  const renderText = () => (
    <div className="whitespace-pre-wrap text-sm text-base-content leading-relaxed">
      {formatContent(data.text_content as string)}
    </div>
  );

  const renderTool = () => (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-base-content/50 mb-1">Tool Name</div>
        <div className="font-mono text-sm">{data.tool_name as string}</div>
      </div>
      {data.arguments && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Arguments</div>
          <pre
            className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-60"
            dangerouslySetInnerHTML={{ __html: highlightJson(data.arguments as string) }}
          />
        </div>
      )}
      {data.response_preview && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Response</div>
          <pre className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-60">
            {data.response_preview as string}
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
          <div className="text-xs text-base-content/50">Domain</div>
          <div className="font-mono">{data.domain as string}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Method</div>
          <div className="font-mono">{(data.method as string) ?? '-'}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Status</div>
          <div className="font-mono">{(data.status_code as number) ?? '-'}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Decision</div>
          <div className={`font-mono ${data.decision === 'allowed' ? 'text-success' : 'text-error'}`}>
            {data.decision as string}
          </div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Path</div>
          <div className="font-mono truncate">{(data.path as string) ?? '/'}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Duration</div>
          <div className="font-mono">{data.duration_ms ? `${data.duration_ms}ms` : '-'}</div>
        </div>
      </div>
      {data.request_body_preview && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Request Body</div>
          <pre className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-40">
            {data.request_body_preview as string}
          </pre>
        </div>
      )}
      {data.response_body_preview && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Response Body</div>
          <pre className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-40">
            {data.response_body_preview as string}
          </pre>
        </div>
      )}
    </div>
  );

  const renderMcpCall = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs text-base-content/50">Server</div>
          <div className="font-mono">{data.server_name as string}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Tool</div>
          <div className="font-mono">{(data.tool_name as string) ?? (data.method as string)}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Decision</div>
          <div className={`font-mono ${data.decision === 'allowed' ? 'text-success' : 'text-error'}`}>
            {data.decision as string}
          </div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Duration</div>
          <div className="font-mono">{data.duration_ms ? `${data.duration_ms}ms` : '-'}</div>
        </div>
      </div>
      {data.arguments && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Arguments</div>
          <pre
            className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-60"
            dangerouslySetInnerHTML={{ __html: highlightJson(data.arguments as string) }}
          />
        </div>
      )}
      {data.response_preview && (
        <div>
          <div className="text-xs text-base-content/50 mb-1">Response</div>
          <pre className="text-xs font-mono bg-base-300 rounded p-2 overflow-auto max-h-60">
            {data.response_preview as string}
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
          <div className="font-mono">{data.action as string}</div>
        </div>
        <div>
          <div className="text-xs text-base-content/50">Path</div>
          <div className="font-mono truncate">{data.path as string}</div>
        </div>
        {data.size != null && (
          <div>
            <div className="text-xs text-base-content/50">Size</div>
            <div className="font-mono">{data.size as number} bytes</div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="border-l border-base-300 bg-base-100 w-80 flex flex-col overflow-hidden">
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

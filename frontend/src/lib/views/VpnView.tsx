// VpnView -- per-venv VPN configuration and status
import { useState, useEffect, useCallback, useRef } from 'react';
import { useVenvs } from '../stores/venvs';
import { getSettings, updateSetting, vpnConnect, vpnDisconnect, vpnStatus, type VpnState as BackendVpnState } from '../api';
import type { ResolvedSetting } from '../types';

/** VPN connection states. */
type VpnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface VpnState {
  status: VpnStatus;
  config: string;
  dns: string;
  killSwitch: boolean;
  error: string | null;
  endpoint: string | null;
  tunnelIp: string | null;
}

const EMPTY_STATE: VpnState = {
  status: 'disconnected',
  config: '',
  dns: '',
  killSwitch: true,
  error: null,
  endpoint: null,
  tunnelIp: null,
};

function StatusDot({ status }: { status: VpnStatus }) {
  const colors: Record<VpnStatus, string> = {
    disconnected: 'bg-content/20',
    connecting: 'bg-caution animate-pulse',
    connected: 'bg-allowed animate-pulse',
    error: 'bg-denied',
  };
  return <span className={`size-2 rounded-full ${colors[status]}`} />;
}

function StatusLabel({ status }: { status: VpnStatus }) {
  const labels: Record<VpnStatus, { text: string; color: string }> = {
    disconnected: { text: 'Disconnected', color: 'text-content/50' },
    connecting: { text: 'Connecting...', color: 'text-caution' },
    connected: { text: 'Connected', color: 'text-allowed' },
    error: { text: 'Error', color: 'text-denied' },
  };
  const { text, color } = labels[status];
  return <span className={`text-sm font-medium ${color}`}>{text}</span>;
}

function ShieldIcon({ status }: { status: VpnStatus }) {
  const color = status === 'connected' ? 'text-allowed' : status === 'error' ? 'text-denied' : 'text-content/20';
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`size-16 ${color} transition-colors duration-300`}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      {status === 'connected' && <polyline points="9 12 11 14 15 10" />}
      {status === 'error' && <><path d="M12 8v4" /><path d="M12 16h.01" /></>}
    </svg>
  );
}

export default function VpnView() {
  const { activeVenv, activeVenvId } = useVenvs();
  const [vpn, setVpn] = useState<VpnState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [configDraft, setConfigDraft] = useState('');
  const [dnsDraft, setDnsDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load settings + backend VPN status
  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, backendState] = await Promise.all([
        getSettings(activeVenvId ?? undefined),
        vpnStatus().catch((): BackendVpnState => ({ status: 'disconnected', error: null, endpoint: null, tunnel_ip: null })),
      ]);
      const get = (id: string) => settings.find((s: ResolvedSetting) => s.id === id);
      const configSetting = get('vpn.config');
      const dnsSetting = get('vpn.dns');
      const killSwitchSetting = get('vpn.kill_switch');

      const configContent = typeof configSetting?.effective_value === 'object' && configSetting?.effective_value !== null
        ? (configSetting.effective_value as { content: string }).content
        : '';

      setVpn({
        status: backendState.status,
        config: configContent,
        dns: String(dnsSetting?.effective_value ?? ''),
        killSwitch: killSwitchSetting?.effective_value === true,
        error: backendState.error,
        endpoint: backendState.endpoint,
        tunnelIp: backendState.tunnel_ip,
      });
      setConfigDraft(configContent);
      setDnsDraft(String(dnsSetting?.effective_value ?? ''));
    } catch (e) {
      setVpn(prev => ({ ...prev, error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [activeVenvId]);

  useEffect(() => { loadState(); }, [loadState]);

  // Poll VPN status while connecting
  useEffect(() => {
    if (vpn.status === 'connecting') {
      pollRef.current = setInterval(async () => {
        try {
          const state = await vpnStatus();
          if (state.status !== 'connecting') {
            setVpn(prev => ({ ...prev, status: state.status, error: state.error, endpoint: state.endpoint, tunnelIp: state.tunnel_ip }));
          }
        } catch { /* ignore poll errors */ }
      }, 1000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [vpn.status]);

  const handleToggle = useCallback(async () => {
    if (vpn.status === 'connected' || vpn.status === 'connecting') {
      // Disconnect
      setVpn(prev => ({ ...prev, status: 'disconnected', error: null, endpoint: null, tunnelIp: null }));
      try {
        await vpnDisconnect();
      } catch (e) {
        setVpn(prev => ({ ...prev, error: String(e), status: 'error' }));
      }
    } else {
      // Connect -- need a config
      const cfg = configDraft || vpn.config;
      if (!cfg.trim()) {
        setVpn(prev => ({ ...prev, error: 'Paste a WireGuard configuration before connecting' }));
        return;
      }
      setConnecting(true);
      setVpn(prev => ({ ...prev, status: 'connecting', error: null }));
      try {
        // Save config to settings first
        await updateSetting('vpn.config', { path: '/etc/wireguard/wg0.conf', content: cfg }, activeVenvId ?? undefined);
        // Then connect the backend
        await vpnConnect(cfg);
        setVpn(prev => ({ ...prev, status: 'connected', config: cfg }));
      } catch (e) {
        setVpn(prev => ({ ...prev, error: String(e), status: 'error' }));
      } finally {
        setConnecting(false);
      }
    }
  }, [vpn.status, vpn.config, configDraft, activeVenvId]);

  const handleSaveConfig = useCallback(async () => {
    setSaving(true);
    try {
      await updateSetting('vpn.config', { path: '/etc/wireguard/wg0.conf', content: configDraft }, activeVenvId ?? undefined);
      await updateSetting('vpn.dns', dnsDraft, activeVenvId ?? undefined);
      setVpn(prev => ({ ...prev, config: configDraft, dns: dnsDraft }));
    } catch (e) {
      setVpn(prev => ({ ...prev, error: String(e) }));
    } finally {
      setSaving(false);
    }
  }, [configDraft, dnsDraft, activeVenvId]);

  const handleKillSwitchToggle = useCallback(async () => {
    const newVal = !vpn.killSwitch;
    setVpn(prev => ({ ...prev, killSwitch: newVal }));
    try {
      await updateSetting('vpn.kill_switch', newVal, activeVenvId ?? undefined);
    } catch (e) {
      setVpn(prev => ({ ...prev, error: String(e) }));
    }
  }, [vpn.killSwitch, activeVenvId]);

  if (!activeVenv) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-content/30 text-sm gap-2">
        <p>Select an environment to configure VPN</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="spinner w-5 h-5 text-content/30" />
      </div>
    );
  }

  const isActive = vpn.status === 'connected' || vpn.status === 'connecting';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div>
          <h2 className="text-sm font-semibold">VPN</h2>
          <p className="text-xs text-content/50 mt-0.5">
            Per-environment VPN tunnel ({activeVenv.name})
          </p>
        </div>
      </div>

      {/* Error banner */}
      {vpn.error && (
        <div className="px-4 py-2 bg-denied/10 text-denied text-xs border-b border-edge flex items-center justify-between">
          <span>{vpn.error}</span>
          <button
            className="text-denied/70 hover:text-denied text-xs"
            onClick={() => setVpn(prev => ({ ...prev, error: null }))}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-6">

          {/* Status card */}
          <div className="rounded-lg border border-edge p-5">
            <div className="flex items-center gap-5">
              <ShieldIcon status={vpn.status} />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <StatusDot status={vpn.status} />
                  <StatusLabel status={vpn.status} />
                </div>
                <p className="text-xs text-content/40">
                  {vpn.status === 'connected'
                    ? `Traffic routed through WireGuard tunnel${vpn.endpoint ? ` → ${vpn.endpoint}` : ''}`
                    : vpn.status === 'connecting'
                    ? 'Establishing WireGuard handshake...'
                    : 'VPN is not active for this environment'}
                </p>
                {vpn.status === 'connected' && vpn.tunnelIp && (
                  <p className="text-xs text-content/50 mt-0.5 font-mono">Tunnel IP: {vpn.tunnelIp}</p>
                )}
                {vpn.status === 'connected' && vpn.killSwitch && (
                  <p className="text-xs text-allowed/60 mt-1">Kill switch active</p>
                )}
              </div>
              <button
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-interactive/30 ${
                  isActive ? 'bg-interactive' : 'bg-content/15'
                }`}
                onClick={handleToggle}
                disabled={connecting}
                role="switch"
                aria-checked={isActive}
                aria-label="Toggle VPN"
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    isActive ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* WireGuard configuration */}
          <div className="rounded-lg border border-edge p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">WireGuard Configuration</h3>
                <p className="text-xs text-content/40 mt-0.5">
                  Paste your wg0.conf content below
                </p>
              </div>
              <span className="text-[10px] font-medium text-content/30 bg-content/5 px-1.5 py-0.5 rounded uppercase">
                wireguard
              </span>
            </div>

            <textarea
              className="w-full h-48 rounded-md border border-edge bg-surface-alt px-3 py-2 font-mono text-xs text-content/80 placeholder:text-content/20 focus:outline-none focus:ring-1 focus:ring-interactive/40 resize-none"
              placeholder={`[Interface]
PrivateKey = <your-private-key>
Address = 10.0.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <server-public-key>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0`}
              value={configDraft}
              onChange={(e) => setConfigDraft(e.target.value)}
              disabled={isActive}
            />

            <div className="space-y-3">
              {/* DNS */}
              <div>
                <label className="text-xs text-content/50 block mb-1">Custom DNS Servers</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-edge bg-surface-alt px-3 py-1.5 text-xs text-content/80 placeholder:text-content/20 focus:outline-none focus:ring-1 focus:ring-interactive/40"
                  placeholder="1.1.1.1, 8.8.8.8"
                  value={dnsDraft}
                  onChange={(e) => setDnsDraft(e.target.value)}
                  disabled={isActive}
                />
              </div>

              {/* Kill switch */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium">Kill Switch</span>
                  <p className="text-[10px] text-content/40">Block all traffic if tunnel drops</p>
                </div>
                <button
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                    vpn.killSwitch ? 'bg-interactive' : 'bg-content/15'
                  }`}
                  onClick={handleKillSwitchToggle}
                  role="switch"
                  aria-checked={vpn.killSwitch}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      vpn.killSwitch ? 'translate-x-4.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Save button */}
            <div className="flex justify-end pt-1">
              <button
                className="px-3 py-1.5 text-xs rounded-md bg-interactive text-on-interactive hover:opacity-90 transition-opacity font-medium disabled:opacity-50"
                onClick={handleSaveConfig}
                disabled={saving || isActive || (configDraft === vpn.config && dnsDraft === vpn.dns)}
              >
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

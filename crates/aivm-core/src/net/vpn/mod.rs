/// Per-venv VPN module.
///
/// Each venv can independently enable a WireGuard VPN tunnel. Traffic from the MITM
/// proxy's upstream connections is routed through the tunnel instead of direct TCP.
pub mod config;
pub mod tunnel;

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use config::WireGuardConfig;
use tunnel::WgTunnel;

/// VPN connection status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VpnStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// Serializable VPN state for the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VpnState {
    pub status: VpnStatus,
    /// Human-readable error message if status is Error.
    pub error: Option<String>,
    /// WireGuard endpoint address (if connected/connecting).
    pub endpoint: Option<String>,
    /// Tunnel IP address assigned to this client (from [Interface] Address).
    pub tunnel_ip: Option<String>,
}

impl Default for VpnState {
    fn default() -> Self {
        Self {
            status: VpnStatus::Disconnected,
            error: None,
            endpoint: None,
            tunnel_ip: None,
        }
    }
}

/// Per-venv VPN manager. Owns the WireGuard tunnel and exposes an async interface
/// for the MITM proxy to route connections through.
pub struct VpnManager {
    state: Mutex<VpnManagerInner>,
}

struct VpnManagerInner {
    status: VpnStatus,
    error: Option<String>,
    tunnel: Option<Arc<WgTunnel>>,
    config: Option<WireGuardConfig>,
    /// Handle to the background poll task.
    poll_task: Option<tokio::task::JoinHandle<()>>,
}

impl VpnManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(VpnManagerInner {
                status: VpnStatus::Disconnected,
                error: None,
                tunnel: None,
                config: None,
                poll_task: None,
            }),
        }
    }

    /// Connect to the VPN using the given WireGuard configuration string.
    pub async fn connect(&self, config_str: &str) -> Result<(), String> {
        let mut inner = self.state.lock().await;

        // Parse config.
        let wg_config = config::parse(config_str)?;
        let endpoint_str = wg_config.peer.endpoint.to_string();

        inner.status = VpnStatus::Connecting;
        inner.error = None;
        inner.config = Some(wg_config.clone());

        // Create tunnel (blocking: UDP bind + handshake init).
        let tunnel = match WgTunnel::new(&wg_config) {
            Ok(t) => Arc::new(t),
            Err(e) => {
                inner.status = VpnStatus::Error;
                inner.error = Some(e.clone());
                return Err(e);
            }
        };

        // Start background poll task to drive the tunnel.
        let poll_tunnel = Arc::clone(&tunnel);
        let poll_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(5));
            loop {
                interval.tick().await;
                if let Err(e) = poll_tunnel.poll() {
                    warn!("VPN poll error: {e}");
                    break;
                }
            }
        });

        inner.tunnel = Some(tunnel);
        inner.poll_task = Some(poll_task);

        // Wait for handshake to complete (up to 10 seconds).
        let tunnel_ref = inner.tunnel.as_ref().unwrap().clone();
        drop(inner); // Release lock while waiting.

        let handshake_ok = tokio::time::timeout(
            Duration::from_secs(10),
            async {
                loop {
                    if tunnel_ref.is_established() {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
        ).await;

        let mut inner = self.state.lock().await;
        match handshake_ok {
            Ok(true) => {
                inner.status = VpnStatus::Connected;
                info!("VPN connected to {endpoint_str}");
                Ok(())
            }
            _ => {
                // Handshake timed out — clean up.
                let err = "WireGuard handshake timed out (10s)".to_string();
                inner.status = VpnStatus::Error;
                inner.error = Some(err.clone());
                if let Some(task) = inner.poll_task.take() {
                    task.abort();
                }
                inner.tunnel = None;
                Err(err)
            }
        }
    }

    /// Disconnect the VPN tunnel.
    pub async fn disconnect(&self) {
        let mut inner = self.state.lock().await;
        if let Some(task) = inner.poll_task.take() {
            task.abort();
        }
        inner.tunnel = None;
        inner.config = None;
        inner.status = VpnStatus::Disconnected;
        inner.error = None;
        info!("VPN disconnected");
    }

    /// Get the current VPN state (for frontend display).
    pub async fn get_state(&self) -> VpnState {
        let inner = self.state.lock().await;
        VpnState {
            status: inner.status,
            error: inner.error.clone(),
            endpoint: inner.config.as_ref().map(|c| c.peer.endpoint.to_string()),
            tunnel_ip: inner.config.as_ref().map(|c| c.interface.address.to_string()),
        }
    }

    /// Get the active tunnel (if connected) for routing upstream connections.
    pub async fn get_tunnel(&self) -> Option<Arc<WgTunnel>> {
        let inner = self.state.lock().await;
        if inner.status == VpnStatus::Connected {
            inner.tunnel.clone()
        } else {
            None
        }
    }

    /// Create an async TCP stream through the VPN tunnel to the given address.
    /// This is used by the MITM proxy to route upstream connections through VPN.
    pub async fn connect_tcp(&self, addr: Ipv4Addr, port: u16) -> Result<VpnTcpStream, String> {
        let tunnel = self.get_tunnel().await
            .ok_or("VPN not connected")?;

        let handle = tunnel.tcp_connect(addr, port)?;

        // Wait for TCP connection to fully establish (SYN-ACK → ESTABLISHED).
        // `tcp_may_send()` is only true once the 3-way handshake completes,
        // unlike `tcp_is_active()` which is true as soon as SYN is sent.
        let connected = tokio::time::timeout(
            Duration::from_secs(30),
            async {
                loop {
                    // Poll the tunnel to drive TCP state machine.
                    let _ = tunnel.poll();
                    if tunnel.tcp_may_send(handle) {
                        return true;
                    }
                    // If the socket is no longer active, the connection failed.
                    if !tunnel.tcp_is_active(handle) {
                        return false;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            },
        ).await;

        match connected {
            Ok(true) => {
                debug!("VPN TCP connected to {addr}:{port}");
                Ok(VpnTcpStream {
                    tunnel,
                    handle,
                })
            }
            Ok(false) => {
                tunnel.tcp_close(handle);
                Err(format!("VPN TCP connect to {addr}:{port} refused"))
            }
            Err(_) => {
                tunnel.tcp_close(handle);
                Err(format!("VPN TCP connect to {addr}:{port} timed out"))
            }
        }
    }
}

/// An async TCP stream routed through the VPN tunnel.
/// Implements tokio AsyncRead + AsyncWrite so it can be used as a drop-in
/// replacement for `tokio::net::TcpStream` in the MITM proxy.
pub struct VpnTcpStream {
    tunnel: Arc<WgTunnel>,
    handle: smoltcp::iface::SocketHandle,
}

impl VpnTcpStream {
    /// Check if the underlying TCP connection is still active.
    pub fn is_active(&self) -> bool {
        self.tunnel.tcp_is_active(self.handle)
    }
}

impl Drop for VpnTcpStream {
    fn drop(&mut self) {
        self.tunnel.tcp_close(self.handle);
    }
}

impl AsyncRead for VpnTcpStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        // Poll the tunnel to process incoming data.
        let _ = self.tunnel.poll();

        let mut temp = vec![0u8; buf.remaining()];
        match self.tunnel.tcp_read(self.handle, &mut temp) {
            Ok(0) => {
                // No data yet, schedule a wakeup.
                cx.waker().wake_by_ref();
                std::task::Poll::Pending
            }
            Ok(n) => {
                buf.put_slice(&temp[..n]);
                std::task::Poll::Ready(Ok(()))
            }
            Err(e) if e.contains("closed") || e.contains("finished") => {
                std::task::Poll::Ready(Ok(())) // EOF
            }
            Err(e) => {
                std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e,
                )))
            }
        }
    }
}

impl AsyncWrite for VpnTcpStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        // Poll the tunnel to flush outgoing data.
        let _ = self.tunnel.poll();

        match self.tunnel.tcp_write(self.handle, buf) {
            Ok(0) => {
                cx.waker().wake_by_ref();
                std::task::Poll::Pending
            }
            Ok(n) => std::task::Poll::Ready(Ok(n)),
            Err(e) => {
                std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e,
                )))
            }
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        let _ = self.tunnel.poll();
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        self.tunnel.tcp_close(self.handle);
        std::task::Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vpn_state_default() {
        let state = VpnState::default();
        assert_eq!(state.status, VpnStatus::Disconnected);
        assert!(state.error.is_none());
        assert!(state.endpoint.is_none());
    }

    #[test]
    fn vpn_status_serializes() {
        assert_eq!(
            serde_json::to_string(&VpnStatus::Connected).unwrap(),
            "\"connected\""
        );
        assert_eq!(
            serde_json::to_string(&VpnStatus::Disconnected).unwrap(),
            "\"disconnected\""
        );
    }

    #[tokio::test]
    async fn vpn_manager_initial_state() {
        let mgr = VpnManager::new();
        let state = mgr.get_state().await;
        assert_eq!(state.status, VpnStatus::Disconnected);
        assert!(state.endpoint.is_none());
    }

    #[tokio::test]
    async fn vpn_manager_get_tunnel_when_disconnected() {
        let mgr = VpnManager::new();
        assert!(mgr.get_tunnel().await.is_none());
    }

    #[tokio::test]
    async fn vpn_manager_connect_invalid_config() {
        let mgr = VpnManager::new();
        let result = mgr.connect("garbage").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn vpn_manager_disconnect_when_already_disconnected() {
        let mgr = VpnManager::new();
        mgr.disconnect().await; // Should not panic.
        let state = mgr.get_state().await;
        assert_eq!(state.status, VpnStatus::Disconnected);
    }
}

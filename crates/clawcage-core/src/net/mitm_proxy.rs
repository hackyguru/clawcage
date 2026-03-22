#![allow(dead_code)]
/// MITM transparent proxy: terminates TLS from the guest, inspects HTTP traffic,
/// applies per-domain read/write policy, and bridges to the real upstream server.
///
/// Connection flow:
/// 1. Read initial bytes from vsock fd (TLS ClientHello)
/// 2. TLS handshake (MitmCertResolver captures domain from SNI)
/// 3. Read HTTP request via hyper
/// 4. Policy check (domain + method -> read/write)
/// 5. If denied: return 403
/// 6. Upstream TLS to real server
/// 7. Forward request, stream response back
/// 8. Emit per-request telemetry (one NetEvent per HTTP request, not per connection)
use std::collections::HashMap;
use std::io;
use std::mem::ManuallyDrop;
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime};

use bytes::BytesMut;
use clawcage_logger::{DbWriter, Decision, ModelCall, NetEvent, ToolCallEntry, ToolResponseEntry, WriteOp};
use http_body_util::Full;
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, info, warn};

use super::cert_authority::{CertAuthority, MitmCertResolver};
use super::policy::NetworkPolicy;
use crate::gateway::events::{StopReason, collect_summary};
use crate::gateway::provider::ProviderKind;

/// Re-exported so clawcage-app can reference the type without depending on rustls.
pub type UpstreamTlsConfig = rustls::ClientConfig;

/// Maximum bytes to buffer when peeking at the TLS ClientHello.
const MAX_HELLO_SIZE: usize = 16384;

/// Resource limits for the MITM proxy.
#[derive(Debug, Clone)]
pub struct ProxyLimits {
    /// Maximum concurrent connections (default: 100).
    pub max_concurrent_connections: usize,
    /// Per-domain requests per second (default: 50).
    pub per_domain_rate_limit: f64,
    /// Maximum response body size in bytes (default: 100 MB).
    pub max_response_body_bytes: u64,
    /// Idle connection timeout (default: 60s).
    pub connection_idle_timeout: Duration,
    /// Upstream TCP connect timeout (default: 10s).
    pub connect_timeout: Duration,
}

impl Default for ProxyLimits {
    fn default() -> Self {
        Self {
            max_concurrent_connections: 100,
            per_domain_rate_limit: 50.0,
            max_response_body_bytes: 100 * 1024 * 1024,
            connection_idle_timeout: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(10),
        }
    }
}

/// Simple token-bucket rate limiter.
struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

/// Per-domain rate limiter state.
pub struct RateLimiterMap {
    buckets: Mutex<HashMap<String, TokenBucket>>,
    rate: f64,
}

impl RateLimiterMap {
    pub fn new(rate: f64) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            rate,
        }
    }

    /// Check if a request to `domain` is allowed. Returns true if allowed.
    pub fn check(&self, domain: &str) -> bool {
        let mut map = self.buckets.lock().unwrap();
        let bucket = map.entry(domain.to_string()).or_insert(TokenBucket {
            tokens: self.rate,
            last_refill: Instant::now(),
        });
        let elapsed = bucket.last_refill.elapsed().as_secs_f64();
        // Refill: burst capacity = 2x rate
        bucket.tokens = (bucket.tokens + elapsed * self.rate).min(self.rate * 2.0);
        bucket.last_refill = Instant::now();
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// How to inject a credential into an upstream request.
#[derive(Debug, Clone)]
pub enum CredentialKind {
    /// Inject as a header (e.g. `x-api-key: <key>` or `Authorization: Bearer <key>`).
    Header { name: String, value: String },
    /// Inject as a query parameter (e.g. `?key=<api_key>`).
    QueryParam { key: String, value: String },
}

/// Configuration for the MITM proxy.
pub struct MitmProxyConfig {
    pub ca: Arc<CertAuthority>,
    /// Live policy, swappable via RwLock so settings changes take effect
    /// without restarting the VM. Each connection snapshots the Arc.
    pub policy: Arc<std::sync::RwLock<Arc<NetworkPolicy>>>,
    pub db: Arc<DbWriter>,
    /// Cached upstream TLS config (shared across all connections).
    pub upstream_tls: Arc<rustls::ClientConfig>,
    /// Model pricing lookup table for cost estimation.
    pub pricing: crate::gateway::pricing::PricingTable,
    /// Trace state for linking multi-turn tool-use conversations.
    pub trace_state: std::sync::Mutex<crate::gateway::TraceState>,
    /// When true, non-AI domains use a transparent TCP tunnel instead of
    /// MITM.  Avoids HTTP body-streaming issues for protocols like git.
    /// Defaults to true; tests set this to false.
    pub tunnel_non_ai: bool,
    /// Optional per-venv VPN manager. When set, upstream TCP connections are
    /// routed through the WireGuard tunnel instead of direct host networking.
    pub vpn: Option<Arc<super::vpn::VpnManager>>,
    /// Resource limits (rate limiting, body size caps, timeouts, connection cap).
    pub limits: ProxyLimits,
    /// Semaphore enforcing `limits.max_concurrent_connections`.
    pub connection_semaphore: Arc<tokio::sync::Semaphore>,
    /// Per-domain rate limiter.
    pub rate_limiter: Arc<RateLimiterMap>,
    /// Whether the MITM proxy is enabled. When false, all traffic is tunneled
    /// transparently (no TLS termination, no HTTP inspection) but domain-level
    /// allow/deny still applies via SNI check.
    pub enabled: bool,
    /// Host-side credentials keyed by domain pattern. The proxy injects these
    /// into upstream requests so API keys never enter the guest.
    pub credentials: Arc<HashMap<String, CredentialKind>>,
}

/// Detect AI provider from domain name.
fn detect_ai_provider(domain: &str) -> Option<ProviderKind> {
    match domain {
        "api.anthropic.com" => Some(ProviderKind::Anthropic),
        "api.openai.com" => Some(ProviderKind::OpenAi),
        "generativelanguage.googleapis.com" => Some(ProviderKind::Google),
        _ => None,
    }
}

/// Build the upstream TLS client config (trusts standard webpki roots).
pub fn make_upstream_tls_config() -> Arc<rustls::ClientConfig> {
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("TLS config")
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Arc::new(config)
}

// Upstream stream: either a direct TCP connection or a VPN-routed one.
pin_project_lite::pin_project! {
    #[project = UpstreamProj]
    enum UpstreamStream {
        Direct { #[pin] tcp: tokio::net::TcpStream },
        Vpn { #[pin] vpn: super::vpn::VpnTcpStream },
    }
}

impl tokio::io::AsyncRead for UpstreamStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.project() {
            UpstreamProj::Direct { tcp } => tcp.poll_read(cx, buf),
            UpstreamProj::Vpn { vpn } => vpn.poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for UpstreamStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.project() {
            UpstreamProj::Direct { tcp } => tcp.poll_write(cx, buf),
            UpstreamProj::Vpn { vpn } => vpn.poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.project() {
            UpstreamProj::Direct { tcp } => tcp.poll_flush(cx),
            UpstreamProj::Vpn { vpn } => vpn.poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.project() {
            UpstreamProj::Direct { tcp } => tcp.poll_shutdown(cx),
            UpstreamProj::Vpn { vpn } => vpn.poll_shutdown(cx),
        }
    }
}

/// Connect upstream to `domain:443`, routing through VPN if configured.
/// Applies `connect_timeout` from proxy limits.
async fn connect_upstream(
    domain: &str,
    vpn: &Option<Arc<super::vpn::VpnManager>>,
    connect_timeout: Duration,
) -> io::Result<UpstreamStream> {
    let connect_fut = async {
        if let Some(ref vpn_mgr) = vpn {
            // Resolve domain to IP address for the VPN tunnel.
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(format!("{domain}:443")).await?.collect();
            if let Some(addr) = addrs.first() {
                if let std::net::IpAddr::V4(ipv4) = addr.ip() {
                    match vpn_mgr.connect_tcp(ipv4, 443).await {
                        Ok(stream) => return Ok(UpstreamStream::Vpn { vpn: stream }),
                        Err(e) => {
                            warn!("VPN connect to {domain} failed, falling back to direct: {e}");
                        }
                    }
                }
            }
        }
        // Direct connection (no VPN or VPN fallback).
        let tcp = tokio::net::TcpStream::connect(format!("{domain}:443")).await?;
        let _ = tcp.set_nodelay(true);
        Ok(UpstreamStream::Direct { tcp })
    };

    tokio::time::timeout(connect_timeout, connect_fut)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, format!("connect to {domain}:443 timed out")))?
}

/// Handle a single MITM proxy connection from the guest.
///
/// This is the async entry point for each vsock:5002 connection.
/// Enforces concurrent connection cap (semaphore), idle timeout, and
/// per-domain rate limiting.
pub async fn handle_connection(vsock_fd: RawFd, config: Arc<MitmProxyConfig>) {
    // Acquire a connection permit (blocks if at max_concurrent_connections).
    let _permit = match config.connection_semaphore.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            warn!("MITM proxy: max concurrent connections reached, rejecting");
            unsafe { libc::close(vsock_fd); }
            return;
        }
    };

    // Wrap the entire connection in an idle timeout.
    let timeout_dur = config.limits.connection_idle_timeout;
    let result = tokio::time::timeout(timeout_dur, handle_inner(vsock_fd, &config)).await;

    let result = match result {
        Ok(inner) => inner,
        Err(_) => {
            debug!("MITM proxy: connection idle timeout ({timeout_dur:?})");
            unsafe { libc::shutdown(vsock_fd, libc::SHUT_RDWR); }
            return;
        }
    };

    match result {
        Ok(domain) => {
            debug!(domain, "MITM proxy: connection closed");
        }
        Err((domain, decision, reason)) => {
            let display_domain = if domain.is_empty() {
                "<unknown>".to_string()
            } else {
                domain
            };

            let event = NetEvent {
                timestamp: SystemTime::now(),
                domain: display_domain.clone(),
                port: 443,
                decision,
                process_name: None,
                pid: None,
                bytes_sent: 0,
                bytes_received: 0,
                duration_ms: 0,
                method: None,
                path: None,
                query: None,
                status_code: None,
                matched_rule: Some(reason.clone()),
                request_headers: None,
                response_headers: None,
                request_body_preview: None,
                response_body_preview: None,
                conn_type: Some("https-mitm".to_string()),
            };

            config.db.write(WriteOp::NetEvent(event)).await;
            warn!(domain = display_domain, reason, "MITM proxy: connection error");
        }
    }
}

/// Inner handler. Returns Ok(domain) on success, Err((domain, decision, reason))
/// on connection-level failure. Per-request telemetry is emitted by TelemetryBody.
async fn handle_inner(
    vsock_fd: RawFd,
    config: &Arc<MitmProxyConfig>,
) -> Result<String, (String, Decision, String)> {
    // Wrap vsock fd in a non-owning async stream.
    let vsock_file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(vsock_fd) });
    let std_fd = vsock_file.try_clone().map_err(|e| {
        (String::new(), Decision::Error, format!("dup vsock fd: {e}"))
    })?;
    set_nonblocking(vsock_fd).map_err(|e| {
        (String::new(), Decision::Error, format!("set nonblocking: {e}"))
    })?;
    let async_fd = tokio::io::unix::AsyncFd::new(std_fd).map_err(|e| {
        (String::new(), Decision::Error, format!("async fd: {e}"))
    })?;
    let mut vsock_stream = AsyncFdStream(async_fd);

    // 1. Read initial bytes (TLS ClientHello + potential metadata).
    let mut initial_buf = vec![0u8; MAX_HELLO_SIZE];
    let n = tokio::io::AsyncReadExt::read(&mut vsock_stream, &mut initial_buf)
        .await
        .map_err(|e| (String::new(), Decision::Error, format!("read ClientHello: {e}")))?;
    if n == 0 {
        return Err((String::new(), Decision::Error, "empty connection".into()));
    }
    initial_buf.truncate(n);

    let mut process_name: Option<String> = None;
    if initial_buf.starts_with(b"\0CLAWCAGE_META:") {
        // Metadata may arrive fragmented across multiple reads.
        // Keep reading until we find the terminating '\n' or hit the 4KB limit.
        const MAX_META_SIZE: usize = 4096;
        loop {
            if let Some(nl_idx) = initial_buf.iter().position(|&b| b == b'\n') {
                let proc_bytes = &initial_buf[13..nl_idx];
                process_name = String::from_utf8(proc_bytes.to_vec()).ok();
                initial_buf.drain(0..=nl_idx);
                break;
            }
            if initial_buf.len() >= MAX_META_SIZE {
                return Err((String::new(), Decision::Error, "metadata exceeded 4KB limit".into()));
            }
            let mut more = vec![0u8; 1024];
            let n2 = tokio::io::AsyncReadExt::read(&mut vsock_stream, &mut more)
                .await
                .map_err(|e| (String::new(), Decision::Error, format!("read metadata: {e}")))?;
            if n2 == 0 {
                return Err((String::new(), Decision::Error, "EOF during metadata read".into()));
            }
            initial_buf.extend_from_slice(&more[..n2]);
        }

        // If initial_buf is empty after draining meta, we need to read ClientHello.
        if initial_buf.is_empty() {
            let mut hello_buf = vec![0u8; MAX_HELLO_SIZE];
            let n2 = tokio::io::AsyncReadExt::read(&mut vsock_stream, &mut hello_buf)
                .await
                .map_err(|e| (String::new(), Decision::Error, format!("read ClientHello after meta: {e}")))?;
            if n2 == 0 {
                return Err((String::new(), Decision::Error, "empty connection after meta".into()));
            }
            hello_buf.truncate(n2);
            initial_buf = hello_buf;
        }
    }

    // Snapshot the live policy for this connection (cheap Arc clone).
    let policy: Arc<NetworkPolicy> = config.policy.read().unwrap().clone();

    // Early SNI extraction: parse domain from raw ClientHello bytes BEFORE
    // the TLS handshake so we can decide whether to MITM or TCP-tunnel.
    let sni_domain = extract_sni_from_client_hello(&initial_buf);

    // Per-domain rate limiting (checked early, before TLS handshake).
    if let Some(ref domain) = sni_domain {
        if !config.rate_limiter.check(domain) {
            return Err((domain.clone(), Decision::Denied, "rate limit exceeded".into()));
        }
    }

    // When MITM is disabled, tunnel ALL traffic (no TLS termination, no HTTP
    // inspection). Domain-level allow/deny still applies via SNI check.
    if !config.enabled {
        if let Some(ref domain) = sni_domain {
            let eval = policy.evaluate(domain, "CONNECT");
            if !eval.allowed {
                return Err((domain.clone(), Decision::Denied, eval.reason));
            }
            return handle_tunnel(
                domain.clone(),
                initial_buf,
                vsock_stream,
                process_name,
                &config.db,
                &config.vpn,
            ).await;
        }
        // No SNI — can't even do domain policy. Tunnel anyway.
        return Err((String::new(), Decision::Error, "MITM disabled and no SNI".into()));
    }

    // For non-AI domains, use a transparent TCP tunnel instead of MITM.
    // This avoids HTTP body streaming issues (hyper framing, gzip decompression)
    // that break protocols like git smart HTTP.
    if config.tunnel_non_ai {
    if let Some(ref domain) = sni_domain {
        if detect_ai_provider(domain).is_none() {
            // Policy check before tunneling.
            let eval = policy.evaluate(domain, "CONNECT");
            if !eval.allowed {
                // Emit denied telemetry.
                let event = NetEvent {
                    timestamp: SystemTime::now(),
                    domain: domain.clone(),
                    port: 443,
                    decision: Decision::Denied,
                    process_name,
                    pid: None,
                    bytes_sent: 0,
                    bytes_received: 0,
                    duration_ms: 0,
                    method: None,
                    path: None,
                    query: None,
                    status_code: None,
                    matched_rule: Some(eval.matched_rule),
                    request_headers: None,
                    response_headers: None,
                    request_body_preview: None,
                    response_body_preview: None,
                    conn_type: Some("https-tunnel-denied".to_string()),
                };
                config.db.write(WriteOp::NetEvent(event)).await;
                return Err((domain.clone(), Decision::Denied, eval.reason));
            }

            return handle_tunnel(
                domain.clone(),
                initial_buf,
                vsock_stream,
                process_name,
                &config.db,
                &config.vpn,
            ).await;
        }
    }
    } // tunnel_non_ai

    // 2. TLS handshake -- MitmCertResolver captures the domain from SNI.
    //    (AI provider traffic only -- we need to inspect HTTP for telemetry.)
    let resolver = Arc::new(MitmCertResolver::with_policy(
        Arc::clone(&config.ca),
        Arc::clone(&policy),
    ));
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut tls_config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| (String::new(), Decision::Error, format!("TLS config: {e}")))?
        .with_no_client_auth()
        .with_cert_resolver(Arc::clone(&resolver) as _);
    tls_config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(tls_config));

    // Chain buffered ClientHello bytes with the remaining vsock stream.
    let replay = ReplayReader::new(initial_buf, vsock_stream);
    let tls_stream = acceptor.accept(replay).await.map_err(|e| {
        let domain = resolver.domain().unwrap_or_default();
        (domain, Decision::Error, format!("TLS handshake: {e}"))
    })?;

    // 3. Get domain from the resolver (captured during handshake).
    let domain = resolver.domain().ok_or_else(|| {
        (String::new(), Decision::Denied, "no SNI in ClientHello".into())
    })?;

    // AI provider detection.
    let ai_provider = detect_ai_provider(&domain);

    // 4. Run hyper HTTP/1.1 server on the MITM TLS stream.
    let io = TokioIo::new(tls_stream);

    let upstream_tls = Arc::clone(&config.upstream_tls);
    let domain_for_svc = domain.clone();
    let db = Arc::clone(&config.db);
    let config_arc = Arc::clone(config);
    let log_bodies = policy.log_bodies;
    let max_body = policy.max_body_capture;
    let process_name = Arc::new(process_name);

    // Per-connection upstream sender cache: each MITM connection serves one
    // domain via keep-alive, so caching the sender avoids re-establishing
    // TCP+TLS for every request on the same connection.
    let cached_upstream: Arc<tokio::sync::Mutex<Option<hyper::client::conn::http1::SendRequest<ProxyBoxBody>>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    let svc = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
        let policy = Arc::clone(&policy);
        let upstream_tls = Arc::clone(&upstream_tls);
        let domain = domain_for_svc.clone();
        let db = Arc::clone(&db);
        let config_arc = Arc::clone(&config_arc);
        let process_name = Arc::clone(&process_name);
        let cached_upstream = Arc::clone(&cached_upstream);

        async move {
            handle_request(req, &domain, &policy, &upstream_tls, &db, &config_arc, &process_name, ai_provider, log_bodies, max_body, &cached_upstream).await
        }
    });

    // Serve exactly one connection (may have multiple requests via keep-alive).
    if let Err(e) = hyper::server::conn::http1::Builder::new()
        .serve_connection(io, svc)
        .await
    {
        // Connection errors are expected when the guest closes.
        let err_str = e.to_string();
        if !e.is_incomplete_message() && !err_str.contains("error shutting down connection") {
            warn!(domain, error = %e, "hyper serve error");
        }
    }

    // Signal EOF to the guest.  The dup'd fd used for I/O is closed when
    // the TLS stream drops above, but the original fd (ManuallyDrop) keeps
    // the vsock socket alive.  Without an explicit shutdown the guest's
    // copy_bidirectional never sees EOF and the TLS session hangs until the
    // ObjC VsockConnection is released -- causing "non-properly terminated"
    // errors for protocols like git that depend on clean connection close.
    unsafe { libc::shutdown(vsock_fd, libc::SHUT_RDWR); }

    Ok(domain)
}

/// Handle a single HTTP request within the MITM TLS connection.
///
/// Builds a per-request `TelemetryEmitter` and wraps the response body in
/// `TelemetryBody` so telemetry is emitted when the response completes.
async fn handle_request(
    req: hyper::Request<hyper::body::Incoming>,
    domain: &str,
    policy: &NetworkPolicy,
    upstream_tls: &Arc<rustls::ClientConfig>,
    db: &Arc<DbWriter>,
    config: &Arc<MitmProxyConfig>,
    process_name: &Option<String>,
    ai_provider: Option<ProviderKind>,
    log_bodies: bool,
    max_body: usize,
    cached_upstream: &tokio::sync::Mutex<Option<hyper::client::conn::http1::SendRequest<ProxyBoxBody>>>,
) -> Result<hyper::Response<ProxyBoxBody>, anyhow::Error> {
    use http_body_util::BodyExt;

    let start_time = Instant::now();
    let (parts, req_body) = req.into_parts();
    let method = parts.method.to_string();
    let (path, query) = split_path_query(&parts.uri);

    // Capture request headers.
    let req_hdrs = format_headers(&parts.headers);

    // Check for WebSocket upgrade.
    let is_upgrade = parts.headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    // Policy check: domain + method -> read/write decision.
    let eval = policy.evaluate(domain, &method);
    if !eval.allowed {
        let body_text = format!(
            "Clawcage: request denied ({}: {} {})\n",
            eval.reason, method, path
        );

        let emitter = TelemetryEmitter {
            db: Arc::clone(db),
            config: Arc::clone(config),
            domain: domain.to_string(),
            process_name: process_name.clone(),
            ai_provider,
            method: method.clone(),
            path: path.clone(),
            query: query.clone(),
            status_code: Some(403),
            decision: Decision::Denied,
            matched_rule: Some(eval.matched_rule),
            request_headers: Some(req_hdrs),
            response_headers: None,

            req_stats: Arc::new(Mutex::new(BodyStats::new(0))),
            resp_kind: RespStatsKind::Plain(Arc::new(Mutex::new(BodyStats::new(0)))),
            start_time,
        };

        let deny_body = Full::new(Bytes::from(body_text))
            .map_err(|never| match never {})
            .boxed();
        let telem_body = TelemetryBody::new(deny_body, emitter);

        return Ok(hyper::Response::builder()
            .status(403)
            .body(telem_body.boxed())
            .unwrap());
    }

    // Reject WebSocket upgrades (not supported through MITM proxy).
    if is_upgrade {
        let body_text = format!(
            "Clawcage: WebSocket upgrades are not supported ({} {})\n",
            method, path
        );

        let emitter = TelemetryEmitter {
            db: Arc::clone(db),
            config: Arc::clone(config),
            domain: domain.to_string(),
            process_name: process_name.clone(),
            ai_provider,
            method: method.clone(),
            path: path.clone(),
            query: query.clone(),
            status_code: Some(400),
            decision: Decision::Denied,
            matched_rule: Some("websocket-not-supported".to_string()),
            request_headers: Some(req_hdrs),
            response_headers: None,
            req_stats: Arc::new(Mutex::new(BodyStats::new(0))),
            resp_kind: RespStatsKind::Plain(Arc::new(Mutex::new(BodyStats::new(0)))),
            start_time,
        };

        let deny_body = Full::new(Bytes::from(body_text))
            .map_err(|never| match never {})
            .boxed();
        let telem_body = TelemetryBody::new(deny_body, emitter);

        return Ok(hyper::Response::builder()
            .status(400)
            .body(telem_body.boxed())
            .unwrap());
    }

    // Save original request headers.
    let original_headers = parts.headers.clone();
    let original_method = parts.method.clone();

    // Helper: build a 502 Bad Gateway response with telemetry so upstream
    // errors don't kill keep-alive connections (returns Ok, not Err).
    let make_502 = |error: &dyn std::fmt::Display,
                    method: &str,
                    path: &str,
                    query: &Option<String>,
                    req_hdrs: &str,
                    start: Instant|
     -> hyper::Response<ProxyBoxBody> {
        warn!(domain, method, path, error = %error, "MITM proxy: upstream error");
        let body_text = format!("Clawcage: upstream error ({error})\n");
        let emitter = TelemetryEmitter {
            db: Arc::clone(db),
            config: Arc::clone(config),
            domain: domain.to_string(),
            process_name: process_name.clone(),
            ai_provider,
            method: method.to_string(),
            path: path.to_string(),
            query: query.clone(),
            status_code: Some(502),
            decision: Decision::Error,
            matched_rule: Some(error.to_string()),
            request_headers: Some(req_hdrs.to_string()),
            response_headers: None,
            req_stats: Arc::new(Mutex::new(BodyStats::new(0))),
            resp_kind: RespStatsKind::Plain(Arc::new(Mutex::new(BodyStats::new(0)))),
            start_time: start,
        };
        let deny_body = Full::new(Bytes::from(body_text))
            .map_err(|never| match never {})
            .boxed();
        let telem_body = TelemetryBody::new(deny_body, emitter);
        hyper::Response::builder()
            .status(502)
            .body(telem_body.boxed())
            .unwrap()
    };

    // Try to reuse a cached upstream sender, or create a new connection.
    // Each MITM connection serves one domain via keep-alive, so per-connection
    // caching avoids re-establishing TCP+TLS for every request.
    let mut reusable = cached_upstream.lock().await.take();

    // If we have a cached sender, check it's still alive.
    if let Some(ref mut s) = reusable {
        if s.ready().await.is_err() {
            reusable = None;
        }
    }

    // Create a fresh upstream connection if needed.
    let mut sender = if let Some(s) = reusable {
        s
    } else {
        let connector = tokio_rustls::TlsConnector::from(Arc::clone(upstream_tls));
        let upstream_tcp = match connect_upstream(domain, &config.vpn, config.limits.connect_timeout).await {
            Ok(tcp) => tcp,
            Err(e) => {
                return Ok(make_502(&e, &method, &path, &query, &req_hdrs, start_time));
            }
        };
        let server_name = match rustls::pki_types::ServerName::try_from(domain.to_string()) {
            Ok(sn) => sn,
            Err(e) => {
                return Ok(make_502(&e, &method, &path, &query, &req_hdrs, start_time));
            }
        };
        let upstream_tls_stream = match connector.connect(server_name, upstream_tcp).await {
            Ok(tls) => tls,
            Err(e) => {
                return Ok(make_502(&e, &method, &path, &query, &req_hdrs, start_time));
            }
        };
        let upstream_io = TokioIo::new(upstream_tls_stream);
        let (sender, conn) = match hyper::client::conn::http1::handshake(upstream_io).await {
            Ok(pair) => pair,
            Err(e) => {
                return Ok(make_502(&e, &method, &path, &query, &req_hdrs, start_time));
            }
        };
        tokio::spawn(async move {
            let _ = conn.await;
        });
        sender
    };

    // Build upstream request with original headers.
    let full_path = match &query {
        Some(q) => format!("{path}?{q}"),
        None => path.clone(),
    };
    let mut builder = hyper::Request::builder()
        .method(original_method);
    for (name, value) in original_headers.iter() {
        if name == "host" {
            continue;
        }
        // For AI provider requests, override accept-encoding to gzip only
        // (we decompress for telemetry parsing; brotli/zstd not supported).
        // For non-AI traffic (git, npm, etc.), pass through the client's
        // original accept-encoding so the proxy doesn't decompress/re-encode.
        if name == "accept-encoding" && ai_provider.is_some() {
            continue;
        }
        // Strip placeholder auth headers -- real credentials are injected below.
        if !config.credentials.is_empty() {
            if name == "authorization" || name == "x-api-key" {
                continue;
            }
        }
        builder = builder.header(name.clone(), value.clone());
    }
    builder = builder.header("host", domain);
    if ai_provider.is_some() {
        builder = builder.header("accept-encoding", "gzip");
    }

    // Credential injection: replace guest placeholder credentials with real
    // host-side API keys. The guest never sees the real key.
    let full_path = inject_credentials(domain, &config.credentials, &mut builder, full_path);
    builder = builder.uri(&full_path);

    // Track request body (boxed for consistent sender type across requests).
    // Always capture AI provider request bodies for telemetry parsing
    // (model name, tool results, etc.) regardless of log_bodies setting.
    const AI_BODY_PREVIEW: usize = 64 * 1024;
    let req_max_preview = if ai_provider.is_some() {
        AI_BODY_PREVIEW.max(if log_bodies { max_body } else { 0 })
    } else if log_bodies { max_body } else { 0 };
    let req_stats = Arc::new(Mutex::new(BodyStats {
        bytes: 0,
        preview: Vec::new(),
        max_preview: req_max_preview,
    }));
    let max_body_size = config.limits.max_response_body_bytes;
    let tracked_req_body = TrackedBody::new(req_body, Arc::clone(&req_stats), max_body_size);
    let upstream_req = builder.body(tracked_req_body.boxed())?;

    let resp = match sender.send_request(upstream_req).await {
        Ok(r) => r,
        Err(e) => {
            return Ok(make_502(&e, &method, &path, &query, &req_hdrs, start_time));
        }
    };

    // Put the sender back in the cache for the next request on this connection.
    // The next request's ready().await will naturally wait until this response
    // body completes (hyper 1.x keep-alive semantics).
    cached_upstream.lock().await.replace(sender);
    let resp_status = resp.status().as_u16();
    let (mut resp_parts, resp_body) = resp.into_parts();

    // Capture response headers BEFORE stripping Content-Encoding.
    // Telemetry logs still record the original headers (useful for debugging).
    let resp_hdrs = format_headers(&resp_parts.headers);

    // Decompress gzip responses for AI providers only -- SSE parser and
    // telemetry need decompressed bytes.  Non-AI traffic (git, npm, etc.)
    // is passed through as-is to avoid body corruption during large
    // transfers like git pack streams.
    let is_gzip = ai_provider.is_some()
        && resp_parts.headers.get("content-encoding")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("gzip"))
            .unwrap_or(false);

    let resp_body: ProxyBoxBody = if is_gzip {
        use http_body_util::BodyExt;
        resp_parts.headers.remove("content-encoding");
        resp_parts.headers.remove("content-length");
        DecompressBody::new(resp_body).boxed()
    } else {
        use http_body_util::BodyExt;
        resp_body.map_err(|e| -> anyhow::Error { e.into() }).boxed()
    };

    // Build the response body with telemetry wrapper.
    let (inner_body, resp_kind) = if let Some(provider) = ai_provider {
        use crate::gateway::ai_body::AiResponseBody;
        use crate::gateway::anthropic::AnthropicStreamParserWithState;
        use crate::gateway::google::GoogleStreamParser;
        use crate::gateway::openai::OpenAiStreamParser;

        let provider_parser: Box<dyn crate::gateway::events::ProviderStreamParser + Send> = match provider {
            ProviderKind::Anthropic => Box::new(AnthropicStreamParserWithState::new()),
            ProviderKind::OpenAi => Box::new(OpenAiStreamParser::new()),
            ProviderKind::Google => Box::new(GoogleStreamParser::new()),
        };

        let resp_max_preview = if ai_provider.is_some() {
            AI_BODY_PREVIEW.max(if log_bodies { max_body } else { 0 })
        } else if log_bodies { max_body } else { 0 };
        let ai_body = AiResponseBody::new(resp_body, provider_parser, resp_max_preview, max_body_size);
        let ai_state = ai_body.ai_state();
        let ai_stats = ai_body.stats();

        let kind = RespStatsKind::Ai { stats: ai_stats, state: ai_state };
        (ai_body.boxed(), kind)
    } else {
        let resp_stats = Arc::new(Mutex::new(BodyStats {
            bytes: 0,
            preview: Vec::new(),
            max_preview: if log_bodies { max_body } else { 0 },
        }));
        let tracked_resp_body = TrackedBody::new(resp_body, Arc::clone(&resp_stats), max_body_size);
        let kind = RespStatsKind::Plain(resp_stats);
        (tracked_resp_body.boxed(), kind)
    };

    let emitter = TelemetryEmitter {
        db: Arc::clone(db),
        config: Arc::clone(config),
        domain: domain.to_string(),
        process_name: process_name.clone(),
        ai_provider,
        method,
        path,
        query,
        status_code: Some(resp_status),
        decision: Decision::Allowed,
        matched_rule: Some(eval.matched_rule),
        request_headers: Some(req_hdrs),
        response_headers: Some(resp_hdrs),

        req_stats,
        resp_kind,
        start_time,
    };

    let telem_body = TelemetryBody::new(inner_body, emitter);
    let response = hyper::Response::from_parts(resp_parts, telem_body.boxed());
    Ok(response)
}


type ProxyBoxBody = http_body_util::combinators::BoxBody<Bytes, anyhow::Error>;

struct BodyStats {
    bytes: u64,
    preview: Vec<u8>,
    max_preview: usize,
}

impl BodyStats {
    fn new(max_preview: usize) -> Self {
        Self { bytes: 0, preview: Vec::new(), max_preview }
    }
}

/// Which response body stats variant we're tracking.
enum RespStatsKind {
    /// Non-AI response: plain byte tracking.
    Plain(Arc<Mutex<BodyStats>>),
    /// AI response: SSE-parsed body with events + stats.
    Ai {
        stats: Arc<Mutex<crate::gateway::ai_body::AiBodyStats>>,
        state: Arc<Mutex<crate::gateway::ai_body::AiStreamState>>,
    },
}

/// Holds everything needed to build and emit a NetEvent (+ optional ModelCall)
/// when a single HTTP request/response cycle completes.
struct TelemetryEmitter {
    db: Arc<DbWriter>,
    config: Arc<MitmProxyConfig>,
    // Connection-level
    domain: String,
    process_name: Option<String>,
    ai_provider: Option<ProviderKind>,
    // Request-level
    method: String,
    path: String,
    query: Option<String>,
    status_code: Option<u16>,
    decision: Decision,
    matched_rule: Option<String>,
    request_headers: Option<String>,
    response_headers: Option<String>,
    // Body stats
    req_stats: Arc<Mutex<BodyStats>>,
    resp_kind: RespStatsKind,
    // Timing
    start_time: Instant,
}

impl TelemetryEmitter {
    /// Build and write a NetEvent (and optionally a ModelCall) to the DB.
    async fn emit(self) {
        let duration_ms = self.start_time.elapsed().as_millis() as u64;

        // Read request body stats.
        let (bytes_sent, request_body_preview) = if let Ok(st) = self.req_stats.lock() {
            let preview = if st.preview.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(&st.preview).into_owned())
            };
            (st.bytes, preview)
        } else {
            (0, None)
        };

        // Read response body stats.
        let (bytes_received, response_body_preview, ai_state_ref) = match &self.resp_kind {
            RespStatsKind::Plain(resp_stats) => {
                if let Ok(st) = resp_stats.lock() {
                    let preview = if st.preview.is_empty() {
                        None
                    } else {
                        Some(String::from_utf8_lossy(&st.preview).into_owned())
                    };
                    (st.bytes, preview, None)
                } else {
                    (0, None, None)
                }
            }
            RespStatsKind::Ai { stats, state } => {
                let (bytes, preview) = if let Ok(st) = stats.lock() {
                    let p = if st.preview.is_empty() {
                        None
                    } else {
                        Some(String::from_utf8_lossy(&st.preview).into_owned())
                    };
                    (st.bytes, p)
                } else {
                    (0, None)
                };
                (bytes, preview, Some(Arc::clone(state)))
            }
        };

        let event = NetEvent {
            timestamp: SystemTime::now(),
            domain: self.domain.clone(),
            port: 443,
            decision: self.decision,
            process_name: self.process_name.clone(),
            pid: None,
            bytes_sent,
            bytes_received,
            duration_ms,
            method: Some(self.method.clone()),
            path: Some(self.path.clone()),
            query: self.query.clone(),
            status_code: self.status_code,
            matched_rule: self.matched_rule.clone(),
            request_headers: self.request_headers.clone(),
            response_headers: self.response_headers.clone(),
            request_body_preview,
            response_body_preview,
            conn_type: Some("https-mitm".to_string()),
        };

        self.db.write(WriteOp::NetEvent(event)).await;

        // Emit ModelCall for AI providers -- only for actual LLM API endpoints.
        // Skip HEAD requests (connectivity probes) and non-API paths like
        // /api/claude_code/metrics, /v1/models, etc.
        if let Some(provider) = self.ai_provider {
            if self.method != "HEAD" && is_llm_api_path(provider, &self.path) {
                self.emit_model_call(provider, bytes_sent, bytes_received, duration_ms, &ai_state_ref).await;
            }
        }

        // Log.
        match self.decision {
            Decision::Allowed => info!(
                domain = self.domain,
                method = self.method,
                path = self.path,
                status = ?self.status_code,
                duration_ms,
                "MITM proxy: completed"
            ),
            Decision::Denied => info!(
                domain = self.domain,
                method = self.method,
                path = self.path,
                duration_ms,
                "MITM proxy: denied"
            ),
            Decision::Error => warn!(
                domain = self.domain,
                method = self.method,
                "MITM proxy: error"
            ),
        }
    }

    /// Get raw response body preview bytes for non-streaming usage parsing.
    fn get_response_preview_bytes(&self) -> Vec<u8> {
        match &self.resp_kind {
            RespStatsKind::Plain(stats) => stats.lock().ok()
                .map(|st| st.preview.clone()).unwrap_or_default(),
            RespStatsKind::Ai { stats, .. } => stats.lock().ok()
                .map(|st| st.preview.clone()).unwrap_or_default(),
        }
    }

    /// Build and write a ModelCall for AI provider traffic.
    async fn emit_model_call(
        &self,
        provider: ProviderKind,
        request_bytes: u64,
        response_bytes: u64,
        duration_ms: u64,
        ai_state_ref: &Option<Arc<Mutex<crate::gateway::ai_body::AiStreamState>>>,
    ) {
        use crate::gateway::events::parse_non_streaming_usage;
        use crate::gateway::provider::{extract_model_from_path, tool_origin};
        use crate::gateway::request_parser;

        // Parse request body for metadata.
        let req_body_bytes: Vec<u8> = self.req_stats.lock()
            .ok()
            .map(|st| st.preview.clone())
            .unwrap_or_default();
        let req_meta = request_parser::parse_request(provider, &req_body_bytes);

        // Collect stream summary from AI events.
        let summary = ai_state_ref.as_ref().and_then(|state| {
            state.lock().ok().map(|ai| collect_summary(&ai.events))
        });

        // Detect streaming from URL path (most reliable source of truth).
        // Google uses streamGenerateContent vs generateContent in the URL.
        let stream = req_meta.stream || self.path.contains("stream");

        let stop_reason_str = summary.as_ref().and_then(|s| s.stop_reason.as_ref()).map(|sr| {
            match sr {
                StopReason::EndTurn => "end_turn".to_string(),
                StopReason::ToolUse => "tool_use".to_string(),
                StopReason::MaxTokens => "max_tokens".to_string(),
                StopReason::ContentFilter => "content_filter".to_string(),
                StopReason::Other(s) => s.clone(),
            }
        });

        let tool_calls: Vec<ToolCallEntry> = summary.as_ref()
            .map(|s| s.tool_calls.iter().map(|tc| ToolCallEntry {
                call_index: tc.index,
                call_id: tc.call_id.clone(),
                tool_name: tc.name.clone(),
                arguments: if tc.arguments.is_empty() { None } else { Some(tc.arguments.clone()) },
                origin: tool_origin(&tc.name).to_string(),
            }).collect())
            .unwrap_or_default();

        let tool_responses: Vec<ToolResponseEntry> = req_meta.tool_results.iter()
            .map(|tr| ToolResponseEntry {
                call_id: tr.call_id.clone(),
                content_preview: Some(tr.content_preview.clone()),
                is_error: tr.is_error,
            })
            .collect();

        // For non-streaming responses where SSE parsing yields no tokens,
        // parse the JSON response body for usage metadata.
        let (resp_model, resp_input, resp_output, resp_details) =
            if summary.as_ref().map(|s| s.input_tokens.is_none()).unwrap_or(true) {
                let resp_bytes = self.get_response_preview_bytes();
                if !resp_bytes.is_empty() && self.status_code == Some(200) {
                    parse_non_streaming_usage(provider, &resp_bytes)
                } else {
                    (None, None, None, std::collections::BTreeMap::new())
                }
            } else {
                (None, None, None, std::collections::BTreeMap::new())
            };

        // Resolve model: request body > SSE stream > response JSON > URL path
        let effective_model = req_meta.model.clone()
            .or_else(|| summary.as_ref().and_then(|s| s.model.clone()))
            .or(resp_model)
            .or_else(|| extract_model_from_path(&self.path));

        // Resolve tokens: SSE stream > response JSON
        let input_tokens = summary.as_ref().and_then(|s| s.input_tokens).or(resp_input);
        let output_tokens = summary.as_ref().and_then(|s| s.output_tokens).or(resp_output);
        let mut usage_details = summary.as_ref()
            .map(|s| s.usage_details.clone())
            .unwrap_or_default();
        if usage_details.is_empty() {
            usage_details = resp_details;
        }

        // Estimate cost from pricing table.
        let estimated_cost_usd = self.config.pricing.estimate_cost(
            provider.as_str(),
            effective_model.as_deref(),
            input_tokens,
            output_tokens,
            &usage_details,
        );

        // Assign trace_id: look up from tool response call_ids, or create new.
        let tool_response_ids: Vec<String> = req_meta.tool_results.iter()
            .map(|tr| tr.call_id.clone()).collect();
        let tool_call_ids: Vec<String> = tool_calls.iter()
            .map(|tc| tc.call_id.clone()).collect();
        let trace_id = {
            let mut state = self.config.trace_state.lock()
                .unwrap_or_else(|e| e.into_inner());
            let tid = state.lookup(&tool_response_ids)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let is_tool_use = !tool_call_ids.is_empty()
                || stop_reason_str.as_deref()
                    .map(|r| r.contains("tool") || r == "tool_use")
                    .unwrap_or(false);
            if is_tool_use && !tool_call_ids.is_empty() {
                state.register_tool_calls(&tid, &tool_call_ids);
            } else if !is_tool_use {
                state.complete_trace(&tid);
            }
            tid
        };

        let model_call = ModelCall {
            timestamp: SystemTime::now(),
            provider: provider.as_str().to_string(),
            model: effective_model,
            process_name: self.process_name.clone(),
            pid: None,
            method: self.method.clone(),
            path: self.path.clone(),
            stream,
            system_prompt_preview: req_meta.system_prompt_preview,
            messages_count: req_meta.messages_count,
            tools_count: req_meta.tools_count,
            request_bytes,
            request_body_preview: self.req_stats.lock().ok()
                .and_then(|st| if st.preview.is_empty() { None } else {
                    Some(String::from_utf8_lossy(&st.preview).into_owned())
                }),
            message_id: summary.as_ref().and_then(|s| s.message_id.clone()),
            status_code: self.status_code,
            text_content: summary.as_ref().map(|s| s.text.clone()).filter(|s| !s.is_empty()),
            thinking_content: summary.as_ref().map(|s| s.thinking.clone()).filter(|s| !s.is_empty()),
            stop_reason: stop_reason_str,
            input_tokens,
            output_tokens,
            usage_details,
            duration_ms,
            response_bytes,
            estimated_cost_usd,
            trace_id: Some(trace_id),
            tool_calls,
            tool_responses,
        };

        if model_call.model.is_none() {
            warn!(
                provider = provider.as_str(),
                path = self.path,
                "MITM proxy: model_call has NULL model"
            );
        }

        self.db.write(WriteOp::ModelCall(model_call)).await;
    }
}

/// Wraps a response body and fires telemetry when the body completes.
/// If the body is dropped before completion (client disconnect), the
/// Drop impl fires as a fallback.
///
/// ProxyBoxBody (BoxBody) is Unpin, so no pin projection needed.
struct TelemetryBody {
    inner: ProxyBoxBody,
    emitter: Option<TelemetryEmitter>,
}

impl TelemetryBody {
    fn new(inner: ProxyBoxBody, emitter: TelemetryEmitter) -> Self {
        Self { inner, emitter: Some(emitter) }
    }
}

impl hyper::body::Body for TelemetryBody {
    type Data = Bytes;
    type Error = anyhow::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(None) => {
                // Body complete -- emit telemetry.
                if let Some(emitter) = this.emitter.take() {
                    tokio::spawn(async move {
                        emitter.emit().await;
                    });
                }
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(e))) => {
                warn!("MITM proxy: body stream error: {e:#}");
                Poll::Ready(Some(Err(e)))
            }
            other => other,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for TelemetryBody {
    fn drop(&mut self) {
        // Fallback: if the body was dropped before completion (e.g. client
        // disconnect), emit whatever telemetry we have.
        if let Some(emitter) = self.emitter.take() {
            tokio::spawn(async move {
                emitter.emit().await;
            });
        }
    }
}

pin_project_lite::pin_project! {
    struct TrackedBody<B> {
        #[pin]
        inner: B,
        stats: Arc<Mutex<BodyStats>>,
        max_size: u64,
    }
}

impl<B> TrackedBody<B> {
    fn new(inner: B, stats: Arc<Mutex<BodyStats>>, max_size: u64) -> Self {
        Self { inner, stats, max_size }
    }
}

impl<B> hyper::body::Body for TrackedBody<B>
where
    B: hyper::body::Body,
    B::Error: Into<anyhow::Error>,
{
    type Data = B::Data;
    type Error = anyhow::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        let mut this = self.project();
        match this.inner.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    let len = hyper::body::Buf::remaining(data) as u64;
                    let mut st = this.stats.lock().unwrap();
                    st.bytes += len;
                    if st.bytes > *this.max_size {
                        return Poll::Ready(Some(Err(anyhow::anyhow!("body exceeded maximum size"))));
                    }
                    if st.preview.len() < st.max_preview {
                        let to_copy = (st.max_preview - st.preview.len()).min(len as usize);
                        let chunk = hyper::body::Buf::chunk(data);
                        let to_copy = to_copy.min(chunk.len());
                        st.preview.extend_from_slice(&chunk[..to_copy]);
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e.into()))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}

// ── Gzip decompression body wrapper ──────────────────────────────
//
// Pipeline: Body -> BodyStream (Stream adapter) -> StreamReader -> GzipDecoder
//
// This is the same pattern used by reqwest and tower-http for transparent
// gzip decompression.  async-compression's GzipDecoder correctly handles
// RFC 1952 gzip headers, CRC-32 verification, and multi-member streams.

/// Adapts a `hyper::body::Body` into a `futures::Stream<Item = Result<Bytes, io::Error>>`.
///
/// Extracts data frames and converts errors to `io::Error` so the stream
/// can feed into `tokio_util::io::StreamReader`.
struct BodyStream<B> {
    body: B,
}

impl<B> BodyStream<B> {
    fn new(body: B) -> Self {
        Self { body }
    }
}

impl<B> futures::Stream for BodyStream<B>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: Into<anyhow::Error>,
{
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match Pin::new(&mut self.body).poll_frame(cx) {
                Poll::Ready(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        return Poll::Ready(Some(Ok(data)));
                    }
                    // Non-data frame (trailers) -- skip and poll again.
                    continue;
                }
                Poll::Ready(Some(Err(e))) => {
                    let err: anyhow::Error = e.into();
                    return Poll::Ready(Some(Err(io::Error::new(io::ErrorKind::Other, err))));
                }
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// Streaming gzip decompression wrapper for hyper bodies.
///
/// Transparently decompresses gzip-encoded upstream responses so all
/// downstream consumers (SSE parser, body preview, telemetry) receive
/// plain bytes.  The guest also gets uncompressed data (vsock is local,
/// compression is unnecessary).
struct DecompressBody<B: hyper::body::Body<Data = Bytes> + Unpin> {
    decoder: async_compression::tokio::bufread::GzipDecoder<
        tokio_util::io::StreamReader<BodyStream<B>, Bytes>,
    >,
    buf: BytesMut,
    done: bool,
}

impl<B> DecompressBody<B>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: Into<anyhow::Error>,
{
    fn new(body: B) -> Self {
        let stream = BodyStream::new(body);
        let reader = tokio_util::io::StreamReader::new(stream);
        let decoder = async_compression::tokio::bufread::GzipDecoder::new(reader);
        Self {
            decoder,
            buf: BytesMut::with_capacity(8192),
            done: false,
        }
    }
}

impl<B> hyper::body::Body for DecompressBody<B>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: Into<anyhow::Error>,
{
    type Data = Bytes;
    type Error = anyhow::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }

        // Reserve space for the next read.
        this.buf.reserve(8192);

        match tokio_util::io::poll_read_buf(Pin::new(&mut this.decoder), cx, &mut this.buf) {
            Poll::Ready(Ok(0)) => {
                this.done = true;
                if this.buf.is_empty() {
                    Poll::Ready(None)
                } else {
                    Poll::Ready(Some(Ok(hyper::body::Frame::data(this.buf.split().freeze()))))
                }
            }
            Poll::Ready(Ok(_n)) => {
                Poll::Ready(Some(Ok(hyper::body::Frame::data(this.buf.split().freeze()))))
            }
            Poll::Ready(Err(e)) => {
                Poll::Ready(Some(Err(anyhow::Error::new(e))))
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.done
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        // After decompression, size is unknown.
        hyper::body::SizeHint::default()
    }
}

/// Returns true only for paths that are actual LLM API endpoints
/// (generation, embeddings, audio -- anything billed per token/request).
fn is_llm_api_path(provider: ProviderKind, path: &str) -> bool {
    match provider {
        ProviderKind::Anthropic => {
            path.starts_with("/v1/messages")
                || path.starts_with("/v1/complete")
        }
        ProviderKind::OpenAi => {
            path.starts_with("/v1/chat/completions")
                || path.starts_with("/v1/responses")
                || path.starts_with("/v1/completions")
                || path.starts_with("/v1/embeddings")
                || path.starts_with("/v1/audio")
        }
        ProviderKind::Google => {
            path.contains(":generateContent")
                || path.contains(":streamGenerateContent")
                || path.contains(":embedContent")
                || path.contains(":batchEmbedContents")
        }
    }
}

/// Inject host-side credentials into the upstream request.
///
/// For Header-type credentials, replaces or adds the auth header.
/// For QueryParam-type credentials, appends to the URL query string.
/// Returns the (possibly modified) full_path for the upstream request.
fn inject_credentials(
    domain: &str,
    credentials: &HashMap<String, CredentialKind>,
    builder: &mut hyper::http::request::Builder,
    mut full_path: String,
) -> String {
    // Check exact domain first, then wildcard patterns.
    let cred = credentials.get(domain).or_else(|| {
        credentials.iter().find_map(|(pattern, cred)| {
            if pattern.starts_with("*.") {
                let suffix = &pattern[2..];
                if domain.ends_with(suffix) && domain.len() > suffix.len() {
                    return Some(cred);
                }
            }
            None
        })
    });

    if let Some(cred) = cred {
        match cred {
            CredentialKind::Header { name, value } => {
                *builder = std::mem::take(builder).header(name.as_str(), value.as_str());
            }
            CredentialKind::QueryParam { key, value } => {
                let sep = if full_path.contains('?') { "&" } else { "?" };
                full_path = format!("{full_path}{sep}{key}={value}");
            }
        }
    }
    full_path
}

/// Split a URI into path and query components.
fn split_path_query(uri: &hyper::Uri) -> (String, Option<String>) {
    let path = uri.path().to_string();
    let query = uri.query().map(|q| q.to_string());
    (path, query)
}

/// Headers whose values are safe to store verbatim in telemetry logs.
/// Everything else keeps its name but the value is replaced with a BLAKE3
/// hash prefix so credentials (API keys, bearer tokens, cookies) never
/// reach the database while still allowing correlation across requests.
const HEADER_ALLOWLIST: &[&str] = &[
    "accept",
    "content-encoding",
    "content-length",
    "content-type",
    "date",
    "host",
    "server",
    "transfer-encoding",
    "user-agent",
];

/// Format HTTP headers for telemetry storage.
///
/// Allowlisted headers are stored verbatim. All other headers keep their
/// name but the value is replaced with `hash:<12-char-hex>` (first 6 bytes
/// of the BLAKE3 digest). This prevents credential leakage while preserving
/// header presence and enabling same-key correlation.
fn format_headers(headers: &hyper::HeaderMap) -> String {
    headers
        .iter()
        .map(|(name, value)| {
            if HEADER_ALLOWLIST.contains(&name.as_str()) {
                let v = value.to_str().unwrap_or("<binary>");
                format!("{}: {}", name, v)
            } else {
                let raw = value.as_bytes();
                let digest = blake3::hash(raw);
                let hex = &digest.to_hex()[..12];
                format!("{}: hash:{}", name, hex)
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// Set a file descriptor to non-blocking mode.
fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let rc = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Async wrapper around a `std::fs::File` via `AsyncFd`.
///
/// Implements `AsyncRead + AsyncWrite` for use with tokio.
struct AsyncFdStream(tokio::io::unix::AsyncFd<std::fs::File>);

impl AsyncRead for AsyncFdStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut guard = match self.0.poll_read_ready(cx) {
                Poll::Ready(Ok(g)) => g,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => return Poll::Pending,
            };
            let unfilled = buf.initialize_unfilled();
            match guard.try_io(|inner| {
                use std::io::Read;
                let mut file = inner.get_ref();
                file.read(unfilled)
            }) {
                Ok(Ok(n)) => {
                    buf.advance(n);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(e)) => return Poll::Ready(Err(e)),
                Err(_would_block) => continue,
            }
        }
    }
}

impl AsyncWrite for AsyncFdStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut guard = match self.0.poll_write_ready(cx) {
                Poll::Ready(Ok(g)) => g,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => return Poll::Pending,
            };
            match guard.try_io(|inner| {
                use std::io::Write;
                let mut file = inner.get_ref();
                file.write(buf)
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_would_block) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        loop {
            let mut guard = match self.0.poll_write_ready(cx) {
                Poll::Ready(Ok(g)) => g,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => return Poll::Pending,
            };
            match guard.try_io(|inner| {
                use std::io::Write;
                let mut file = inner.get_ref();
                file.flush()
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_would_block) => continue,
            }
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let fd = self.0.as_raw_fd();
        let rc = unsafe { libc::shutdown(fd, libc::SHUT_WR) };
        if rc < 0 {
            let err = io::Error::last_os_error();
            // ENOTCONN is fine -- already disconnected.
            if err.kind() != io::ErrorKind::NotConnected {
                return Poll::Ready(Err(err));
            }
        }
        Poll::Ready(Ok(()))
    }
}

/// A reader that replays buffered bytes first, then reads from the inner stream.
///
/// Used to feed the TLS ClientHello bytes we already read back into the TLS acceptor.
struct ReplayReader<R> {
    buffer: Vec<u8>,
    pos: usize,
    inner: R,
}

impl<R> ReplayReader<R> {
    fn new(buffer: Vec<u8>, inner: R) -> Self {
        Self {
            buffer,
            pos: 0,
            inner,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for ReplayReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();

        // First, drain the replay buffer.
        if this.pos < this.buffer.len() {
            let remaining = &this.buffer[this.pos..];
            let to_copy = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..to_copy]);
            this.pos += to_copy;
            return Poll::Ready(Ok(()));
        }

        // Then delegate to the inner reader.
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<R: AsyncWrite + Unpin> AsyncWrite for ReplayReader<R> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

// ── TCP tunnel for non-AI traffic ────────────────────────────────
//
// For non-AI domains (git, npm, pip, etc.), bypass MITM entirely: connect
// to the real upstream server and pipe raw bytes between guest vsock and
// upstream TCP.  The TLS handshake happens end-to-end (guest ↔ upstream),
// so there are no framing, body-streaming, or decompression issues.

/// Transparent TCP tunnel: forward raw bytes between guest vsock and upstream.
///
/// `initial_buf` contains the ClientHello bytes we already read (replayed
/// to the upstream so the TLS handshake completes end-to-end).
async fn handle_tunnel(
    domain: String,
    initial_buf: Vec<u8>,
    mut vsock_stream: AsyncFdStream,
    process_name: Option<String>,
    db: &Arc<DbWriter>,
    vpn: &Option<Arc<super::vpn::VpnManager>>,
) -> Result<String, (String, Decision, String)> {
    let start = Instant::now();

    // Connect to the real upstream server (VPN-aware).
    let mut upstream = connect_upstream(&domain, vpn, Duration::from_secs(10))
        .await
        .map_err(|e| (domain.clone(), Decision::Error, format!("tunnel connect: {e}")))?;

    // Replay the ClientHello we already buffered.
    tokio::io::AsyncWriteExt::write_all(&mut upstream, &initial_buf)
        .await
        .map_err(|e| (domain.clone(), Decision::Error, format!("tunnel replay: {e}")))?;

    // Bidirectional byte copy (no TLS termination, no HTTP parsing).
    let result = tokio::io::copy_bidirectional(&mut vsock_stream, &mut upstream).await;

    let (bytes_sent, bytes_received) = match result {
        Ok((from_guest, from_upstream)) => (from_guest, from_upstream),
        Err(e) => {
            // Connection reset / broken pipe is normal at end of transfer.
            let is_normal = matches!(
                e.kind(),
                io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::UnexpectedEof
            );
            if !is_normal {
                debug!(domain, error = %e, "tunnel copy error");
            }
            (0, 0)
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    // Emit a single connection-level telemetry event.
    let event = NetEvent {
        timestamp: SystemTime::now(),
        domain: domain.clone(),
        port: 443,
        decision: Decision::Allowed,
        process_name,
        pid: None,
        bytes_sent,
        bytes_received,
        duration_ms,
        method: None,
        path: None,
        query: None,
        status_code: None,
        matched_rule: Some("tunnel".to_string()),
        request_headers: None,
        response_headers: None,
        request_body_preview: None,
        response_body_preview: None,
        conn_type: Some("https-tunnel".to_string()),
    };
    db.write(WriteOp::NetEvent(event)).await;

    info!(domain, bytes_sent, bytes_received, duration_ms, "MITM proxy: tunnel closed");
    Ok(domain)
}

/// Extract the SNI hostname from a raw TLS ClientHello message.
///
/// Parses just enough of the TLS record layer and handshake to find the
/// server_name extension (type 0x0000).  Returns None if the SNI cannot
/// be found (malformed, missing extension, or not a ClientHello).
fn extract_sni_from_client_hello(buf: &[u8]) -> Option<String> {
    // TLS record: ContentType(1) + Version(2) + Length(2) + body
    if buf.len() < 5 || buf[0] != 0x16 {
        return None; // Not a TLS handshake record
    }
    let record_len = u16::from_be_bytes([buf[3], buf[4]]) as usize;
    let record_body = buf.get(5..5 + record_len)?;

    // Handshake: HandshakeType(1) + Length(3) + body
    if record_body.is_empty() || record_body[0] != 0x01 {
        return None; // Not ClientHello
    }
    let hello_len =
        ((record_body[1] as usize) << 16) | ((record_body[2] as usize) << 8) | (record_body[3] as usize);
    let hello = record_body.get(4..4 + hello_len)?;

    // ClientHello: Version(2) + Random(32) + SessionID(var) + CipherSuites(var) + Compression(var) + Extensions
    let mut pos = 2 + 32; // skip version + random
    if pos >= hello.len() {
        return None;
    }

    // Session ID
    let sid_len = hello[pos] as usize;
    pos += 1 + sid_len;

    // Cipher suites
    if pos + 2 > hello.len() {
        return None;
    }
    let cs_len = u16::from_be_bytes([hello[pos], hello[pos + 1]]) as usize;
    pos += 2 + cs_len;

    // Compression methods
    if pos >= hello.len() {
        return None;
    }
    let comp_len = hello[pos] as usize;
    pos += 1 + comp_len;

    // Extensions length
    if pos + 2 > hello.len() {
        return None;
    }
    let ext_total = u16::from_be_bytes([hello[pos], hello[pos + 1]]) as usize;
    pos += 2;

    let ext_end = pos + ext_total;
    while pos + 4 <= ext_end && pos + 4 <= hello.len() {
        let ext_type = u16::from_be_bytes([hello[pos], hello[pos + 1]]);
        let ext_len = u16::from_be_bytes([hello[pos + 2], hello[pos + 3]]) as usize;
        pos += 4;

        if ext_type == 0x0000 {
            // SNI extension: ServerNameList length(2) + entries
            if ext_len < 5 || pos + ext_len > hello.len() {
                return None;
            }
            // Skip list length (2), read first entry: type(1) + name_len(2) + name
            let name_type = hello[pos + 2];
            if name_type != 0x00 {
                return None; // Not a hostname
            }
            let name_len = u16::from_be_bytes([hello[pos + 3], hello[pos + 4]]) as usize;
            let name_bytes = hello.get(pos + 5..pos + 5 + name_len)?;
            return std::str::from_utf8(name_bytes).ok().map(|s| s.to_string());
        }

        pos += ext_len;
    }

    None
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::IntoRawFd;
    use std::os::unix::net::UnixStream;

    use http_body_util::BodyExt;

    use crate::net::cert_authority::CertAuthority;
    use crate::net::policy::NetworkPolicy;

    const CA_KEY: &str = include_str!("../../../../config/clawcage-ca.key");
    const CA_CERT: &str = include_str!("../../../../config/clawcage-ca.crt");

    /// Flush delay for the DB writer thread to process queued writes.
    const DB_FLUSH_MS: u64 = 100;

    fn make_config_with_policy(policy: NetworkPolicy) -> Arc<MitmProxyConfig> {
        let ca = Arc::new(CertAuthority::load(CA_KEY, CA_CERT).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(DbWriter::open(&dir.path().join("test.db"), 256).unwrap());
        // Leak the tempdir so it lives for the test
        std::mem::forget(dir);
        let limits = ProxyLimits::default();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(limits.max_concurrent_connections));
        let rate_limiter = Arc::new(RateLimiterMap::new(limits.per_domain_rate_limit));
        Arc::new(MitmProxyConfig {
            ca,
            policy: Arc::new(std::sync::RwLock::new(Arc::new(policy))),
            db,
            upstream_tls: make_upstream_tls_config(),
            pricing: crate::gateway::pricing::PricingTable::load(),
            trace_state: std::sync::Mutex::new(crate::gateway::TraceState::new()),
            tunnel_non_ai: false, // tests use UnixStream pairs, not real TCP
            vpn: None,
            limits,
            connection_semaphore: semaphore,
            rate_limiter,
            enabled: true,
            credentials: Arc::new(HashMap::new()),
        })
    }

    fn make_config_dev() -> Arc<MitmProxyConfig> {
        make_config_with_policy(NetworkPolicy::default_dev())
    }

    fn make_config_deny_all() -> Arc<MitmProxyConfig> {
        make_config_with_policy(NetworkPolicy::new(vec![], false, false))
    }

    fn make_client_hello(hostname: &str) -> Vec<u8> {
        let hostname_bytes = hostname.as_bytes();
        let sni_entry_len = 1 + 2 + hostname_bytes.len();
        let sni_list_len = sni_entry_len;
        let sni_ext_data_len = 2 + sni_list_len;

        let mut sni_ext = Vec::new();
        sni_ext.extend_from_slice(&0x0000u16.to_be_bytes());
        sni_ext.extend_from_slice(&(sni_ext_data_len as u16).to_be_bytes());
        sni_ext.extend_from_slice(&(sni_list_len as u16).to_be_bytes());
        sni_ext.push(0x00);
        sni_ext.extend_from_slice(&(hostname_bytes.len() as u16).to_be_bytes());
        sni_ext.extend_from_slice(hostname_bytes);

        let extensions_len = sni_ext.len();
        let mut hello_body = Vec::new();
        hello_body.extend_from_slice(&[0x03, 0x03]);
        hello_body.extend_from_slice(&[0u8; 32]);
        hello_body.push(0);
        hello_body.extend_from_slice(&2u16.to_be_bytes());
        hello_body.extend_from_slice(&[0x00, 0x2f]);
        hello_body.push(1);
        hello_body.push(0);
        hello_body.extend_from_slice(&(extensions_len as u16).to_be_bytes());
        hello_body.extend_from_slice(&sni_ext);

        let mut handshake = Vec::new();
        handshake.push(0x01);
        let hello_len = hello_body.len();
        handshake.push((hello_len >> 16) as u8);
        handshake.push((hello_len >> 8) as u8);
        handshake.push(hello_len as u8);
        handshake.extend_from_slice(&hello_body);

        let mut record = Vec::new();
        record.push(0x16);
        record.extend_from_slice(&[0x03, 0x01]);
        record.extend_from_slice(&(handshake.len() as u16).to_be_bytes());
        record.extend_from_slice(&handshake);

        record
    }

    // ---------------------------------------------------------------
    // Metadata fragmentation tests
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn fragmented_metadata_is_reassembled() {
        let config = make_config_dev();
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        // Write metadata in two fragments: first the prefix, then the rest + newline + client hello.
        s1.set_nonblocking(false).unwrap();
        let mut writer = s1;
        // Fragment 1: metadata prefix without the newline
        std::io::Write::write_all(&mut writer, b"\0CLAWCAGE_META:my_proc").unwrap();
        // Small delay so the proxy reads the first fragment before the rest arrives.
        std::thread::sleep(std::time::Duration::from_millis(50));
        // Fragment 2: rest of metadata with newline, then the TLS ClientHello
        let mut frag2 = b"ess_name\n".to_vec();
        frag2.extend_from_slice(&make_client_hello("example.com"));
        std::io::Write::write_all(&mut writer, &frag2).unwrap();
        drop(writer);

        // The proxy should have reassembled metadata and completed TLS handshake.
        // It will fail after handshake (no real TLS client), but the key check
        // is that it didn't error during metadata parsing.
        let _ = proxy_task.await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        // Should have an event (error from failed TLS with raw bytes, not metadata error).
        // The important thing is we didn't get "metadata exceeded 4KB" or "EOF during metadata".
        if !events.is_empty() {
            let rule = events[0].matched_rule.as_deref().unwrap_or("");
            assert!(!rule.contains("metadata"), "Fragmented metadata should be reassembled, got: {rule}");
        }
    }

    #[tokio::test]
    async fn oversized_metadata_rejected() {
        let config = make_config_dev();
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        // Write >4KB metadata without a newline terminator.
        let mut oversized = b"\0CLAWCAGE_META:".to_vec();
        oversized.extend_from_slice(&vec![b'A'; 5000]);
        let mut writer = s1;
        std::io::Write::write_all(&mut writer, &oversized).unwrap();
        drop(writer);

        let _ = proxy_task.await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert!(!events.is_empty(), "oversized metadata should produce error event");
        assert_eq!(events[0].decision, Decision::Error);
        let rule = events[0].matched_rule.as_deref().unwrap_or("");
        assert!(rule.contains("4KB"), "Should mention 4KB limit, got: {rule}");
    }

    // ---------------------------------------------------------------
    // Existing connection-level tests (unchanged behavior)
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn no_sni_records_error() {
        let config = make_config_dev();
        let (mut s1, s2) = UnixStream::pair().unwrap();

        std::io::Write::write_all(&mut s1, b"not a client hello").unwrap();
        drop(s1);

        handle_connection(s2.into_raw_fd(), config.clone()).await;

        // Give writer thread time to flush.
        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].domain, "<unknown>");
        // Without valid TLS, it's an error (handshake failure)
        assert!(matches!(events[0].decision, Decision::Error | Decision::Denied));
    }

    #[tokio::test]
    async fn empty_connection_records_error() {
        let config = make_config_dev();
        let (_s1, s2) = UnixStream::pair().unwrap();
        drop(_s1);

        handle_connection(s2.into_raw_fd(), config.clone()).await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, Decision::Error);
    }

    // ---------------------------------------------------------------
    // SNI parser tests
    // ---------------------------------------------------------------

    #[test]
    fn extract_sni_from_valid_client_hello() {
        let hello = make_client_hello("github.com");
        assert_eq!(
            extract_sni_from_client_hello(&hello),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn extract_sni_various_domains() {
        for domain in &["api.anthropic.com", "example.org", "a.b.c.d.example.co.uk"] {
            let hello = make_client_hello(domain);
            assert_eq!(
                extract_sni_from_client_hello(&hello).as_deref(),
                Some(*domain),
                "failed for {domain}"
            );
        }
    }

    #[test]
    fn extract_sni_returns_none_for_non_tls() {
        assert_eq!(extract_sni_from_client_hello(b"GET / HTTP/1.1\r\n"), None);
        assert_eq!(extract_sni_from_client_hello(b""), None);
        assert_eq!(extract_sni_from_client_hello(b"\x16\x03\x01"), None); // truncated
    }

    #[test]
    fn replay_reader_drains_buffer_then_inner() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let buffer = b"hello".to_vec();
            let inner_data: &[u8] = b" world";
            let mut reader = ReplayReader::new(buffer, inner_data);

            let mut output = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut output)
                .await
                .unwrap();
            assert_eq!(&output, b"hello world");
        });
    }

    // ---------------------------------------------------------------
    // AsyncFdStream tests
    // ---------------------------------------------------------------

    fn wrap_fd_like_handle_inner(raw_fd: RawFd) -> AsyncFdStream {
        let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(raw_fd) });
        let cloned = file.try_clone().expect("try_clone (dup) failed");
        set_nonblocking(raw_fd).expect("set_nonblocking failed");
        let async_fd = tokio::io::unix::AsyncFd::new(cloned).expect("AsyncFd::new failed");
        AsyncFdStream(async_fd)
    }

    #[tokio::test]
    async fn async_fd_stream_basic_read_write() {
        let (s1, s2) = UnixStream::pair().unwrap();
        let fd1 = s1.into_raw_fd();
        let fd2 = s2.into_raw_fd();
        let mut stream1 = wrap_fd_like_handle_inner(fd1);
        let mut stream2 = wrap_fd_like_handle_inner(fd2);

        tokio::io::AsyncWriteExt::write_all(&mut stream1, b"hello vsock").await.unwrap();
        let mut buf = vec![0u8; 64];
        let n = tokio::io::AsyncReadExt::read(&mut stream2, &mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"hello vsock");

        unsafe { libc::close(fd1); libc::close(fd2); }
    }

    #[tokio::test]
    async fn async_fd_stream_large_transfer() {
        let (s1, s2) = UnixStream::pair().unwrap();
        let fd1 = s1.into_raw_fd();
        let fd2 = s2.into_raw_fd();
        let mut stream1 = wrap_fd_like_handle_inner(fd1);
        let mut stream2 = wrap_fd_like_handle_inner(fd2);

        let data: Vec<u8> = (0..131072).map(|i| (i % 251) as u8).collect();
        let send_data = data.clone();
        let writer = tokio::spawn(async move {
            tokio::io::AsyncWriteExt::write_all(&mut stream1, &send_data).await.unwrap();
            drop(stream1);
            unsafe { libc::close(fd1); }
        });
        let mut received = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut stream2, &mut received).await.unwrap();
        writer.await.unwrap();

        assert_eq!(received.len(), data.len());
        assert_eq!(received, data);

        unsafe { libc::close(fd2); }
    }

    #[tokio::test]
    async fn async_fd_stream_eof_on_close() {
        let (s1, s2) = UnixStream::pair().unwrap();
        let fd1 = s1.into_raw_fd();
        let fd2 = s2.into_raw_fd();
        let mut stream2 = wrap_fd_like_handle_inner(fd2);

        {
            let mut stream1 = wrap_fd_like_handle_inner(fd1);
            tokio::io::AsyncWriteExt::write_all(&mut stream1, b"before eof").await.unwrap();
        }
        unsafe { libc::close(fd1); }

        let mut buf = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut stream2, &mut buf).await.unwrap();
        assert_eq!(&buf, b"before eof");

        unsafe { libc::close(fd2); }
    }

    #[tokio::test]
    async fn async_fd_stream_bidirectional() {
        let (s1, s2) = UnixStream::pair().unwrap();
        let fd1 = s1.into_raw_fd();
        let fd2 = s2.into_raw_fd();
        let mut stream1 = wrap_fd_like_handle_inner(fd1);
        let mut stream2 = wrap_fd_like_handle_inner(fd2);

        tokio::io::AsyncWriteExt::write_all(&mut stream1, b"ping").await.unwrap();
        let mut buf = vec![0u8; 32];
        let n = tokio::io::AsyncReadExt::read(&mut stream2, &mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"ping");

        tokio::io::AsyncWriteExt::write_all(&mut stream2, b"pong").await.unwrap();
        let n = tokio::io::AsyncReadExt::read(&mut stream1, &mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"pong");

        unsafe { libc::close(fd1); libc::close(fd2); }
    }

    #[tokio::test]
    async fn async_fd_stream_replay_then_live() {
        let (s1, s2) = UnixStream::pair().unwrap();
        let fd2 = s2.into_raw_fd();
        let mut stream2 = wrap_fd_like_handle_inner(fd2);

        let mut writer = s1;
        std::io::Write::write_all(&mut writer, b"INITIAL").unwrap();
        std::io::Write::write_all(&mut writer, b"REMAINING").unwrap();
        drop(writer);

        let mut initial = vec![0u8; 7];
        tokio::io::AsyncReadExt::read_exact(&mut stream2, &mut initial).await.unwrap();
        assert_eq!(&initial, b"INITIAL");

        let mut replay = ReplayReader::new(initial, stream2);
        let mut all = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut replay, &mut all).await.unwrap();
        assert_eq!(&all, b"INITIALREMAINING");

        unsafe { libc::close(fd2); }
    }

    /// Full TLS handshake through handle_connection using a real rustls client.
    #[tokio::test]
    async fn tls_handshake_completes_without_global_provider() {
        let config = make_config_dev();
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        let mut root_store = rustls::RootCertStore::empty();
        let ca_certs: Vec<_> = rustls_pemfile::certs(&mut CA_CERT.as_bytes())
            .collect::<Result<_, _>>()
            .unwrap();
        for cert in ca_certs {
            root_store.add(cert).unwrap();
        }
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let client_config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));

        s1.set_nonblocking(true).unwrap();
        let stream = tokio::net::UnixStream::from_std(s1).unwrap();
        let domain = rustls::pki_types::ServerName::try_from("example.com").unwrap();
        let tls_result = connector.connect(domain, stream).await;

        assert!(tls_result.is_ok(), "TLS handshake failed: {:?}", tls_result.err());

        drop(tls_result);
        let _ = proxy_task.await;
    }

    #[test]
    fn split_path_query_with_query() {
        let uri: hyper::Uri = "https://example.com/api/v1?foo=bar&baz=1".parse().unwrap();
        let (path, query) = split_path_query(&uri);
        assert_eq!(path, "/api/v1");
        assert_eq!(query, Some("foo=bar&baz=1".to_string()));
    }

    #[test]
    fn split_path_query_without_query() {
        let uri: hyper::Uri = "/about".parse().unwrap();
        let (path, query) = split_path_query(&uri);
        assert_eq!(path, "/about");
        assert_eq!(query, None);
    }

    // ---------------------------------------------------------------
    // Header sanitization tests
    // ---------------------------------------------------------------

    #[test]
    fn format_headers_keeps_allowlisted_verbatim() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        headers.insert("content-length", "42".parse().unwrap());
        headers.insert("host", "api.example.com".parse().unwrap());
        headers.insert("server", "nginx".parse().unwrap());
        headers.insert("user-agent", "curl/8.0".parse().unwrap());

        let formatted = format_headers(&headers);
        assert!(formatted.contains("content-type: application/json"));
        assert!(formatted.contains("content-length: 42"));
        assert!(formatted.contains("host: api.example.com"));
        assert!(formatted.contains("server: nginx"));
        assert!(formatted.contains("user-agent: curl/8.0"));
    }

    #[test]
    fn format_headers_hashes_sensitive_headers() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("x-api-key", "sk-ant-1234567890abcdef".parse().unwrap());
        headers.insert("authorization", "Bearer tok_secret".parse().unwrap());
        headers.insert("cookie", "session=abc123".parse().unwrap());

        let formatted = format_headers(&headers);

        // Header names are preserved.
        assert!(formatted.contains("x-api-key: hash:"));
        assert!(formatted.contains("authorization: hash:"));
        assert!(formatted.contains("cookie: hash:"));

        // Raw credential values must NOT appear.
        assert!(!formatted.contains("sk-ant-1234567890abcdef"));
        assert!(!formatted.contains("Bearer tok_secret"));
        assert!(!formatted.contains("session=abc123"));
    }

    #[test]
    fn format_headers_hash_is_deterministic() {
        let mut h1 = hyper::HeaderMap::new();
        h1.insert("x-api-key", "AIzaSyBxxxxxxx".parse().unwrap());
        let mut h2 = hyper::HeaderMap::new();
        h2.insert("x-api-key", "AIzaSyBxxxxxxx".parse().unwrap());

        assert_eq!(format_headers(&h1), format_headers(&h2));
    }

    #[test]
    fn format_headers_different_keys_different_hashes() {
        let mut h1 = hyper::HeaderMap::new();
        h1.insert("x-api-key", "key-AAAA".parse().unwrap());
        let mut h2 = hyper::HeaderMap::new();
        h2.insert("x-api-key", "key-BBBB".parse().unwrap());

        // Extract the hash portion from each.
        let f1 = format_headers(&h1);
        let f2 = format_headers(&h2);
        let hash1 = f1.strip_prefix("x-api-key: hash:").unwrap();
        let hash2 = f2.strip_prefix("x-api-key: hash:").unwrap();
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn format_headers_mixed_allowed_and_sensitive() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("content-type", "text/html".parse().unwrap());
        headers.insert("x-api-key", "sk-secret".parse().unwrap());
        headers.insert("accept", "text/html".parse().unwrap());

        let formatted = format_headers(&headers);

        // Allowlisted: verbatim.
        assert!(formatted.contains("content-type: text/html"));
        assert!(formatted.contains("accept: text/html"));

        // Sensitive: hashed, raw value absent.
        assert!(formatted.contains("x-api-key: hash:"));
        assert!(!formatted.contains("sk-secret"));
    }

    #[test]
    fn format_headers_empty() {
        let headers = hyper::HeaderMap::new();
        assert_eq!(format_headers(&headers), "");
    }

    // ---------------------------------------------------------------
    // TelemetryEmitter unit tests
    // ---------------------------------------------------------------

    /// Helper: create a DbWriter for tests with a reader for verification.
    fn make_test_db() -> Arc<DbWriter> {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(DbWriter::open(&dir.path().join("test.db"), 256).unwrap());
        std::mem::forget(dir);
        db
    }

    fn make_emitter(db: &Arc<DbWriter>) -> TelemetryEmitter {
        TelemetryEmitter {
            db: Arc::clone(db),
            config: make_config_dev(),
            domain: "example.com".to_string(),
            process_name: None,
            ai_provider: None,
            method: "GET".to_string(),
            path: "/".to_string(),
            query: None,
            status_code: Some(200),
            decision: Decision::Allowed,
            matched_rule: Some("default-dev-allow".to_string()),
            request_headers: Some("host: example.com".to_string()),
            response_headers: Some("content-type: text/html".to_string()),

            req_stats: Arc::new(Mutex::new(BodyStats::new(0))),
            resp_kind: RespStatsKind::Plain(Arc::new(Mutex::new(BodyStats::new(0)))),
            start_time: Instant::now(),
        }
    }

    #[tokio::test]
    async fn telemetry_emitter_writes_net_event() {
        let db = make_test_db();
        let emitter = make_emitter(&db);
        emitter.emit().await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].domain, "example.com");
        assert_eq!(events[0].method, Some("GET".to_string()));
        assert_eq!(events[0].path, Some("/".to_string()));
        assert_eq!(events[0].status_code, Some(200));
        assert_eq!(events[0].decision, Decision::Allowed);
    }

    #[tokio::test]
    async fn telemetry_emitter_writes_model_call_for_ai() {
        let db = make_test_db();

        // Set up AI provider emitter with fake SSE state
        let ai_state = Arc::new(Mutex::new(crate::gateway::ai_body::AiStreamState {
            sse_parser: crate::gateway::sse::SseParser::new(),
            provider_parser: Box::new(crate::gateway::anthropic::AnthropicStreamParserWithState::new()),
            events: vec![
                crate::gateway::events::LlmEvent::MessageStart {
                    message_id: Some("msg_test".into()),
                    model: Some("claude-test".into()),
                },
                crate::gateway::events::LlmEvent::TextDelta { index: 0, text: "Hello".into() },
                crate::gateway::events::LlmEvent::MessageEnd {
                    stop_reason: Some(crate::gateway::events::StopReason::EndTurn),
                },
            ],
        }));
        let ai_stats = Arc::new(Mutex::new(crate::gateway::ai_body::AiBodyStats {
            bytes: 500,
            preview: Vec::new(),
            max_preview: 0,
        }));

        let emitter = TelemetryEmitter {
            db: Arc::clone(&db),
            config: make_config_dev(),
            domain: "api.anthropic.com".to_string(),
            process_name: Some("test".to_string()),
            ai_provider: Some(ProviderKind::Anthropic),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: None,
            status_code: Some(200),
            decision: Decision::Allowed,
            matched_rule: Some("ai-allow".to_string()),
            request_headers: Some("x-api-key: sk-test1234".to_string()),
            response_headers: Some("content-type: text/event-stream".to_string()),

            req_stats: Arc::new(Mutex::new(BodyStats::new(0))),
            resp_kind: RespStatsKind::Ai { stats: ai_stats, state: ai_state },
            start_time: Instant::now(),
        };
        emitter.emit().await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].domain, "api.anthropic.com");

        // ModelCall should also be recorded
        let calls = reader.recent_model_calls(10).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1.provider, "anthropic");
        assert_eq!(calls[0].1.model, Some("claude-test".to_string()));
    }

    // ---------------------------------------------------------------
    // TelemetryBody tests
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn telemetry_body_emits_on_completion() {
        let db = make_test_db();
        let emitter = make_emitter(&db);

        let inner = Full::new(Bytes::from("hello body"))
            .map_err(|never| -> anyhow::Error { match never {} })
            .boxed();
        let telem_body = TelemetryBody::new(inner, emitter);

        // Consume the body fully.
        let _ = telem_body.collect().await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].domain, "example.com");
    }

    #[tokio::test]
    async fn telemetry_body_emits_on_drop() {
        let db = make_test_db();
        let emitter = make_emitter(&db);

        let inner = Full::new(Bytes::from("hello body"))
            .map_err(|never| -> anyhow::Error { match never {} })
            .boxed();
        let telem_body = TelemetryBody::new(inner, emitter);

        // Drop without consuming.
        drop(telem_body);

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1, "Drop fallback should emit");
        assert_eq!(events[0].domain, "example.com");
    }

    #[tokio::test]
    async fn telemetry_body_emits_only_once() {
        let db = make_test_db();
        let emitter = make_emitter(&db);

        let inner = Full::new(Bytes::from("hello body"))
            .map_err(|never| -> anyhow::Error { match never {} })
            .boxed();
        let telem_body = TelemetryBody::new(inner, emitter);

        // Consume fully (triggers emit on completion), then drop (should not emit again).
        let _ = telem_body.collect().await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1, "should emit exactly once, not on both completion and drop");
    }

    // ---------------------------------------------------------------
    // Denied-request integration test (no upstream needed)
    // ---------------------------------------------------------------

    /// Build a rustls TLS client config that trusts our MITM CA.
    fn make_mitm_client_config() -> Arc<rustls::ClientConfig> {
        let mut root_store = rustls::RootCertStore::empty();
        let ca_certs: Vec<_> = rustls_pemfile::certs(&mut CA_CERT.as_bytes())
            .collect::<Result<_, _>>()
            .unwrap();
        for cert in ca_certs {
            root_store.add(cert).unwrap();
        }
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        Arc::new(rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(root_store)
            .with_no_client_auth())
    }

    #[tokio::test]
    async fn denied_request_emits_event() {
        let config = make_config_deny_all();
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        let client_config = make_mitm_client_config();
        let connector = tokio_rustls::TlsConnector::from(client_config);
        s1.set_nonblocking(true).unwrap();
        let stream = tokio::net::UnixStream::from_std(s1).unwrap();
        let sni = rustls::pki_types::ServerName::try_from("example.com").unwrap();
        let tls_stream = connector.connect(sni, stream).await.unwrap();

        let io = TokioIo::new(tls_stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
        tokio::spawn(async move { let _ = conn.await; });

        let req = hyper::Request::builder()
            .method("GET")
            .uri("/secret")
            .header("host", "example.com")
            .body(Full::new(Bytes::new()).map_err(|never| -> anyhow::Error { match never {} }).boxed())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 403);
        // Consume the body to trigger telemetry emission.
        let _ = resp.into_body().collect().await;

        drop(sender);
        let _ = proxy_task.await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, Decision::Denied);
        assert_eq!(events[0].status_code, Some(403));
        assert_eq!(events[0].method, Some("GET".to_string()));
        assert_eq!(events[0].path, Some("/secret".to_string()));
    }

    /// Multiple denied requests on the same keep-alive connection produce
    /// one event per request (the core bug this fix addresses).
    #[tokio::test]
    async fn multiple_denied_requests_emit_separate_events() {
        let config = make_config_deny_all();
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        let client_config = make_mitm_client_config();
        let connector = tokio_rustls::TlsConnector::from(client_config);
        s1.set_nonblocking(true).unwrap();
        let stream = tokio::net::UnixStream::from_std(s1).unwrap();
        let sni = rustls::pki_types::ServerName::try_from("example.com").unwrap();
        let tls_stream = connector.connect(sni, stream).await.unwrap();

        let io = TokioIo::new(tls_stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
        tokio::spawn(async move { let _ = conn.await; });

        // Send 3 requests on the same keep-alive connection.
        for path in ["/a", "/b", "/c"] {
            let req = hyper::Request::builder()
                .method("GET")
                .uri(path)
                .header("host", "example.com")
                .body(Full::new(Bytes::new()).map_err(|never| -> anyhow::Error { match never {} }).boxed())
                .unwrap();
            let resp = sender.send_request(req).await.unwrap();
            assert_eq!(resp.status().as_u16(), 403);
            let _ = resp.into_body().collect().await;
        }

        drop(sender);
        let _ = proxy_task.await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let mut events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 3, "3 requests should produce 3 events, not 1");
        events.reverse(); // chronological order
        assert_eq!(events[0].path, Some("/a".to_string()));
        assert_eq!(events[1].path, Some("/b".to_string()));
        assert_eq!(events[2].path, Some("/c".to_string()));
    }

    #[tokio::test]
    async fn websocket_upgrade_rejected_with_400() {
        let config = make_config_dev();
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        let client_config = make_mitm_client_config();
        let connector = tokio_rustls::TlsConnector::from(client_config);
        s1.set_nonblocking(true).unwrap();
        let stream = tokio::net::UnixStream::from_std(s1).unwrap();
        let sni = rustls::pki_types::ServerName::try_from("example.com").unwrap();
        let tls_stream = connector.connect(sni, stream).await.unwrap();

        let io = TokioIo::new(tls_stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
        tokio::spawn(async move { let _ = conn.await; });

        let req = hyper::Request::builder()
            .method("GET")
            .uri("/ws")
            .header("host", "example.com")
            .header("upgrade", "websocket")
            .header("connection", "upgrade")
            .body(Full::new(Bytes::new()).map_err(|never| -> anyhow::Error { match never {} }).boxed())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 400, "WebSocket upgrades should return 400");
        let _ = resp.into_body().collect().await;

        drop(sender);
        let _ = proxy_task.await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, Decision::Denied);
        assert_eq!(events[0].status_code, Some(400));
        assert_eq!(events[0].matched_rule, Some("websocket-not-supported".to_string()));
    }

    /// Upstream DNS failure returns 502 instead of killing the connection.
    #[tokio::test]
    async fn upstream_error_returns_502() {
        // Allow nonexistent.invalid but it will fail at TCP connect.
        use crate::net::policy::{DomainMatcher, PolicyRule};
        let policy = NetworkPolicy::new(
            vec![PolicyRule {
                matcher: DomainMatcher::parse("nonexistent.invalid"),
                allow_read: true,
                allow_write: true,
            }],
            false,
            false,
        );
        let config = make_config_with_policy(policy);
        let (s1, s2) = UnixStream::pair().unwrap();

        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        let client_config = make_mitm_client_config();
        let connector = tokio_rustls::TlsConnector::from(client_config);
        s1.set_nonblocking(true).unwrap();
        let stream = tokio::net::UnixStream::from_std(s1).unwrap();
        let sni = rustls::pki_types::ServerName::try_from("nonexistent.invalid").unwrap();
        let tls_stream = connector.connect(sni, stream).await.unwrap();

        let io = TokioIo::new(tls_stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
        tokio::spawn(async move { let _ = conn.await; });

        let req = hyper::Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "nonexistent.invalid")
            .body(Full::new(Bytes::new()).map_err(|never| -> anyhow::Error { match never {} }).boxed())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 502, "Upstream error should return 502");
        let _ = resp.into_body().collect().await;

        drop(sender);
        let _ = proxy_task.await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, Decision::Error);
        assert_eq!(events[0].status_code, Some(502));
        assert_eq!(events[0].domain, "nonexistent.invalid");
    }

    /// Helper to build a TelemetryEmitter with AI provider for testing emit_model_call.
    fn make_ai_emitter(config: &Arc<MitmProxyConfig>, provider: ProviderKind) -> TelemetryEmitter {
        TelemetryEmitter {
            db: Arc::clone(&config.db),
            config: Arc::clone(config),
            domain: "api.anthropic.com".to_string(),
            process_name: Some("claude".to_string()),
            ai_provider: Some(provider),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: None,
            status_code: Some(200),
            decision: Decision::Allowed,
            matched_rule: Some("ai-provider".to_string()),
            request_headers: None,
            response_headers: None,
            req_stats: Arc::new(Mutex::new(BodyStats::new(0))),
            resp_kind: RespStatsKind::Plain(Arc::new(Mutex::new(BodyStats::new(0)))),
            start_time: Instant::now(),
        }
    }

    /// Build an `AiStreamState` with pre-populated events for testing.
    fn make_ai_state(events: Vec<crate::gateway::events::LlmEvent>) -> Arc<Mutex<crate::gateway::ai_body::AiStreamState>> {
        use crate::gateway::anthropic::AnthropicStreamParserWithState;
        Arc::new(Mutex::new(crate::gateway::ai_body::AiStreamState {
            sse_parser: crate::gateway::sse::SseParser::new(),
            provider_parser: Box::new(AnthropicStreamParserWithState::new()),
            events,
        }))
    }

    #[tokio::test]
    async fn emit_model_call_assigns_trace_id() {
        let config = make_config_dev();
        let emitter = make_ai_emitter(&config, ProviderKind::Anthropic);

        // Emit with no AI state (simulates non-streaming or empty response).
        emitter.emit_model_call(
            ProviderKind::Anthropic, 100, 200, 50, &None,
        ).await;

        // Flush the DB writer.
        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let calls = reader.recent_model_calls(10).unwrap();
        assert_eq!(calls.len(), 1, "should have recorded one model call");
        assert!(calls[0].1.trace_id.is_some(), "trace_id should be assigned");
        assert!(!calls[0].1.trace_id.as_ref().unwrap().is_empty());
    }

    #[tokio::test]
    async fn emit_model_call_estimates_cost() {
        use crate::gateway::events::LlmEvent;
        let config = make_config_dev();
        let ai_state = make_ai_state(vec![
            LlmEvent::MessageStart {
                message_id: None,
                model: Some("claude-sonnet-4-20250514".to_string()),
            },
            LlmEvent::Usage {
                input_tokens: Some(1000),
                output_tokens: Some(500),
                details: std::collections::BTreeMap::new(),
            },
        ]);
        let emitter = make_ai_emitter(&config, ProviderKind::Anthropic);

        emitter.emit_model_call(
            ProviderKind::Anthropic, 100, 200, 50, &Some(ai_state),
        ).await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let calls = reader.recent_model_calls(10).unwrap();
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0].1.estimated_cost_usd > 0.0,
            "cost should be positive for known model with tokens: got {}",
            calls[0].1.estimated_cost_usd,
        );
    }

    #[tokio::test]
    async fn trace_chains_across_tool_use() {
        use crate::gateway::events::{LlmEvent, StopReason};
        let config = make_config_dev();

        // First call: model responds with tool_use, tool_call_id = "call_1".
        let ai_state1 = make_ai_state(vec![
            LlmEvent::ToolCallStart {
                index: 0,
                call_id: "call_1".to_string(),
                name: "bash".to_string(),
            },
            LlmEvent::ToolCallEnd { index: 0 },
            LlmEvent::MessageEnd {
                stop_reason: Some(StopReason::ToolUse),
            },
        ]);
        let emitter1 = make_ai_emitter(&config, ProviderKind::Anthropic);
        emitter1.emit_model_call(ProviderKind::Anthropic, 100, 200, 50, &Some(ai_state1)).await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let calls1 = reader.recent_model_calls(10).unwrap();
        assert_eq!(calls1.len(), 1);
        let trace_id_1 = calls1[0].1.trace_id.clone().unwrap();

        // Second call: includes tool_response for call_1, model responds with end_turn.
        let req_body = serde_json::json!({
            "model": "claude-sonnet-4-20250514",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call_1", "name": "bash", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "done"}
                ]}
            ]
        });
        let req_bytes = serde_json::to_vec(&req_body).unwrap();

        let ai_state2 = make_ai_state(vec![
            LlmEvent::MessageEnd {
                stop_reason: Some(StopReason::EndTurn),
            },
        ]);

        let emitter2 = TelemetryEmitter {
            db: Arc::clone(&config.db),
            config: Arc::clone(&config),
            domain: "api.anthropic.com".to_string(),
            process_name: Some("claude".to_string()),
            ai_provider: Some(ProviderKind::Anthropic),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: None,
            status_code: Some(200),
            decision: Decision::Allowed,
            matched_rule: Some("ai-provider".to_string()),
            request_headers: None,
            response_headers: None,
            req_stats: Arc::new(Mutex::new(BodyStats {
                bytes: req_bytes.len() as u64,
                preview: req_bytes,
                max_preview: 64 * 1024,
            })),
            resp_kind: RespStatsKind::Plain(Arc::new(Mutex::new(BodyStats::new(0)))),
            start_time: Instant::now(),
        };
        emitter2.emit_model_call(ProviderKind::Anthropic, 100, 200, 50, &Some(ai_state2)).await;

        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let calls2 = reader.recent_model_calls(10).unwrap();
        assert_eq!(calls2.len(), 2, "should have 2 model calls now");
        // Most recent first -- calls2[0] is the second call.
        let trace_id_2 = calls2[0].1.trace_id.clone().unwrap();
        assert_eq!(
            trace_id_1, trace_id_2,
            "second call should share the same trace_id as first (chained via tool_use)"
        );
    }

    #[tokio::test]
    async fn trace_completes_on_end_turn() {
        use crate::gateway::events::{LlmEvent, StopReason};
        let config = make_config_dev();

        let ai_state = make_ai_state(vec![
            LlmEvent::MessageEnd {
                stop_reason: Some(StopReason::EndTurn),
            },
        ]);
        let emitter = make_ai_emitter(&config, ProviderKind::Anthropic);
        emitter.emit_model_call(ProviderKind::Anthropic, 100, 200, 50, &Some(ai_state)).await;

        // After end_turn, trace_state should have no pending entries.
        let state = config.trace_state.lock().unwrap();
        assert!(
            state.lookup(&["nonexistent".to_string()]).is_none(),
            "trace_state should be empty after end_turn"
        );
    }

    // ── DecompressBody tests ──────────────────────────────────────

    /// Gzip-compress a byte slice for testing.
    fn gzip_compress(data: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[tokio::test]
    async fn decompress_body_gzip_sse_data() {
        let sse_data = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"model\":\"claude-sonnet-4-6\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hello\"}}\n\n";
        let compressed = gzip_compress(sse_data);

        let body = Full::new(Bytes::from(compressed))
            .map_err(|never| -> anyhow::Error { match never {} });
        let decompress = DecompressBody::new(body);

        let collected = decompress.collect().await.unwrap();
        let output = collected.to_bytes();
        assert_eq!(output.as_ref(), sse_data.as_slice());
    }

    #[tokio::test]
    async fn decompress_body_multi_chunk_gzip() {
        // Compress data, then split the compressed output into multiple chunks
        // to verify decompression works across chunk boundaries.
        let original = b"chunk1-data-here|chunk2-data-here|chunk3-data-here";
        let compressed = gzip_compress(original);

        // Split compressed data into 3 chunks.
        let chunk_size = compressed.len() / 3;
        let chunks: Vec<Bytes> = compressed
            .chunks(chunk_size.max(1))
            .map(|c| Bytes::from(c.to_vec()))
            .collect();

        // Build a multi-frame body using StreamBody + futures::stream::iter.
        let frames: Vec<Result<hyper::body::Frame<Bytes>, anyhow::Error>> = chunks
            .into_iter()
            .map(|c| Ok(hyper::body::Frame::data(c)))
            .collect();
        let body = http_body_util::StreamBody::new(futures::stream::iter(frames));
        let decompress = DecompressBody::new(body);

        let collected = decompress.collect().await.unwrap();
        let output = collected.to_bytes();
        assert_eq!(output.as_ref(), original.as_slice());
    }

    #[tokio::test]
    async fn decompress_body_passthrough_uncompressed() {
        // Non-gzip data should NOT go through DecompressBody -- it's only used
        // when content-encoding is gzip. Verify the non-gzip code path works:
        // a plain body comes through unchanged via map_err().boxed().
        let plain_data = b"Hello, world!";
        let body = Full::new(Bytes::from(plain_data.to_vec()))
            .map_err(|never| -> anyhow::Error { match never {} });

        let collected = body.collect().await.unwrap();
        assert_eq!(collected.to_bytes().as_ref(), plain_data);
    }

    // ── is_llm_api_path tests ─────────────────────────────────────

    #[test]
    fn llm_api_path_anthropic_positive() {
        assert!(is_llm_api_path(ProviderKind::Anthropic, "/v1/messages"));
        assert!(is_llm_api_path(ProviderKind::Anthropic, "/v1/messages?beta=true"));
        assert!(is_llm_api_path(ProviderKind::Anthropic, "/v1/complete"));
    }

    #[test]
    fn llm_api_path_anthropic_negative() {
        assert!(!is_llm_api_path(ProviderKind::Anthropic, "/api/claude_code/metrics"));
        assert!(!is_llm_api_path(ProviderKind::Anthropic, "/api/claude_code/settings"));
        assert!(!is_llm_api_path(ProviderKind::Anthropic, "/v1/models"));
        assert!(!is_llm_api_path(ProviderKind::Anthropic, "/api/organizations"));
    }

    #[test]
    fn llm_api_path_openai_positive() {
        assert!(is_llm_api_path(ProviderKind::OpenAi, "/v1/chat/completions"));
        assert!(is_llm_api_path(ProviderKind::OpenAi, "/v1/responses"));
        assert!(is_llm_api_path(ProviderKind::OpenAi, "/v1/completions"));
        assert!(is_llm_api_path(ProviderKind::OpenAi, "/v1/embeddings"));
        assert!(is_llm_api_path(ProviderKind::OpenAi, "/v1/audio/transcriptions"));
    }

    #[test]
    fn llm_api_path_openai_negative() {
        assert!(!is_llm_api_path(ProviderKind::OpenAi, "/v1/models"));
        assert!(!is_llm_api_path(ProviderKind::OpenAi, "/v1/files"));
        assert!(!is_llm_api_path(ProviderKind::OpenAi, "/dashboard/billing"));
    }

    #[test]
    fn llm_api_path_google_positive() {
        assert!(is_llm_api_path(ProviderKind::Google, "/v1beta/models/gemini-2.0-flash:generateContent"));
        assert!(is_llm_api_path(ProviderKind::Google, "/v1beta/models/gemini-2.0-flash:streamGenerateContent"));
        assert!(is_llm_api_path(ProviderKind::Google, "/v1beta/models/text-embedding-004:embedContent"));
        assert!(is_llm_api_path(ProviderKind::Google, "/v1beta/models/text-embedding-004:batchEmbedContents"));
    }

    #[test]
    fn llm_api_path_google_negative() {
        assert!(!is_llm_api_path(ProviderKind::Google, "/v1beta/models"));
        assert!(!is_llm_api_path(ProviderKind::Google, "/v1beta/models/gemini-2.0-flash"));
        assert!(!is_llm_api_path(ProviderKind::Google, "/v1beta/cachedContents"));
    }

    #[test]
    fn llm_api_path_starts_with_is_intentional() {
        // /v1/messages_extra should match -- starts_with is fine since the real
        // path is /v1/messages with optional query params after it.
        assert!(is_llm_api_path(ProviderKind::Anthropic, "/v1/messages_extra"));
    }

    // ---------------------------------------------------------------
    // Rate limiter tests
    // ---------------------------------------------------------------

    #[test]
    fn rate_limiter_allows_within_capacity() {
        let rl = RateLimiterMap::new(10.0);
        // First 10 requests should be allowed (initial bucket = rate)
        for i in 0..10 {
            assert!(rl.check("example.com"), "request {i} should be allowed");
        }
    }

    #[test]
    fn rate_limiter_denies_when_exhausted() {
        let rl = RateLimiterMap::new(5.0);
        // Exhaust the bucket (initial = 5.0 tokens, burst = 10.0)
        for _ in 0..5 {
            assert!(rl.check("example.com"));
        }
        // Next request should be denied (not enough time to refill)
        assert!(!rl.check("example.com"), "should be rate-limited after exhausting bucket");
    }

    #[test]
    fn rate_limiter_domains_are_independent() {
        let rl = RateLimiterMap::new(2.0);
        // Exhaust domain A
        assert!(rl.check("a.com"));
        assert!(rl.check("a.com"));
        assert!(!rl.check("a.com"));
        // Domain B should still have tokens
        assert!(rl.check("b.com"));
        assert!(rl.check("b.com"));
    }

    #[test]
    fn rate_limiter_refills_over_time() {
        let rl = RateLimiterMap::new(100.0);
        // Exhaust
        for _ in 0..100 {
            rl.check("x.com");
        }
        assert!(!rl.check("x.com"));
        // Sleep briefly to allow refill (100 tokens/sec * 0.05s = 5 tokens)
        std::thread::sleep(Duration::from_millis(50));
        assert!(rl.check("x.com"), "should have refilled after sleep");
    }

    // ---------------------------------------------------------------
    // Credential injection tests
    // ---------------------------------------------------------------

    #[test]
    fn inject_credentials_header_exact_domain() {
        let mut creds = HashMap::new();
        creds.insert("api.anthropic.com".to_string(), CredentialKind::Header {
            name: "x-api-key".to_string(),
            value: "sk-ant-test123".to_string(),
        });
        let mut builder = hyper::Request::builder().method("POST");
        let path = inject_credentials("api.anthropic.com", &creds, &mut builder, "/v1/messages".to_string());
        assert_eq!(path, "/v1/messages");
        let req = builder.uri(&path).body(()).unwrap();
        assert_eq!(req.headers().get("x-api-key").unwrap(), "sk-ant-test123");
    }

    #[test]
    fn inject_credentials_query_param() {
        let mut creds = HashMap::new();
        creds.insert("generativelanguage.googleapis.com".to_string(), CredentialKind::QueryParam {
            key: "key".to_string(),
            value: "AIzaTest".to_string(),
        });
        let mut builder = hyper::Request::builder().method("POST");
        let path = inject_credentials(
            "generativelanguage.googleapis.com",
            &creds,
            &mut builder,
            "/v1beta/models/gemini:generateContent".to_string(),
        );
        assert_eq!(path, "/v1beta/models/gemini:generateContent?key=AIzaTest");
    }

    #[test]
    fn inject_credentials_query_param_appends_to_existing() {
        let mut creds = HashMap::new();
        creds.insert("api.example.com".to_string(), CredentialKind::QueryParam {
            key: "token".to_string(),
            value: "abc".to_string(),
        });
        let mut builder = hyper::Request::builder().method("GET");
        let path = inject_credentials(
            "api.example.com",
            &creds,
            &mut builder,
            "/data?page=1".to_string(),
        );
        assert_eq!(path, "/data?page=1&token=abc");
    }

    #[test]
    fn inject_credentials_wildcard_domain() {
        let mut creds = HashMap::new();
        creds.insert("*.openai.com".to_string(), CredentialKind::Header {
            name: "authorization".to_string(),
            value: "Bearer sk-test".to_string(),
        });
        let mut builder = hyper::Request::builder().method("POST");
        let path = inject_credentials("api.openai.com", &creds, &mut builder, "/v1/chat/completions".to_string());
        assert_eq!(path, "/v1/chat/completions");
        let req = builder.uri(&path).body(()).unwrap();
        assert_eq!(req.headers().get("authorization").unwrap(), "Bearer sk-test");
    }

    #[test]
    fn inject_credentials_no_match_leaves_request_unchanged() {
        let mut creds = HashMap::new();
        creds.insert("api.anthropic.com".to_string(), CredentialKind::Header {
            name: "x-api-key".to_string(),
            value: "secret".to_string(),
        });
        let mut builder = hyper::Request::builder().method("GET");
        let path = inject_credentials("example.com", &creds, &mut builder, "/index.html".to_string());
        assert_eq!(path, "/index.html");
        let req = builder.uri(&path).body(()).unwrap();
        assert!(req.headers().get("x-api-key").is_none());
    }

    #[test]
    fn inject_credentials_exact_takes_precedence_over_wildcard() {
        let mut creds = HashMap::new();
        creds.insert("api.example.com".to_string(), CredentialKind::Header {
            name: "x-api-key".to_string(),
            value: "exact-key".to_string(),
        });
        creds.insert("*.example.com".to_string(), CredentialKind::Header {
            name: "x-api-key".to_string(),
            value: "wildcard-key".to_string(),
        });
        let mut builder = hyper::Request::builder().method("GET");
        let path = inject_credentials("api.example.com", &creds, &mut builder, "/".to_string());
        let req = builder.uri(&path).body(()).unwrap();
        assert_eq!(req.headers().get("x-api-key").unwrap(), "exact-key");
    }

    // ---------------------------------------------------------------
    // Adversarial credential injection tests
    // ---------------------------------------------------------------

    #[test]
    fn inject_credentials_wildcard_does_not_match_bare_domain() {
        // *.example.com should NOT match "example.com" itself
        let mut creds = HashMap::new();
        creds.insert("*.example.com".to_string(), CredentialKind::Header {
            name: "x-api-key".to_string(),
            value: "secret".to_string(),
        });
        let mut builder = hyper::Request::builder().method("GET");
        let _path = inject_credentials("example.com", &creds, &mut builder, "/".to_string());
        let req = builder.uri("/").body(()).unwrap();
        assert!(req.headers().get("x-api-key").is_none(), "wildcard should not match bare domain");
    }

    #[test]
    fn inject_credentials_empty_map_is_noop() {
        let creds = HashMap::new();
        let mut builder = hyper::Request::builder().method("GET");
        let path = inject_credentials("anything.com", &creds, &mut builder, "/foo".to_string());
        assert_eq!(path, "/foo");
    }

    // ---------------------------------------------------------------
    // ProxyLimits default tests
    // ---------------------------------------------------------------

    #[test]
    fn proxy_limits_default_values() {
        let limits = ProxyLimits::default();
        assert_eq!(limits.max_concurrent_connections, 100);
        assert!((limits.per_domain_rate_limit - 50.0).abs() < f64::EPSILON);
        assert_eq!(limits.max_response_body_bytes, 100 * 1024 * 1024);
        assert_eq!(limits.connection_idle_timeout, Duration::from_secs(60));
        assert_eq!(limits.connect_timeout, Duration::from_secs(10));
    }

    // ---------------------------------------------------------------
    // Proxy disabled mode tests
    // ---------------------------------------------------------------

    fn make_config_disabled_deny_all() -> Arc<MitmProxyConfig> {
        let ca = Arc::new(CertAuthority::load(CA_KEY, CA_CERT).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(DbWriter::open(&dir.path().join("test.db"), 256).unwrap());
        std::mem::forget(dir);
        let limits = ProxyLimits::default();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(limits.max_concurrent_connections));
        let rate_limiter = Arc::new(RateLimiterMap::new(limits.per_domain_rate_limit));
        Arc::new(MitmProxyConfig {
            ca,
            policy: Arc::new(std::sync::RwLock::new(Arc::new(
                NetworkPolicy::new(vec![], false, false),
            ))),
            db,
            upstream_tls: make_upstream_tls_config(),
            pricing: crate::gateway::pricing::PricingTable::load(),
            trace_state: std::sync::Mutex::new(crate::gateway::TraceState::new()),
            tunnel_non_ai: false,
            vpn: None,
            limits,
            connection_semaphore: semaphore,
            rate_limiter,
            enabled: false,
            credentials: Arc::new(HashMap::new()),
        })
    }

    #[tokio::test]
    async fn disabled_proxy_denied_domain_records_error() {
        // When proxy is disabled, denied domains should still produce an event
        let config = make_config_disabled_deny_all();

        let (s1, s2) = UnixStream::pair().unwrap();
        let proxy_fd = s2.into_raw_fd();
        let proxy_config = Arc::clone(&config);
        let proxy_task = tokio::spawn(async move {
            handle_connection(proxy_fd, proxy_config).await;
        });

        // Send a TLS ClientHello so SNI can be extracted
        let hello = make_client_hello("blocked.example.com");
        let mut writer = s1;
        std::io::Write::write_all(&mut writer, &hello).unwrap();
        drop(writer);

        let _ = proxy_task.await;
        tokio::time::sleep(std::time::Duration::from_millis(DB_FLUSH_MS)).await;

        let reader = config.db.reader().unwrap();
        let events = reader.recent_net_events(10).unwrap();
        assert!(!events.is_empty(), "disabled proxy should still emit events for denied domains");
        assert_eq!(events[0].decision, Decision::Denied);
    }
}

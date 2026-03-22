/// WireGuard tunnel using boringtun (crypto) + smoltcp (userspace TCP/IP).
///
/// Data flow:
///   App TCP connect → smoltcp socket → smoltcp Interface → VpnDevice →
///   boringtun encrypt → UDP socket → WireGuard server
///
///   WireGuard server → UDP socket → boringtun decrypt → VpnDevice →
///   smoltcp Interface → smoltcp socket → App TCP read
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::{Arc, Mutex};

use boringtun::noise::{Tunn, TunnResult};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp::{self, Socket as TcpSocket};
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{IpAddress, IpCidr};
use tracing::{debug, warn};

use super::config::WireGuardConfig;

/// Maximum WireGuard packet size.
const MAX_PACKET: usize = 65536;

/// A running WireGuard tunnel that provides TCP connections through the encrypted tunnel.
pub struct WgTunnel {
    inner: Arc<Mutex<TunnelInner>>,
}

struct TunnelInner {
    /// boringtun WireGuard tunnel (handles handshake + encryption).
    tunn: Tunn,
    /// UDP socket to the WireGuard endpoint.
    udp: UdpSocket,
    /// smoltcp network interface.
    iface: Interface,
    /// smoltcp socket set.
    sockets: SocketSet<'static>,
    /// Virtual device bridging smoltcp <-> boringtun.
    device: VpnDevice,
    /// Scratch buffer for boringtun output.
    scratch: Vec<u8>,
}

/// Virtual network device that bridges smoltcp and boringtun.
///
/// - `outgoing`: IP packets from smoltcp to be encrypted by boringtun and sent via UDP.
/// - `incoming`: Decrypted IP packets from boringtun to be processed by smoltcp.
struct VpnDevice {
    outgoing: Vec<Vec<u8>>,
    incoming: Vec<Vec<u8>>,
}

impl VpnDevice {
    fn new() -> Self {
        Self {
            outgoing: Vec::new(),
            incoming: Vec::new(),
        }
    }
}

impl Device for VpnDevice {
    type RxToken<'a> = VpnRxToken;
    type TxToken<'a> = VpnTxToken<'a>;

    fn receive(&mut self, _timestamp: SmolInstant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if self.incoming.is_empty() {
            return None;
        }
        let packet = self.incoming.remove(0);
        Some((
            VpnRxToken(packet),
            VpnTxToken(&mut self.outgoing),
        ))
    }

    fn transmit(&mut self, _timestamp: SmolInstant) -> Option<Self::TxToken<'_>> {
        Some(VpnTxToken(&mut self.outgoing))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = 1420; // WireGuard MTU
        caps
    }
}

struct VpnRxToken(Vec<u8>);

impl RxToken for VpnRxToken {
    fn consume<R, F>(self, f: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        f(&self.0)
    }
}

struct VpnTxToken<'a>(&'a mut Vec<Vec<u8>>);

impl<'a> TxToken for VpnTxToken<'a> {
    fn consume<R, F>(self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut buf = vec![0u8; len];
        let result = f(&mut buf);
        self.0.push(buf);
        result
    }
}

impl WgTunnel {
    /// Create a new WireGuard tunnel from parsed config.
    ///
    /// This performs the initial handshake synchronously (blocking).
    pub fn new(config: &WireGuardConfig) -> Result<Self, String> {
        // Decode WireGuard keys.
        let private_key = decode_key(&config.interface.private_key, "PrivateKey")?;
        let public_key = decode_key(&config.peer.public_key, "PublicKey")?;
        let preshared_key = config.peer.preshared_key.as_ref()
            .map(|k| decode_key(k, "PresharedKey"))
            .transpose()?;

        // Create boringtun tunnel (returns Self, not Result).
        let tunn = Tunn::new(
            private_key.into(),
            public_key.into(),
            preshared_key.map(|k| k.into()),
            config.peer.persistent_keepalive,
            0, // index
            None, // rate limiter
        );

        // Create UDP socket to WireGuard endpoint.
        let udp = UdpSocket::bind("0.0.0.0:0")
            .map_err(|e| format!("bind UDP: {e}"))?;
        udp.connect(config.peer.endpoint)
            .map_err(|e| format!("connect to endpoint {}: {e}", config.peer.endpoint))?;
        udp.set_nonblocking(true)
            .map_err(|e| format!("set nonblocking: {e}"))?;

        // Create smoltcp interface.
        let mut device = VpnDevice::new();
        let iface_config = IfaceConfig::new(smoltcp::wire::HardwareAddress::Ip);
        let mut iface = Interface::new(iface_config, &mut device, SmolInstant::now());

        // smoltcp's Ipv4Address is core::net::Ipv4Addr (re-exported).
        let tunnel_addr = config.interface.address;
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(
                IpAddress::Ipv4(tunnel_addr),
                config.interface.address_prefix,
            ));
        });
        // Route all traffic through the tunnel gateway (use tunnel address as gateway).
        iface.routes_mut().add_default_ipv4_route(tunnel_addr)
            .map_err(|e| format!("add default route: {e}"))?;

        let sockets = SocketSet::new(Vec::new());
        let scratch = vec![0u8; MAX_PACKET];

        let inner = TunnelInner {
            tunn,
            udp,
            iface,
            sockets,
            device,
            scratch,
        };

        let tunnel = Self {
            inner: Arc::new(Mutex::new(inner)),
        };

        // Initiate WireGuard handshake.
        tunnel.initiate_handshake()?;

        Ok(tunnel)
    }

    /// Initiate the WireGuard handshake.
    fn initiate_handshake(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let mut dst = vec![0u8; MAX_PACKET];

        match inner.tunn.format_handshake_initiation(&mut dst, false) {
            TunnResult::WriteToNetwork(data) => {
                inner.udp.send(data)
                    .map_err(|e| format!("send handshake init: {e}"))?;
                debug!("WireGuard: sent handshake initiation");
            }
            TunnResult::Err(e) => {
                return Err(format!("handshake initiation failed: {e:?}"));
            }
            _ => {}
        }
        Ok(())
    }

    /// Drive the tunnel: receive from UDP, decrypt, feed to smoltcp.
    /// Must be called periodically (e.g. in a poll loop).
    pub fn poll(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        // Destructure once to satisfy the borrow checker — all fields are
        // borrowed independently so Rust can verify non-overlapping access.
        let TunnelInner {
            ref mut tunn,
            ref udp,
            ref mut iface,
            ref mut sockets,
            ref mut device,
            ref mut scratch,
        } = *guard;

        // 1. Read incoming UDP packets and decrypt with boringtun.
        let mut udp_buf = [0u8; MAX_PACKET];
        loop {
            match udp.recv(&mut udp_buf) {
                Ok(n) => {
                    let data = udp_buf[..n].to_vec();
                    Self::process_udp_packet(tunn, udp, device, scratch, &data);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => {
                    warn!("WireGuard UDP recv error: {e}");
                    break;
                }
            }
        }

        // 2. Drive smoltcp: process incoming IP packets, advance TCP state machines.
        let now = SmolInstant::now();
        iface.poll(now, device, sockets);

        // 3. Encrypt outgoing IP packets from smoltcp and send via UDP.
        let outgoing: Vec<Vec<u8>> = device.outgoing.drain(..).collect();
        for packet in &outgoing {
            Self::encrypt_and_send_static(tunn, udp, packet);
        }

        // 4. Run timers (keepalive, rekey).
        Self::run_timers_static(tunn, udp);

        Ok(())
    }

    /// Process a received UDP packet through boringtun.
    fn process_udp_packet(tunn: &mut Tunn, udp: &UdpSocket, device: &mut VpnDevice, scratch: &mut [u8], data: &[u8]) {
        let mut result = tunn.decapsulate(None, data, scratch);
        loop {
            match result {
                TunnResult::Done => break,
                TunnResult::WriteToNetwork(resp) => {
                    let _ = udp.send(resp);
                    // After sending, check for more work with empty input.
                    let mut new_scratch = vec![0u8; MAX_PACKET];
                    result = tunn.decapsulate(None, &[], &mut new_scratch);
                    // Copy result data if needed before new_scratch drops.
                    match result {
                        TunnResult::WriteToTunnelV4(ip_packet, _addr) => {
                            device.incoming.push(ip_packet.to_vec());
                            break;
                        }
                        TunnResult::WriteToNetwork(resp2) => {
                            let _ = udp.send(resp2);
                            break;
                        }
                        _ => break,
                    }
                }
                TunnResult::WriteToTunnelV4(ip_packet, _addr) => {
                    device.incoming.push(ip_packet.to_vec());
                    break;
                }
                TunnResult::WriteToTunnelV6(_ip_packet, _addr) => {
                    break;
                }
                TunnResult::Err(e) => {
                    debug!("WireGuard decrypt error: {e:?}");
                    break;
                }
            }
        }
    }

    /// Encrypt an IP packet and send it via UDP.
    fn encrypt_and_send_static(tunn: &mut Tunn, udp: &UdpSocket, ip_packet: &[u8]) {
        let mut dst = vec![0u8; ip_packet.len() + 64]; // room for WG overhead
        match tunn.encapsulate(ip_packet, &mut dst) {
            TunnResult::WriteToNetwork(data) => {
                let _ = udp.send(data);
            }
            TunnResult::Err(e) => {
                debug!("WireGuard encrypt error: {e:?}");
            }
            _ => {}
        }
    }

    /// Run boringtun timers (keepalive, handshake retry).
    fn run_timers_static(tunn: &mut Tunn, udp: &UdpSocket) {
        let mut dst = vec![0u8; MAX_PACKET];
        match tunn.update_timers(&mut dst) {
            TunnResult::WriteToNetwork(data) => {
                let _ = udp.send(data);
            }
            TunnResult::Err(e) => {
                debug!("WireGuard timer error: {e:?}");
            }
            _ => {}
        }
    }

    /// Open a TCP connection through the tunnel to the given address.
    /// Returns a socket handle that can be used with `read` and `write`.
    pub fn tcp_connect(&self, addr: Ipv4Addr, port: u16) -> Result<SocketHandle, String> {
        let mut inner = self.inner.lock().unwrap();

        let rx_buf = tcp::SocketBuffer::new(vec![0u8; 65535]);
        let tx_buf = tcp::SocketBuffer::new(vec![0u8; 65535]);
        let socket = TcpSocket::new(rx_buf, tx_buf);

        let handle = inner.sockets.add(socket);

        // Use a random ephemeral port.
        let local_port = 49152 + (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() % 16384) as u16;

        let remote = (IpAddress::Ipv4(addr), port);
        let TunnelInner { ref mut iface, ref mut sockets, .. } = *inner;
        let tcp_socket = sockets.get_mut::<TcpSocket>(handle);
        tcp_socket.connect(iface.context(), remote, local_port)
            .map_err(|e| format!("TCP connect: {e}"))?;

        Ok(handle)
    }

    /// Read data from a TCP socket. Returns bytes read, or empty if not ready.
    pub fn tcp_read(&self, handle: SocketHandle, buf: &mut [u8]) -> Result<usize, String> {
        let mut inner = self.inner.lock().unwrap();
        let socket = inner.sockets.get_mut::<TcpSocket>(handle);

        if !socket.may_recv() {
            return Err("socket closed for reading".to_string());
        }

        match socket.recv_slice(buf) {
            Ok(n) => Ok(n),
            Err(tcp::RecvError::Finished) => Err("connection finished".to_string()),
            Err(tcp::RecvError::InvalidState) => Err("invalid socket state".to_string()),
        }
    }

    /// Write data to a TCP socket. Returns bytes written, or 0 if buffer full.
    pub fn tcp_write(&self, handle: SocketHandle, data: &[u8]) -> Result<usize, String> {
        let mut inner = self.inner.lock().unwrap();
        let socket = inner.sockets.get_mut::<TcpSocket>(handle);

        if !socket.may_send() {
            return Err("socket closed for writing".to_string());
        }

        socket.send_slice(data)
            .map_err(|_| "send buffer full".to_string())
    }

    /// Check if a TCP socket is in an active TCP state (SYN-SENT or later).
    pub fn tcp_is_active(&self, handle: SocketHandle) -> bool {
        let inner = self.inner.lock().unwrap();
        let socket = inner.sockets.get::<TcpSocket>(handle);
        socket.is_active()
    }

    /// Check if a TCP socket is fully established and ready to send data.
    pub fn tcp_may_send(&self, handle: SocketHandle) -> bool {
        let inner = self.inner.lock().unwrap();
        let socket = inner.sockets.get::<TcpSocket>(handle);
        socket.may_send()
    }

    /// Close a TCP socket.
    pub fn tcp_close(&self, handle: SocketHandle) {
        let mut inner = self.inner.lock().unwrap();
        let socket = inner.sockets.get_mut::<TcpSocket>(handle);
        socket.close();
    }

    /// Check if the tunnel handshake is complete (data can flow).
    pub fn is_established(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.tunn.time_since_last_handshake().is_some()
    }
}

/// Decode a base64-encoded 32-byte WireGuard key.
fn decode_key(b64: &str, name: &str) -> Result<[u8; 32], String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64)
        .map_err(|e| format!("{name}: base64 decode: {e}"))?;
    let arr: [u8; 32] = bytes.try_into()
        .map_err(|v: Vec<u8>| format!("{name}: expected 32 bytes, got {}", v.len()))?;
    Ok(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_valid_key() {
        let key = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
        let result = decode_key(key, "test");
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 32);
    }

    #[test]
    fn decode_invalid_base64() {
        let result = decode_key("not-valid-base64!!!", "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("base64"));
    }

    #[test]
    fn decode_wrong_length() {
        let result = decode_key("AAAA", "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("32 bytes"));
    }

    #[test]
    fn vpn_device_capabilities() {
        let dev = VpnDevice::new();
        let caps = dev.capabilities();
        assert_eq!(caps.medium, Medium::Ip);
        assert_eq!(caps.max_transmission_unit, 1420);
    }

    #[test]
    fn vpn_device_receive_empty() {
        let mut dev = VpnDevice::new();
        assert!(dev.receive(SmolInstant::now()).is_none());
    }

    #[test]
    fn vpn_device_transmit_captures_packet() {
        let mut dev = VpnDevice::new();
        let token = dev.transmit(SmolInstant::now()).unwrap();
        token.consume(10, |buf| {
            buf.copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        });
        assert_eq!(dev.outgoing.len(), 1);
        assert_eq!(dev.outgoing[0], vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn vpn_device_incoming_feeds_receive() {
        let mut dev = VpnDevice::new();
        dev.incoming.push(vec![0xAA, 0xBB]);
        let (rx, _tx) = dev.receive(SmolInstant::now()).unwrap();
        rx.consume(|buf| {
            assert_eq!(buf, &[0xAA, 0xBB]);
        });
    }
}

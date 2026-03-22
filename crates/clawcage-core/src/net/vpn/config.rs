/// WireGuard configuration parser.
///
/// Parses standard WireGuard INI-style config files with [Interface] and [Peer] sections.
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Parsed WireGuard configuration.
#[derive(Debug, Clone)]
pub struct WireGuardConfig {
    pub interface: InterfaceConfig,
    pub peer: PeerConfig,
}

/// [Interface] section of a WireGuard config.
#[derive(Debug, Clone)]
pub struct InterfaceConfig {
    /// Base64-encoded private key.
    pub private_key: String,
    /// Local tunnel address (e.g. 10.0.0.2/32).
    pub address: Ipv4Addr,
    /// CIDR prefix length for the tunnel address.
    pub address_prefix: u8,
    /// Optional DNS servers.
    pub dns: Vec<IpAddr>,
}

/// [Peer] section of a WireGuard config.
#[derive(Debug, Clone)]
pub struct PeerConfig {
    /// Base64-encoded public key.
    pub public_key: String,
    /// Optional pre-shared key (base64).
    pub preshared_key: Option<String>,
    /// Endpoint (IP:port) of the WireGuard server.
    pub endpoint: SocketAddr,
    /// Allowed IPs (CIDR ranges routed through the tunnel).
    pub allowed_ips: Vec<String>,
    /// Persistent keepalive interval in seconds.
    pub persistent_keepalive: Option<u16>,
}

/// Parse a WireGuard configuration string.
pub fn parse(input: &str) -> Result<WireGuardConfig, String> {
    let mut section = None;
    let mut iface = PartialInterface::default();
    let mut peer = PartialPeer::default();

    for (line_num, raw_line) in input.lines().enumerate() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }

        // Section header
        if line.starts_with('[') && line.ends_with(']') {
            let name = &line[1..line.len() - 1];
            match name {
                "Interface" => section = Some(Section::Interface),
                "Peer" => section = Some(Section::Peer),
                _ => return Err(format!("line {}: unknown section [{name}]", line_num + 1)),
            }
            continue;
        }

        // Key = Value
        let (key, value) = line.split_once('=')
            .map(|(k, v)| (k.trim(), v.trim()))
            .ok_or_else(|| format!("line {}: expected Key = Value", line_num + 1))?;

        match section {
            Some(Section::Interface) => parse_interface_field(key, value, &mut iface, line_num + 1)?,
            Some(Section::Peer) => parse_peer_field(key, value, &mut peer, line_num + 1)?,
            None => return Err(format!("line {}: key outside of section", line_num + 1)),
        }
    }

    let interface = iface.build()?;
    let peer_config = peer.build()?;

    Ok(WireGuardConfig {
        interface,
        peer: peer_config,
    })
}

#[derive(Debug, Clone, Copy)]
enum Section {
    Interface,
    Peer,
}

#[derive(Default)]
struct PartialInterface {
    private_key: Option<String>,
    address: Option<(Ipv4Addr, u8)>,
    dns: Vec<IpAddr>,
}

impl PartialInterface {
    fn build(self) -> Result<InterfaceConfig, String> {
        let private_key = self.private_key.ok_or("[Interface] missing PrivateKey")?;
        let (address, prefix) = self.address.ok_or("[Interface] missing Address")?;
        Ok(InterfaceConfig {
            private_key,
            address,
            address_prefix: prefix,
            dns: self.dns,
        })
    }
}

#[derive(Default)]
struct PartialPeer {
    public_key: Option<String>,
    preshared_key: Option<String>,
    endpoint: Option<SocketAddr>,
    allowed_ips: Vec<String>,
    persistent_keepalive: Option<u16>,
}

impl PartialPeer {
    fn build(self) -> Result<PeerConfig, String> {
        let public_key = self.public_key.ok_or("[Peer] missing PublicKey")?;
        let endpoint = self.endpoint.ok_or("[Peer] missing Endpoint")?;
        if self.allowed_ips.is_empty() {
            return Err("[Peer] missing AllowedIPs".to_string());
        }
        Ok(PeerConfig {
            public_key,
            preshared_key: self.preshared_key,
            endpoint,
            allowed_ips: self.allowed_ips,
            persistent_keepalive: self.persistent_keepalive,
        })
    }
}

fn parse_interface_field(key: &str, value: &str, iface: &mut PartialInterface, line: usize) -> Result<(), String> {
    match key {
        "PrivateKey" => {
            validate_base64_key(value, line)?;
            iface.private_key = Some(value.to_string());
        }
        "Address" => {
            let (addr, prefix) = parse_cidr_v4(value)
                .map_err(|e| format!("line {line}: Address: {e}"))?;
            iface.address = Some((addr, prefix));
        }
        "DNS" => {
            for part in value.split(',') {
                let trimmed = part.trim();
                if !trimmed.is_empty() {
                    let ip: IpAddr = trimmed.parse()
                        .map_err(|e| format!("line {line}: DNS: {e}"))?;
                    iface.dns.push(ip);
                }
            }
        }
        // Silently ignore ListenPort, MTU, etc. — not needed for client tunnels.
        _ => {}
    }
    Ok(())
}

fn parse_peer_field(key: &str, value: &str, peer: &mut PartialPeer, line: usize) -> Result<(), String> {
    match key {
        "PublicKey" => {
            validate_base64_key(value, line)?;
            peer.public_key = Some(value.to_string());
        }
        "PresharedKey" => {
            validate_base64_key(value, line)?;
            peer.preshared_key = Some(value.to_string());
        }
        "Endpoint" => {
            let addr: SocketAddr = value.parse()
                .map_err(|e| format!("line {line}: Endpoint: {e}"))?;
            peer.endpoint = Some(addr);
        }
        "AllowedIPs" => {
            for part in value.split(',') {
                let trimmed = part.trim();
                if !trimmed.is_empty() {
                    // Validate CIDR format loosely.
                    if !trimmed.contains('/') {
                        return Err(format!("line {line}: AllowedIPs: expected CIDR notation (e.g. 0.0.0.0/0)"));
                    }
                    peer.allowed_ips.push(trimmed.to_string());
                }
            }
        }
        "PersistentKeepalive" => {
            let secs: u16 = value.parse()
                .map_err(|e| format!("line {line}: PersistentKeepalive: {e}"))?;
            peer.persistent_keepalive = Some(secs);
        }
        _ => {}
    }
    Ok(())
}

/// Parse an IPv4 CIDR address like "10.0.0.2/32".
fn parse_cidr_v4(s: &str) -> Result<(Ipv4Addr, u8), String> {
    let (addr_str, prefix_str) = s.split_once('/')
        .ok_or_else(|| "expected CIDR notation (e.g. 10.0.0.2/32)".to_string())?;
    let addr: Ipv4Addr = addr_str.trim().parse()
        .map_err(|e| format!("invalid IPv4: {e}"))?;
    let prefix: u8 = prefix_str.trim().parse()
        .map_err(|e| format!("invalid prefix: {e}"))?;
    if prefix > 32 {
        return Err(format!("prefix {prefix} out of range (0-32)"));
    }
    Ok((addr, prefix))
}

/// Validate a base64-encoded 32-byte key (WireGuard key format).
fn validate_base64_key(value: &str, line: usize) -> Result<(), String> {
    // WireGuard keys are 32 bytes = 44 base64 chars with padding.
    if value.len() != 44 || !value.ends_with('=') {
        return Err(format!("line {line}: invalid key format (expected 44-char base64)"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CONFIG: &str = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.200.100.8/32
DNS = 10.200.100.1

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 203.0.113.1:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
"#;

    #[test]
    fn parse_valid_config() {
        let cfg = parse(SAMPLE_CONFIG).unwrap();
        assert_eq!(cfg.interface.private_key, "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=");
        assert_eq!(cfg.interface.address, Ipv4Addr::new(10, 200, 100, 8));
        assert_eq!(cfg.interface.address_prefix, 32);
        assert_eq!(cfg.interface.dns.len(), 1);
        assert_eq!(cfg.peer.public_key, "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=");
        assert_eq!(cfg.peer.endpoint, "203.0.113.1:51820".parse().unwrap());
        assert_eq!(cfg.peer.allowed_ips, vec!["0.0.0.0/0"]);
        assert_eq!(cfg.peer.persistent_keepalive, Some(25));
    }

    #[test]
    fn parse_config_with_comments() {
        let input = r#"
# My VPN config
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/24  # local address
DNS = 1.1.1.1, 8.8.8.8

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0/0, 10.0.0.0/8
"#;
        let cfg = parse(input).unwrap();
        assert_eq!(cfg.interface.address_prefix, 24);
        assert_eq!(cfg.interface.dns.len(), 2);
        assert_eq!(cfg.peer.allowed_ips.len(), 2);
    }

    #[test]
    fn parse_with_preshared_key() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
PresharedKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0/0
"#;
        let cfg = parse(input).unwrap();
        assert!(cfg.peer.preshared_key.is_some());
    }

    #[test]
    fn missing_private_key() {
        let input = r#"
[Interface]
Address = 10.0.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0/0
"#;
        assert!(parse(input).unwrap_err().contains("PrivateKey"));
    }

    #[test]
    fn missing_peer_section() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32
"#;
        assert!(parse(input).unwrap_err().contains("PublicKey"));
    }

    #[test]
    fn missing_endpoint() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
AllowedIPs = 0.0.0.0/0
"#;
        assert!(parse(input).unwrap_err().contains("Endpoint"));
    }

    #[test]
    fn missing_allowed_ips() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
"#;
        assert!(parse(input).unwrap_err().contains("AllowedIPs"));
    }

    #[test]
    fn invalid_key_format() {
        let input = r#"
[Interface]
PrivateKey = too-short
Address = 10.0.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0/0
"#;
        assert!(parse(input).unwrap_err().contains("invalid key format"));
    }

    #[test]
    fn invalid_cidr_no_slash() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0/0
"#;
        assert!(parse(input).unwrap_err().contains("CIDR"));
    }

    #[test]
    fn invalid_cidr_prefix_too_large() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/33

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0/0
"#;
        assert!(parse(input).unwrap_err().contains("out of range"));
    }

    #[test]
    fn unknown_section_rejected() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32

[Bogus]
Foo = bar
"#;
        assert!(parse(input).unwrap_err().contains("unknown section"));
    }

    #[test]
    fn key_outside_section_rejected() {
        let input = "PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\n";
        assert!(parse(input).unwrap_err().contains("outside of section"));
    }

    #[test]
    fn empty_config() {
        assert!(parse("").unwrap_err().contains("PrivateKey"));
    }

    #[test]
    fn allowed_ips_without_cidr_rejected() {
        let input = r#"
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = 1.2.3.4:51820
AllowedIPs = 0.0.0.0
"#;
        assert!(parse(input).unwrap_err().contains("CIDR"));
    }
}

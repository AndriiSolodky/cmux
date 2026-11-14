//! The TCP ports a process listens on, for the daemon's terminal ports
//! (cmux-tui-core `mux/terminal_ports.rs`). It reads only the processes it
//! is asked about and spawns nothing:
//!
//! - Linux: the LISTEN rows of `/proc/net/tcp` and `/proc/net/tcp6` once per
//!   [`Listeners::read`], then a process's sockets from `/proc/<pid>/fd`.
//! - macOS: a process's socket descriptors (`PROC_PIDLISTFDS`) and each one's
//!   `socket_fdinfo` (`PROC_PIDFDSOCKETINFO`), at the offsets
//!   cmux-browser-host `egress_listeners.rs` measured from the SDK headers.
//!
//! A process that exited between the listing and the read has no ports; a
//! read that fails otherwise also gives none (the entry it feeds is advisory).

use std::collections::BTreeSet;

/// The machine's LISTEN sockets, read once per scan.
#[derive(Debug, Default)]
pub struct Listeners {
    /// Socket inode to its port (Linux).
    #[cfg(target_os = "linux")]
    by_inode: std::collections::HashMap<u64, u16>,
}

impl Listeners {
    /// The LISTEN sockets now: `None` on a platform this does not read.
    pub fn read() -> Option<Self> {
        #[cfg(target_os = "linux")]
        {
            let mut by_inode = std::collections::HashMap::new();
            for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
                // No IPv6 table (a kernel without IPv6): nothing listens there.
                let Ok(text) = std::fs::read_to_string(table) else { continue };
                by_inode.extend(
                    parse_proc_net_tcp(&text).into_iter().map(|(port, inode)| (inode, port)),
                );
            }
            Some(Self { by_inode })
        }
        #[cfg(target_os = "macos")]
        {
            Some(Self {})
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            None
        }
    }

    /// What changes when a socket starts or stops listening anywhere on the
    /// machine, so a caller can skip the per-process reads while it stays
    /// the same. `None` where the machine-wide table is not read (macOS):
    /// every scan reads the processes.
    pub fn fingerprint(&self) -> Option<BTreeSet<u64>> {
        #[cfg(target_os = "linux")]
        {
            Some(self.by_inode.keys().copied().collect())
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }

    /// The ports process `pid` listens on (TCP, IPv4 or IPv6, any address).
    pub fn ports_of(&self, pid: u32) -> BTreeSet<u16> {
        #[cfg(target_os = "linux")]
        {
            let mut ports = BTreeSet::new();
            if self.by_inode.is_empty() {
                return ports;
            }
            let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return ports };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else { continue };
                if let Some(port) = socket_inode(&target.to_string_lossy())
                    .and_then(|inode| self.by_inode.get(&inode))
                {
                    ports.insert(*port);
                }
            }
            ports
        }
        #[cfg(target_os = "macos")]
        {
            mac::ports_of(pid)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = pid;
            BTreeSet::new()
        }
    }
}

/// The inode of an fd link `socket:[<inode>]`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
}

/// `(port, inode)` of each LISTEN row of a `/proc/net/tcp` or `tcp6` table
/// (state `0A`). A row that does not parse is skipped.
pub fn parse_proc_net_tcp(text: &str) -> Vec<(u16, u64)> {
    const LISTEN: &str = "0A";
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.get(3) != Some(&LISTEN) {
                return None;
            }
            let port = fields.get(1)?.rsplit_once(':')?.1;
            let port = u16::from_str_radix(port, 16).ok().filter(|port| *port != 0)?;
            let inode = fields.get(9)?.parse::<u64>().ok().filter(|inode| *inode != 0)?;
            Some((port, inode))
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::BTreeSet;

    const SFI_SIZE: usize = 792;
    const SFI_KIND: usize = 256;
    const SFI_LPORT: usize = 268;
    const SFI_STATE: usize = 344;

    fn u32_at(data: &[u8], at: usize) -> Option<u32> {
        Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
    }

    pub(super) fn ports_of(pid: u32) -> BTreeSet<u16> {
        let Ok(pid) = i32::try_from(pid) else { return BTreeSet::new() };
        socket_fds(pid).into_iter().filter_map(|fd| listening_port(pid, fd)).collect()
    }

    /// The socket descriptors of `pid`; none when it exited or does not read.
    fn socket_fds(pid: i32) -> Vec<i32> {
        const PROX_FDTYPE_SOCKET: u32 = 2;
        // SAFETY: a size query (null buffer).
        let bytes =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return Vec::new();
        }
        let size = size_of::<libc::proc_fdinfo>();
        let mut count = bytes as usize / size + 16;
        for _ in 0..4 {
            let mut fds = vec![libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; count];
            let room = (fds.len() * size) as libc::c_int;
            // SAFETY: the buffer is writable for `room` bytes, which is passed.
            let filled = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), room)
            };
            if filled <= 0 {
                return Vec::new();
            }
            if filled < room {
                fds.truncate(filled as usize / size);
                return fds
                    .into_iter()
                    .filter(|fd| fd.proc_fdtype == PROX_FDTYPE_SOCKET)
                    .map(|fd| fd.proc_fd)
                    .collect();
            }
            count *= 2;
        }
        Vec::new()
    }

    /// The port of socket `fd` of `pid` when it is a TCP socket in LISTEN.
    fn listening_port(pid: i32, fd: i32) -> Option<u16> {
        const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
        const SOCKINFO_TCP: u32 = 2;
        const TSI_S_LISTEN: u32 = 1;
        let mut info = vec![0u8; SFI_SIZE];
        // SAFETY: the buffer is writable for SFI_SIZE bytes, which is passed.
        let filled = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDSOCKETINFO,
                info.as_mut_ptr().cast(),
                SFI_SIZE as libc::c_int,
            )
        };
        if filled as usize != SFI_SIZE
            || u32_at(&info, SFI_KIND) != Some(SOCKINFO_TCP)
            || u32_at(&info, SFI_STATE) != Some(TSI_S_LISTEN)
        {
            return None;
        }
        Some(u16::from_be_bytes([info[SFI_LPORT], info[SFI_LPORT + 1]])).filter(|port| *port != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_net_tcp_rows_in_listen_give_their_port_and_inode() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1
   2: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0
";
        // The established row and the inode-0 row (a socket with no owner) are not listeners.
        assert_eq!(parse_proc_net_tcp(table), [(3000, 41234)]);
        let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52000 1 0000000000000000 100 0 0 10 0
";
        assert_eq!(parse_proc_net_tcp(tcp6), [(5173, 52000)]);
        assert_eq!(socket_inode("socket:[52000]"), Some(52000));
        assert_eq!(socket_inode("pipe:[52000]"), None);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn this_process_reads_the_port_it_listens_on() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let listeners = Listeners::read().expect("this platform reads listeners");
        assert!(listeners.ports_of(std::process::id()).contains(&port));
        drop(listener);
        let after = Listeners::read().unwrap();
        assert!(!after.ports_of(std::process::id()).contains(&port));
    }
}

//! The viewer's ready queue (newest wins, design D2) and its loss timing
//! (one NACK, give up after RTT + 10 ms, design D6), in safe Rust.

use super::*;
use crate::receiver::MAX_READY_FRAMES;
use cmux_rd_core::packetize::Packetizer;
use cmux_rd_proto::{
    ClockPing, ClockPong, DatagramHeader, DatagramKind, Feedback, FrameBody, MAX_DATAGRAM_VPC,
    REF_NONE, flags,
};

/// The datagrams of frame `frame` with `flags`, predicting from `ref_frame`.
fn packets(p: &mut Packetizer, frame: u32, flags: u8, ref_frame: u32, len: usize) -> Vec<Vec<u8>> {
    let body = FrameBody {
        t_capture_us: u64::from(frame) * 16_667,
        ref_frame,
        access_unit: vec![frame as u8; len],
    };
    p.packetize(frame, flags, &body, 0).expect("packetize").datagrams
}

fn deliver(r: &mut Receiver, datagrams: &[Vec<u8>], now: u64) {
    for d in datagrams {
        r.push_datagram(d, now).expect("push");
    }
}

fn receiver() -> Receiver {
    Receiver::new(Carrier::Datagram, 200_000, 5_000)
}

fn ready(r: &mut Receiver) -> Vec<u32> {
    std::iter::from_fn(|| r.pop_frame()).map(|f| f.frame).collect()
}

fn decode_feedback(datagram: &[u8]) -> Feedback {
    let (h, payload) = DatagramHeader::decode(datagram).expect("header");
    assert_eq!(h.kind, DatagramKind::Feedback);
    Feedback::decode(payload).expect("feedback")
}

#[test]
fn a_keyframe_replaces_every_frame_still_waiting() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 3000), 0);
    deliver(&mut r, &packets(&mut p, 2, 0, 1, 3000), 16_000);
    deliver(&mut r, &packets(&mut p, 3, 0, 2, 3000), 33_000);
    assert_eq!(r.ready_frames(), 3, "the caller has not decoded yet");
    deliver(&mut r, &packets(&mut p, 4, flags::KEYFRAME, REF_NONE, 3000), 50_000);
    // An IDR needs nothing before it: only the newest is decoded.
    assert_eq!(ready(&mut r), vec![4]);
    let stats = r.stats();
    assert_eq!(stats.frames_skipped, 3);
    assert_eq!(stats.frames_lost, 0);
    assert!(!stats.need_recovery);
}

#[test]
fn a_reference_chain_is_never_skipped() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 3000), 0);
    for f in 2..=5 {
        deliver(&mut r, &packets(&mut p, f, 0, f - 1, 3000), u64::from(f) * 16_000);
    }
    // Each P-frame needs the one before it: all go to the decoder, in order.
    assert_eq!(ready(&mut r), vec![1, 2, 3, 4, 5]);
    assert_eq!(r.stats().frames_skipped, 0);
}

#[test]
fn a_recovery_frame_keeps_the_frames_before_it() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 3000), 0);
    deliver(&mut r, &packets(&mut p, 2, 0, 1, 3000), 16_000);
    // Frame 3 is lost whole; frame 4 predicts from it and cannot be shown.
    let _lost = packets(&mut p, 3, 0, 2, 3000);
    deliver(&mut r, &packets(&mut p, 4, 0, 3, 3000), 50_000);
    assert!(r.need_recovery());
    // The recovery frame predicts from frame 1, a long-term reference. Frame
    // 2 stays: the host counts it received and may predict from it later.
    deliver(&mut r, &packets(&mut p, 5, flags::RECOVERY, 1, 3000), 66_000);
    assert_eq!(ready(&mut r), vec![1, 2, 5]);
    assert_eq!(r.stats().frames_skipped, 0);
    assert!(!r.need_recovery());
}

#[test]
fn tile_frames_never_replace_each_other() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    // Tile top-offs each cover their own region; ref_frame names a video frame.
    for f in 1..=3 {
        deliver(&mut r, &packets(&mut p, f, flags::TILE, REF_NONE, 500), u64::from(f) * 1_000);
    }
    assert_eq!(ready(&mut r), vec![1, 2, 3]);
    assert_eq!(r.stats().frames_skipped, 0);
}

#[test]
fn a_chain_longer_than_the_queue_is_dropped_until_a_keyframe() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 500), 0);
    let last = MAX_READY_FRAMES as u32 + 1;
    for f in 2..=last {
        deliver(&mut r, &packets(&mut p, f, 0, f - 1, 500), u64::from(f) * 1_000);
    }
    // The caller fell a whole queue behind: decoding past the hole would show
    // a corrupted picture, so the chain goes and a keyframe is asked for.
    assert_eq!(r.ready_frames(), 0);
    assert_eq!(r.stats().frames_lost, u64::from(last));
    assert!(r.need_recovery());
    // P-frames after the hole are dropped too, until the keyframe.
    deliver(&mut r, &packets(&mut p, last + 1, 0, last, 500), 30_000);
    assert_eq!(r.ready_frames(), 0);
    assert!(r.need_recovery());
    deliver(&mut r, &packets(&mut p, last + 2, flags::KEYFRAME, REF_NONE, 500), 31_000);
    assert_eq!(ready(&mut r), vec![last + 2]);
    assert!(!r.need_recovery());
}

/// With no clock, the repairs themselves measure the round trip: three
/// repairs 60 ms after their NACKs size the window to 70 ms, so the next
/// unrepaired frame is given up 70 ms after its NACK instead of 200 ms after
/// its first shard, and the recovery request leaves in the same call.
#[test]
fn measured_repairs_size_the_wait_and_a_given_up_frame_asks_for_recovery_at_once() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 3000), 0);
    assert_eq!(ready(&mut r), vec![1]);
    assert!(r.feedback(0).is_some());
    for f in 2..=4u32 {
        let at = u64::from(f - 1) * 100_000;
        let frame = packets(&mut p, f, 0, f - 1, 3000);
        deliver(&mut r, &frame[1..], at);
        let fb = decode_feedback(&r.feedback(at + 5_000).expect("NACK"));
        assert_eq!(fb.nacks[0].indexes, vec![0]);
        deliver(&mut r, &frame[..1], at + 65_000);
        assert_eq!(ready(&mut r), vec![f]);
        assert!(r.feedback(at + 65_000).is_some());
    }
    let frame = packets(&mut p, 5, 0, 4, 3000);
    deliver(&mut r, &frame[1..], 400_000);
    assert!(!decode_feedback(&r.feedback(405_000).expect("NACK")).nacks.is_empty());
    assert_eq!(r.next_deadline_us(), 475_001, "one 60 ms RTT + 10 ms after the NACK");
    r.tick(475_000);
    assert!(!r.need_recovery());
    r.tick(475_001);
    assert!(r.need_recovery());
    assert_eq!(r.next_deadline_us(), 0, "the request does not wait for the 50 ms interval");
    let fb = decode_feedback(&r.feedback(475_001).expect("recovery at once"));
    assert!(fb.need_recovery);
    assert_eq!(fb.acked_frame, 4);
}

// ---- The tests below use the API this change adds. ----

#[test]
fn a_frame_is_given_up_one_rtt_plus_ten_ms_after_its_nack_and_recovery_goes_out_at_once() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    r.set_path_rtt_us(Some(40_000));
    assert_eq!(r.repair_window_us(), 50_000);
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 3000), 0);
    assert_eq!(ready(&mut r), vec![1]);
    assert!(r.feedback(0).is_some());
    let second = packets(&mut p, 2, 0, 1, 3000);
    deliver(&mut r, &second[1..], 1_000);
    let fb = decode_feedback(&r.feedback(6_000).expect("the NACK after the reorder grace"));
    assert_eq!(fb.nacks.len(), 1);
    assert_eq!(fb.nacks[0].indexes, vec![0]);
    // One window after the NACK, not the 200 ms deadline.
    assert_eq!(r.next_deadline_us(), 56_001);
    r.tick(56_000);
    assert!(!r.need_recovery());
    r.tick(56_001);
    assert!(r.need_recovery());
    assert_eq!(r.stats().frames_lost, 1);
    // The request does not wait for the 50 ms feedback interval.
    assert_eq!(r.next_deadline_us(), 0);
    let fb = decode_feedback(&r.feedback(56_001).expect("recovery at once"));
    assert!(fb.need_recovery);
    assert_eq!(fb.acked_frame, 1);
    assert!(r.feedback(56_002).is_none(), "one immediate request, then the interval");
}

#[test]
fn a_repair_inside_the_window_releases_the_frame() {
    let mut p = Packetizer::new(0, MAX_DATAGRAM_VPC);
    let mut r = receiver();
    r.set_path_rtt_us(Some(20_000));
    deliver(&mut r, &packets(&mut p, 1, flags::KEYFRAME, REF_NONE, 3000), 0);
    let second = packets(&mut p, 2, 0, 1, 3000);
    deliver(&mut r, &second[1..], 1_000);
    assert!(!decode_feedback(&r.feedback(6_000).expect("NACK")).nacks.is_empty());
    deliver(&mut r, &second[..1], 26_000);
    assert_eq!(ready(&mut r), vec![1, 2]);
    assert!(!r.need_recovery());
    assert_eq!(r.stats().frames_lost, 0);
}

#[test]
fn the_session_clock_sizes_every_streams_repair_window() {
    let mut s = Session::new(Carrier::Datagram, 200_000, 5_000);
    assert_eq!(s.repair_window_us(0), Ok(200_000), "the ceiling until an RTT is known");
    s.enable_clock();
    let ping = std::iter::from_fn(|| s.feedback(1_000))
        .find_map(|d| {
            let (h, payload) = DatagramHeader::decode(&d).ok()?;
            (h.kind == DatagramKind::ClockPing).then(|| ClockPing::decode(payload).ok()).flatten()
        })
        .expect("a ping");
    // A 40 ms round trip, nothing held on the host.
    let rx = ping.t_viewer_us + 20_000;
    let pong = ClockPong {
        seq: ping.seq,
        t_viewer_us: ping.t_viewer_us,
        t_host_rx_us: rx,
        t_host_tx_us: rx,
    };
    let mut d = DatagramHeader {
        flags: 0,
        kind: DatagramKind::ClockPong,
        stream: 0,
        frame: 0,
        index: 0,
        count: 0,
        fec_count: 0,
        transport_seq: 0,
    }
    .encode()
    .to_vec();
    d.extend_from_slice(&pong.encode());
    s.push_datagram(&d, ping.t_viewer_us + 40_000).expect("pong");
    assert_eq!(s.repair_window_us(0), Ok(50_000));
    // A stream opened later starts from the same round trip.
    s.open_stream(3).expect("open");
    assert_eq!(s.repair_window_us(3), Ok(50_000));
}

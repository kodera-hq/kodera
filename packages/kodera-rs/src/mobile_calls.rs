//! Bounded call wake reducer. Relay hints never confer membership or media authority.
use crate::mobile_ffi::MobileFfiError;
use crate::OrganisationId;
use std::collections::BTreeMap;

pub const CALL_TTL_SECONDS: u64 = 60;
pub const MAX_CALL_RECORDS: usize = 128;
pub const MAX_CALL_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RingPhase {
    Ringing,
    Connecting,
    Connected,
    AnsweredElsewhere,
    Declined,
    Ended,
    Expired,
    Revoked,
}
impl RingPhase {
    pub fn terminal(self) -> bool {
        !matches!(self, Self::Ringing | Self::Connecting | Self::Connected)
    }
    pub fn wire(self) -> &'static str {
        match self {
            Self::Ringing => "ringing",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::AnsweredElsewhere => "answered_elsewhere",
            Self::Declined => "declined",
            Self::Ended => "ended",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallWake {
    pub call_id: OrganisationId,
    pub organisation_id: OrganisationId,
    pub channel_id: OrganisationId,
    pub epoch: u64,
    pub state: RingPhase,
    pub expires_at: u64,
}
impl CallWake {
    pub fn validate(&self, now: u64) -> Result<(), MobileFfiError> {
        if now == 0
            || now > MAX_CALL_INTEGER - CALL_TTL_SECONDS
            || self.epoch == 0
            || self.epoch > MAX_CALL_INTEGER
            || !matches!(
                self.state,
                RingPhase::Ringing | RingPhase::AnsweredElsewhere | RingPhase::Ended
            )
        {
            return Err(MobileFfiError::InvalidInput);
        }
        if self.expires_at <= now || self.expires_at - now > CALL_TTL_SECONDS {
            return Err(MobileFfiError::StaleEpoch);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingRecord {
    pub wake: CallWake,
    pub phase: RingPhase,
    pub missed: bool,
    retain_until: u64,
}
/// One machine per authenticated session. No live tombstone is ever evicted for capacity.
#[derive(Debug)]
pub struct CallRingMachine {
    organisation_id: OrganisationId,
    records: BTreeMap<String, RingRecord>,
    clock: u64,
}
impl CallRingMachine {
    pub fn new(organisation_id: OrganisationId) -> Self {
        Self {
            organisation_id,
            records: BTreeMap::new(),
            clock: 0,
        }
    }
    pub fn record(&self, call_id: &str) -> Option<&RingRecord> {
        self.records.get(call_id)
    }
    pub fn observe(&mut self, wake: CallWake, now: u64) -> Result<&RingRecord, MobileFfiError> {
        wake.validate(now)?;
        if now < self.clock {
            return Err(MobileFfiError::StaleEpoch);
        }
        if wake.organisation_id != self.organisation_id {
            return Err(MobileFfiError::OrganisationMismatch);
        }
        self.tick(now);
        let key = wake.call_id.as_str().to_owned();
        if let Some(old) = self.records.get(&key) {
            if old.wake.channel_id != wake.channel_id {
                return Err(MobileFfiError::OrganisationMismatch);
            }
            if (old.phase.terminal()
                && !(old.phase == RingPhase::Expired && wake.state == RingPhase::AnsweredElsewhere))
                || wake.epoch <= old.wake.epoch
                || wake.state == RingPhase::Ringing
            {
                return Err(MobileFfiError::Replay);
            }
        } else {
            if self.records.len() >= MAX_CALL_RECORDS {
                return Err(MobileFfiError::Capacity);
            }
            if wake.state == RingPhase::Ringing
                && self.records.values().any(|r| !r.phase.terminal())
            {
                return Err(MobileFfiError::Capacity);
            }
        }
        let phase = wake.state;
        let retain_until = now + CALL_TTL_SECONDS;
        self.records.insert(
            key.clone(),
            RingRecord {
                wake,
                phase,
                missed: false,
                retain_until,
            },
        );
        Ok(self.records.get(&key).expect("inserted record"))
    }
    /// Matrix adapters correlate an authenticated m.call answer/membership event to this exact scope.
    /// Relay cancellation uses observe instead, with its own strictly increasing epoch.
    pub fn transition(&mut self, call_id: &str, next: RingPhase) -> Result<(), MobileFfiError> {
        let r = self
            .records
            .get_mut(call_id)
            .ok_or(MobileFfiError::InvalidInput)?;
        let valid = matches!(
            (r.phase, next),
            (RingPhase::Ringing, RingPhase::Connecting)
                | (RingPhase::Connecting, RingPhase::Connected)
        ) || (!r.phase.terminal()
            && matches!(
                next,
                RingPhase::AnsweredElsewhere
                    | RingPhase::Declined
                    | RingPhase::Ended
                    | RingPhase::Revoked
            ));
        if !valid {
            return Err(MobileFfiError::Replay);
        }
        r.phase = next;
        r.missed = false;
        Ok(())
    }
    pub fn tick(&mut self, now: u64) {
        self.clock = self.clock.max(now);
        for r in self.records.values_mut() {
            if matches!(r.phase, RingPhase::Ringing | RingPhase::Connecting)
                && r.wake.expires_at <= self.clock
            {
                r.missed = r.phase == RingPhase::Ringing;
                r.phase = RingPhase::Expired;
            }
        }
        self.records
            .retain(|_, r| !r.phase.terminal() || r.retain_until > self.clock);
    }
    /// Authority loss discards every transient identifier, including replay history.
    pub fn revoke(&mut self) {
        self.records.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wake(state: RingPhase, epoch: u64) -> CallWake {
        CallWake {
            call_id: OrganisationId::parse("11111111-1111-4111-8111-111111111111").unwrap(),
            organisation_id: OrganisationId::parse("22222222-2222-4222-8222-222222222222").unwrap(),
            channel_id: OrganisationId::parse("33333333-3333-4333-8333-333333333333").unwrap(),
            epoch,
            state,
            expires_at: 130,
        }
    }
    #[test]
    fn shared_wire_vectors_and_packet_binding() {
        for line in include_str!("../vectors/mobile-call-wake-v1.txt")
            .lines()
            .filter(|l| !l.starts_with('#'))
        {
            let mut parts = line.splitn(3, '|');
            let ok = parts.next().unwrap() == "1";
            let now: u64 = parts.next().unwrap().parse().unwrap();
            let raw = parts.next().unwrap();
            assert_eq!(
                crate::mobile_ffi::admit_call_wake(raw.as_bytes(), now).is_ok(),
                ok,
                "{line}"
            );
            let hex = crate::encode_hex(raw.as_bytes());
            let req =
                format!("{{\"op\":\"call_wake_admit\",\"now\":{now},\"payload_hex\":\"{hex}\"}}");
            let (status, _) = crate::mobile_ffi::invoke_json(req.as_bytes());
            assert_eq!(status == 0, ok, "{line}");
        }
    }
    #[test]
    fn cancellation_capacity_never_evicts_live_tombstones() {
        let mut w = wake(RingPhase::Ended, 1);
        let mut m = CallRingMachine::new(w.organisation_id.clone());
        for i in 1..=MAX_CALL_RECORDS {
            w.call_id =
                OrganisationId::parse(&format!("11111111-1111-4111-8111-{i:012x}")).unwrap();
            m.observe(w.clone(), 100).unwrap();
        }
        w.call_id = OrganisationId::parse("11111111-1111-4111-8111-ffffffffffff").unwrap();
        assert_eq!(m.observe(w, 100), Err(MobileFfiError::Capacity));
        assert_eq!(m.records.len(), MAX_CALL_RECORDS);
    }
    #[test]
    fn cancel_before_ring_and_replay_never_ring_or_badge() {
        let w = wake(RingPhase::AnsweredElsewhere, 2);
        let mut m = CallRingMachine::new(w.organisation_id.clone());
        m.observe(w.clone(), 100).unwrap();
        assert_eq!(
            m.observe(wake(RingPhase::Ringing, 1), 101),
            Err(MobileFfiError::Replay)
        );
        assert!(!m.record(w.call_id.as_str()).unwrap().missed);
    }
    #[test]
    fn delayed_answer_cancellation_clears_expired_missed_state() {
        let w = wake(RingPhase::Ringing, 1);
        let mut m = CallRingMachine::new(w.organisation_id.clone());
        m.observe(w.clone(), 100).unwrap();
        m.tick(130);
        assert!(m.record(w.call_id.as_str()).unwrap().missed);
        let mut cancel = wake(RingPhase::AnsweredElsewhere, 2);
        cancel.expires_at = 150;
        m.observe(cancel, 131).unwrap();
        assert_eq!(
            m.record(w.call_id.as_str()).unwrap().phase,
            RingPhase::AnsweredElsewhere
        );
        assert!(!m.record(w.call_id.as_str()).unwrap().missed);
    }
    #[test]
    fn connected_does_not_expire_and_authority_loss_wipes() {
        let w = wake(RingPhase::Ringing, 1);
        let mut m = CallRingMachine::new(w.organisation_id.clone());
        m.observe(w.clone(), 100).unwrap();
        m.transition(w.call_id.as_str(), RingPhase::Connecting)
            .unwrap();
        m.transition(w.call_id.as_str(), RingPhase::Connected)
            .unwrap();
        m.tick(140);
        assert_eq!(
            m.record(w.call_id.as_str()).unwrap().phase,
            RingPhase::Connected
        );
        m.transition(w.call_id.as_str(), RingPhase::AnsweredElsewhere)
            .unwrap();
        assert!(!m.record(w.call_id.as_str()).unwrap().missed);
        m.revoke();
        assert!(m.records.is_empty());
    }
    #[test]
    fn ttl_and_clock_rollback_fail_closed() {
        let w = wake(RingPhase::Ringing, 1);
        let mut m = CallRingMachine::new(w.organisation_id.clone());
        assert_eq!(w.validate(130), Err(MobileFfiError::StaleEpoch));
        assert_eq!(w.validate(69), Err(MobileFfiError::StaleEpoch));
        m.observe(w.clone(), 100).unwrap();
        assert_eq!(m.observe(w, 99), Err(MobileFfiError::StaleEpoch));
    }
}

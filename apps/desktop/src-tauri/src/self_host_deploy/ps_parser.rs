//! Bounded zero-serde parser and readiness evaluator for `docker compose ps --format json`.

use super::{CommunityCoreService, CommunityDeployError, CommunityDeployServiceStatus};
use crate::self_host_health::{SelfHostHealthError, ServiceReadiness};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct PsServiceRow {
    service: String,
    state: String,
    health: String,
}

pub(super) fn evaluate_core_services_from_ps(
    raw_json: &str,
    external_oidc_configured: bool,
) -> Result<Vec<CommunityDeployServiceStatus>, CommunityDeployError> {
    let rows =
        parse_ps_service_rows(raw_json).map_err(CommunityDeployError::ReadinessProbeFailed)?;
    let mut by_name: BTreeMap<String, Vec<&PsServiceRow>> = BTreeMap::new();
    for row in &rows {
        by_name
            .entry(row.service.to_ascii_lowercase())
            .or_default()
            .push(row);
    }

    let mut statuses = Vec::with_capacity(CommunityCoreService::ALL.len());
    for core_svc in CommunityCoreService::ALL {
        let candidates = by_name
            .get(core_svc.slug())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if candidates.is_empty() {
            if core_svc == CommunityCoreService::Keycloak && external_oidc_configured {
                statuses.push(CommunityDeployServiceStatus {
                    service: core_svc,
                    readiness: ServiceReadiness::Ready,
                    external_oidc: true,
                });
            } else {
                statuses.push(CommunityDeployServiceStatus {
                    service: core_svc,
                    readiness: ServiceReadiness::Missing,
                    external_oidc: false,
                });
            }
            continue;
        }

        let readiness = worst_row_readiness(candidates);
        statuses.push(CommunityDeployServiceStatus {
            service: core_svc,
            readiness,
            external_oidc: false,
        });
    }
    Ok(statuses)
}

fn worst_row_readiness(rows: &[&PsServiceRow]) -> ServiceReadiness {
    let mut chosen = ServiceReadiness::Ready;
    for row in rows {
        let current = classify_ps_row(row);
        if readiness_rank(current) > readiness_rank(chosen) {
            chosen = current;
        }
    }
    chosen
}

const fn readiness_rank(readiness: ServiceReadiness) -> u8 {
    match readiness {
        ServiceReadiness::Ready => 0,
        ServiceReadiness::Starting => 1,
        ServiceReadiness::Restarting => 2,
        ServiceReadiness::PolicyDegraded => 3,
        ServiceReadiness::Unhealthy => 4,
        ServiceReadiness::Stopped => 5,
        ServiceReadiness::Missing => 6,
    }
}

fn classify_ps_row(row: &PsServiceRow) -> ServiceReadiness {
    let state = row.state.trim().to_ascii_lowercase();
    let health = row.health.trim().to_ascii_lowercase();
    if state == "restarting" {
        return ServiceReadiness::Restarting;
    }
    if state == "created" {
        return ServiceReadiness::Starting;
    }
    if state != "running" {
        return ServiceReadiness::Stopped;
    }
    match health.as_str() {
        "" | "healthy" => ServiceReadiness::Ready,
        "starting" => ServiceReadiness::Starting,
        _ => ServiceReadiness::Unhealthy,
    }
}

fn parse_ps_service_rows(raw_json: &str) -> Result<Vec<PsServiceRow>, SelfHostHealthError> {
    if raw_json.len() > crate::self_host_health::MAX_COMPOSE_PS_JSON_BYTES {
        return Err(SelfHostHealthError::PayloadTooLarge);
    }
    let mut parser = MiniPsParser {
        raw: raw_json,
        offset: 0,
    };
    parser.whitespace();
    if parser.peek().is_none() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    if parser.peek() == Some(b'[') {
        parser.offset += 1;
        parser.whitespace();
        if parser.peek() == Some(b']') {
            parser.offset += 1;
            parser.whitespace();
            if parser.offset != parser.raw.len() {
                return Err(SelfHostHealthError::InvalidJson);
            }
            return Ok(rows);
        }
        loop {
            if rows.len() >= crate::self_host_health::MAX_COMPOSE_CONTAINERS {
                return Err(SelfHostHealthError::TooManyContainers);
            }
            rows.push(parser.parse_object()?);
            parser.whitespace();
            match parser.peek() {
                Some(b',') => {
                    parser.offset += 1;
                    parser.whitespace();
                }
                Some(b']') => {
                    parser.offset += 1;
                    break;
                }
                _ => return Err(SelfHostHealthError::InvalidJson),
            }
        }
        parser.whitespace();
        if parser.offset != parser.raw.len() {
            return Err(SelfHostHealthError::InvalidJson);
        }
    } else {
        while parser.peek().is_some() {
            if rows.len() >= crate::self_host_health::MAX_COMPOSE_CONTAINERS {
                return Err(SelfHostHealthError::TooManyContainers);
            }
            rows.push(parser.parse_object()?);
            parser.whitespace();
        }
    }
    Ok(rows)
}

struct MiniPsParser<'a> {
    raw: &'a str,
    offset: usize,
}

impl MiniPsParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.offset).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\r' | b'\n' | b'\t')) {
            self.offset += 1;
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), SelfHostHealthError> {
        if self.peek() != Some(expected) {
            return Err(SelfHostHealthError::InvalidJson);
        }
        self.offset += 1;
        Ok(())
    }

    fn parse_object(&mut self) -> Result<PsServiceRow, SelfHostHealthError> {
        self.expect(b'{')?;
        self.whitespace();
        let mut row = PsServiceRow::default();
        let mut keys = BTreeSet::new();
        if self.peek() == Some(b'}') {
            return Err(SelfHostHealthError::InvalidJson);
        }
        loop {
            if keys.len() >= 48 {
                return Err(SelfHostHealthError::InvalidJson);
            }
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(SelfHostHealthError::InvalidJson);
            }
            self.whitespace();
            self.expect(b':')?;
            self.whitespace();
            match key.as_str() {
                "Service" => row.service = self.parse_string()?,
                "State" => row.state = self.parse_string()?,
                "Health" => {
                    if self.peek() == Some(b'"') {
                        row.health = self.parse_string()?;
                    } else {
                        self.skip_value(0)?;
                    }
                }
                _ => self.skip_value(0)?,
            }
            self.whitespace();
            match self.peek() {
                Some(b',') => {
                    self.offset += 1;
                    self.whitespace();
                }
                Some(b'}') => {
                    self.offset += 1;
                    break;
                }
                _ => return Err(SelfHostHealthError::InvalidJson),
            }
        }
        if row.service.is_empty() || row.state.is_empty() {
            return Err(SelfHostHealthError::InvalidJson);
        }
        Ok(row)
    }

    fn skip_value(&mut self, depth: u8) -> Result<(), SelfHostHealthError> {
        if depth > 4 {
            return Err(SelfHostHealthError::InvalidJson);
        }
        match self.peek() {
            Some(b'"') => {
                let _ = self.parse_string()?;
                Ok(())
            }
            Some(b't') if self.raw[self.offset..].starts_with("true") => {
                self.offset += 4;
                Ok(())
            }
            Some(b'f') if self.raw[self.offset..].starts_with("false") => {
                self.offset += 5;
                Ok(())
            }
            Some(b'n') if self.raw[self.offset..].starts_with("null") => {
                self.offset += 4;
                Ok(())
            }
            Some(b'-' | b'0'..=b'9') => {
                if self.peek() == Some(b'-') {
                    self.offset += 1;
                }
                while matches!(
                    self.peek(),
                    Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                ) {
                    self.offset += 1;
                }
                Ok(())
            }
            Some(b'[') => {
                self.offset += 1;
                self.whitespace();
                if self.peek() == Some(b']') {
                    self.offset += 1;
                    return Ok(());
                }
                let mut count = 0usize;
                loop {
                    count += 1;
                    if count > 32 {
                        return Err(SelfHostHealthError::InvalidJson);
                    }
                    self.skip_value(depth + 1)?;
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => {
                            self.offset += 1;
                            self.whitespace();
                        }
                        Some(b']') => {
                            self.offset += 1;
                            return Ok(());
                        }
                        _ => return Err(SelfHostHealthError::InvalidJson),
                    }
                }
            }
            Some(b'{') => {
                self.offset += 1;
                self.whitespace();
                if self.peek() == Some(b'}') {
                    self.offset += 1;
                    return Ok(());
                }
                let mut count = 0usize;
                loop {
                    count += 1;
                    if count > 32 {
                        return Err(SelfHostHealthError::InvalidJson);
                    }
                    let _ = self.parse_string()?;
                    self.whitespace();
                    self.expect(b':')?;
                    self.whitespace();
                    self.skip_value(depth + 1)?;
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => {
                            self.offset += 1;
                            self.whitespace();
                        }
                        Some(b'}') => {
                            self.offset += 1;
                            return Ok(());
                        }
                        _ => return Err(SelfHostHealthError::InvalidJson),
                    }
                }
            }
            _ => Err(SelfHostHealthError::InvalidJson),
        }
    }

    fn hex_quad(&mut self) -> Result<u32, SelfHostHealthError> {
        let mut value = 0u32;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(b'0'..=b'9') => u32::from(self.peek().unwrap() - b'0'),
                Some(b'a'..=b'f') => u32::from(self.peek().unwrap() - b'a' + 10),
                Some(b'A'..=b'F') => u32::from(self.peek().unwrap() - b'A' + 10),
                _ => return Err(SelfHostHealthError::InvalidJson),
            };
            self.offset += 1;
            value = (value << 4) | digit;
        }
        Ok(value)
    }

    fn parse_string(&mut self) -> Result<String, SelfHostHealthError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let next = self.raw[self.offset..]
                .chars()
                .next()
                .ok_or(SelfHostHealthError::InvalidJson)?;
            self.offset += next.len_utf8();
            match next {
                '"' => return Ok(out),
                '\\' => {
                    let esc = self.peek().ok_or(SelfHostHealthError::InvalidJson)?;
                    self.offset += 1;
                    out.push(match esc {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut scalar = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&scalar) {
                                self.expect(b'\\')?;
                                self.expect(b'u')?;
                                let low = self.hex_quad()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err(SelfHostHealthError::InvalidJson);
                                }
                                scalar = 0x10000 + ((scalar - 0xd800) << 10) + (low - 0xdc00);
                            }
                            char::from_u32(scalar).ok_or(SelfHostHealthError::InvalidJson)?
                        }
                        _ => return Err(SelfHostHealthError::InvalidJson),
                    });
                }
                c if c <= '\u{1f}' => return Err(SelfHostHealthError::InvalidJson),
                other => out.push(other),
            }
        }
    }
}

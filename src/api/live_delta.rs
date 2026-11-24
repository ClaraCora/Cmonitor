//! One cache per audience. Deltas are derived exclusively from the same
//! filtered node list used for a full response. Each socket holds only its
//! last sequence number, so slow readers cannot pin old snapshots.
use axum::body::Bytes;
use axum::extract::ws::{Message, Utf8Bytes};
use flate2::{write::GzEncoder, Compression};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::cell::OnceCell;
use std::collections::HashMap;
use std::io::Write;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Audience {
    Public,
    Admin,
    SignedStatus,
}

#[derive(Default)]
pub(crate) struct Snapshot {
    pub(super) stamp: i64,
    seq: u64,
    nodes: Vec<Value>,
    legacy: Option<Encoded>,
    baseline: Option<Encoded>,
    delta: Option<Encoded>,
    last_delta_read: Option<i64>,
    delta_has_only_public_fields: bool,
}

#[derive(Clone, Copy)]
pub(super) enum Format {
    Legacy,
    Delta { after: Option<u64>, gzip: bool },
}

#[derive(Serialize)]
struct Full<'a> {
    admin: bool,
    nodes: &'a [Value],
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
}

impl Snapshot {
    pub(super) fn read(
        &mut self,
        audience: Audience,
        now: i64,
        format: Format,
        fetch: impl FnOnce() -> Vec<Value>,
    ) -> (u64, Option<Message>) {
        let admin = audience == Audience::Admin;
        if matches!(format, Format::Delta { .. }) {
            self.last_delta_read = Some(now);
        }
        if self.seq == 0 || self.stamp == 0 || !(0..super::SNAPSHOT_TTL_MS).contains(&(now - self.stamp)) {
            let nodes = fetch();
            let next = self.seq + 1;
            // Legacy-only traffic pays no diff cost. Keep the delta warm across
            // a few ticks if an HTTP/legacy reader refreshes the cache first.
            let active = self.last_delta_read.is_some_and(|last| (0..10_000).contains(&(now - last)));
            self.delta = if active && self.seq != 0 {
                let at = nodes.first().and_then(|n| n["valuation_at"].as_i64()).unwrap_or(now / 1000);
                let delta = changes(&self.nodes, &nodes, self.seq, next, at);
                self.delta_has_only_public_fields = match audience {
                    Audience::Public => true,
                    Audience::Admin => false,
                    Audience::SignedStatus => delta.public_status_metrics_only(),
                };
                Some(encode(&delta))
            } else {
                None
            };
            self.nodes = nodes;
            self.seq = next;
            self.stamp = now;
            self.legacy = None;
            self.baseline = None;
        }

        let gzip = matches!(format, Format::Delta { gzip: true, .. });
        let bytes = match format {
            Format::Legacy => {
                self.legacy.get_or_insert_with(|| encode(&Full { admin, nodes: &self.nodes, seq: None }))
            }
            Format::Delta { after, .. } => {
                if after == Some(self.seq) {
                    return (self.seq, None);
                }
                if after == Some(self.seq - 1) {
                    if let Some(delta) = &self.delta {
                        return (self.seq, Some(delta.message(gzip && self.delta_has_only_public_fields)));
                    }
                }
                self.baseline
                    .get_or_insert_with(|| encode(&Full { admin, nodes: &self.nodes, seq: Some(self.seq) }))
            }
        };
        (self.seq, Some(bytes.message(gzip && audience == Audience::Public)))
    }
}

struct Encoded {
    text: Utf8Bytes,
    gzip: OnceCell<Option<Bytes>>,
}

impl Encoded {
    fn message(&self, gzip: bool) -> Message {
        if gzip && self.text.len() >= 1024 {
            let compressed = self.gzip.get_or_init(|| {
                let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
                encoder.write_all(self.text.as_bytes()).ok()?;
                let bytes = encoder.finish().ok()?;
                (bytes.len() < self.text.len()).then(|| Bytes::from(bytes))
            });
            if let Some(bytes) = compressed {
                return Message::Binary(bytes.clone());
            }
        }
        Message::Text(self.text.clone())
    }
}

fn encode(value: &impl Serialize) -> Encoded {
    Encoded {
        text: Utf8Bytes::from(serde_json::to_string(value).expect("serializable node snapshot")),
        gzip: OnceCell::new(),
    }
}

type Fields = Map<String, Value>;

/// Changed shallow fields. A removed key cannot be expressed by setting it to
/// null, which is a meaningful value for e.g. expiry dates or failed probes.
fn fields(before: &Value, after: &Value, skip: &[&str]) -> Option<Fields> {
    let (old, new) = (before.as_object()?, after.as_object()?);
    if old.keys().any(|k| !new.contains_key(k)) {
        return None;
    }
    Some(
        new.iter()
            .filter(|(k, v)| !skip.contains(&k.as_str()) && old.get(*k) != Some(*v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

fn patch(before: &Value, after: &Value) -> Option<Fields> {
    let mut changes = Fields::new();
    let top = fields(before, after, &["id", "valuation_at", "metrics", "pings"])?;
    if !top.is_empty() {
        changes.insert("set".into(), Value::Object(top));
    }
    if before["metrics"] != after["metrics"] {
        changes.insert("metrics".into(), Value::Object(fields(&before["metrics"], &after["metrics"], &[])?));
    }
    if before["pings"] != after["pings"] {
        let old = before["pings"].as_array()?;
        let new = after["pings"].as_array()?;
        if old.len() != new.len() {
            return None;
        }
        let mut pings = Vec::new();
        for (old, new) in old.iter().zip(new) {
            let id = new["id"].as_i64()?;
            if old["id"].as_i64() != Some(id) {
                return None;
            }
            let changed = fields(old, new, &["id"])?;
            if !changed.is_empty() {
                pings.push((id, changed));
            }
        }
        changes.insert("pings".into(), json!(pings));
    }
    Some(changes)
}

#[derive(Serialize)]
struct Delta<'a> {
    base: u64,
    seq: u64,
    at: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    put: Vec<&'a Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    drop: Vec<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    patch: Vec<Fields>,
}

impl Delta<'_> {
    // Only compress routine updates for signed-in status pages. Baselines,
    // replacement rows and edits to operator-only links or notes stay text.
    // The status view already filters metrics and probe results for public use.
    fn public_status_metrics_only(&self) -> bool {
        self.put.is_empty()
            && self.patch.iter().all(|patch| {
                patch.get("set").is_none_or(|set| {
                    set.as_object().is_some_and(|fields| {
                        fields.keys().all(|field| {
                            matches!(
                                field.as_str(),
                                "online"
                                    | "last_seen"
                                    | "day_rx"
                                    | "day_tx"
                                    | "month_rx"
                                    | "month_tx"
                                    | "total_rx"
                                    | "total_tx"
                            )
                        })
                    })
                })
            })
    }
}

fn changes<'a>(old: &[Value], new: &'a [Value], base: u64, seq: u64, at: i64) -> Delta<'a> {
    let id = |row: &Value| row["id"].as_i64().expect("node primary key");
    let mut previous: HashMap<i64, &Value> = old.iter().map(|n| (id(n), n)).collect();
    let order = (!old.iter().map(id).eq(new.iter().map(id))).then(|| new.iter().map(id).collect());
    let mut result = Delta { base, seq, at, put: vec![], drop: vec![], order, patch: vec![] };
    for node in new {
        let key = id(node);
        match previous.remove(&key).and_then(|old_node| patch(old_node, node)) {
            None => result.put.push(node),
            Some(mut patch) if !patch.is_empty() => {
                patch.insert("id".into(), key.into());
                result.patch.push(patch);
            }
            Some(_) => {}
        }
    }
    result.drop = previous.into_keys().collect();
    result.drop.sort_unstable();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn decoded(frame: Message) -> Value {
        match frame {
            Message::Binary(bytes) => {
                let mut text = String::new();
                flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut text).unwrap();
                serde_json::from_str(&text).unwrap()
            }
            Message::Text(text) => serde_json::from_str(&text).unwrap(),
            _ => panic!("expected data"),
        }
    }

    fn row(id: i64, t: i64) -> Value {
        json!({"id":id,"valuation_at":t,"name":format!("node{id}"),"expires_at":"2027-01-01",
            "metrics":{"cpu":47.3,"net_tx":41},"pings":[
                {"id":4,"latency":2,"samples":[2,1,2]},
                {"id":5,"latency":8,"samples":[4,6,8]}]})
    }

    #[test]
    fn a_delta_carries_only_the_changed_node_fields_and_probe() {
        let old = vec![row(1, 10), row(2, 10), row(3, 10)];
        let mut new = vec![row(3, 12), row(4, 12), row(1, 12)];
        new[2]["expires_at"] = Value::Null;
        new[2]["metrics"]["net_tx"] = json!(97);
        new[2]["pings"][0]["samples"] = json!([1, 2, 3]);
        new[2]["pings"][0]["latency"] = json!(3);
        let frame = changes(&old, &new, 70, 71, 12);
        assert_eq!(
            serde_json::to_value(frame).unwrap(),
            json!({
                "base":70,"seq":71,"at":12,"order":[3,4,1],"drop":[2],"put":[new[1]],
                "patch":[{"id":1,"set":{"expires_at":null},"metrics":{"net_tx":97},
                "pings":[[4,{"latency":3,"samples":[1,2,3]}]]}]
            })
        );

        let mut new = old.clone();
        new[0]["metrics"].as_object_mut().unwrap().remove("net_tx");
        new[1]["metrics"] = Value::Null;
        new[2]["pings"].as_array_mut().unwrap().swap(0, 1);
        let frame = changes(&old, &new, 70, 71, 12);
        assert!(frame.patch.is_empty());
        assert_eq!(frame.put.into_iter().collect::<Vec<_>>(), new.iter().collect::<Vec<_>>());
    }

    #[test]
    fn spectators_share_frames_and_a_missed_revision_gets_a_new_baseline() {
        let mut slot = Snapshot::default();
        let after = |after| Format::Delta { after, gzip: false };
        let first = vec![row(1, 10)];
        let (_, frame) = slot.read(Audience::Public, 10_000, after(None), || first.clone());
        assert_eq!(decoded(frame.unwrap()), json!({"admin":false,"seq":1,"nodes":first}));
        let (_, legacy) = slot.read(Audience::Public, 10_001, Format::Legacy, || panic!("cached"));
        assert_eq!(decoded(legacy.unwrap()), json!({"admin":false,"nodes":first}));
        let (_, frame) = slot.read(Audience::Public, 12_000, after(Some(1)), || vec![row(1, 12)]);
        let delta = frame.unwrap();
        let Message::Text(first) = &delta else { panic!("text requested") };
        let (_, cached) = slot.read(Audience::Public, 12_001, after(Some(1)), || panic!("cached"));
        let Some(Message::Text(copy)) = cached else { panic!("expected a shared delta") };
        assert_eq!(first.as_ptr(), copy.as_ptr(), "encoded once across viewers");
        assert_eq!(decoded(delta), json!({"base":1,"seq":2,"at":12}));
        assert!(slot.read(Audience::Public, 12_002, after(Some(2)), || panic!("cached")).1.is_none());
        let latest = vec![row(4, 14)];
        let (_, full) = slot.read(Audience::Public, 14_000, after(Some(1)), || latest.clone());
        assert_eq!(decoded(full.unwrap()), json!({"admin":false,"seq":3,"nodes":latest}));
    }

    #[test]
    fn signed_status_compresses_metrics_but_never_a_baseline_or_note_edit() {
        let mut slot = Snapshot::default();
        let mut nodes: Vec<_> = (1..=40).map(|id| row(id, 10)).collect();
        for n in &mut nodes {
            n["remark"] = json!("operator-only test note");
        }
        let mut read = |at, after, rows: &[Value]| {
            slot.read(Audience::SignedStatus, at, Format::Delta { after, gzip: true }, || rows.to_vec())
                .1
                .unwrap()
        };
        assert!(matches!(read(10_000, None, &nodes), Message::Text(_)));
        for n in &mut nodes {
            n["metrics"]["net_tx"] = json!(101);
        }
        let metrics = read(12_000, Some(1), &nodes);
        assert!(matches!(metrics, Message::Binary(_)));
        assert_eq!(decoded(metrics)["patch"].as_array().unwrap().len(), 40);
        nodes[0]["remark"] = json!("changed private note".repeat(100));
        assert!(matches!(read(14_000, Some(2), &nodes), Message::Text(_)));
        nodes[1]["website"] = json!("https://example.invalid/".repeat(100));
        assert!(matches!(read(16_000, Some(3), &nodes), Message::Text(_)));
        nodes.push(nodes[0].clone());
        nodes.last_mut().unwrap()["id"] = json!(41);
        assert!(matches!(read(18_000, Some(4), &nodes), Message::Text(_)));
    }

    #[test]
    fn gzip_is_opt_in_shared_and_public_only() {
        let mut row = row(7, 20);
        row["tags"] = json!("large fixture ".repeat(192));
        let mut public = Snapshot::default();
        let format = Format::Delta { after: None, gzip: true };
        let (_, frame) = public.read(Audience::Public, 20_000, format, || vec![row.clone()]);
        let Some(Message::Binary(bytes)) = frame else { panic!("large public frame should compress") };
        let public_data = decoded(Message::Binary(bytes.clone()));
        let (_, second) = public.read(Audience::Public, 20_000, format, || panic!("cached"));
        let Some(Message::Binary(copy)) = second else { panic!("compressed frame expected") };
        assert_eq!(bytes.as_ptr(), copy.as_ptr());
        let (_, plain) =
            public.read(Audience::Public, 20_000, Format::Delta { after: None, gzip: false }, || panic!());
        let plain = plain.unwrap();
        assert!(matches!(plain, Message::Text(_)));
        assert_eq!(public_data, decoded(plain));

        row["token"] = json!("private fixture");
        let mut admin = Snapshot::default();
        let (_, frame) = admin.read(Audience::Admin, 20_000, format, || vec![row]);
        let Some(Message::Text(frame)) = frame else { panic!("an admin frame must remain plain text") };
        assert!(frame.contains("private fixture"));
        assert!(!public_data.to_string().contains("private fixture"));
    }
}

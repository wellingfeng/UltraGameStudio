use std::collections::HashMap;

use serde_json::{json, Map, Value};

const TOKEN_FIELDS: [&str; 4] = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
];

/// Read the token counters from a Claude assistant or result event.
pub(crate) fn claude_message_usage(event: &Value) -> Option<Value> {
    let usage = event
        .get("usage")
        .or_else(|| event.pointer("/message/usage"))?;
    if !usage.is_object() {
        return None;
    }
    let has_tokens = TOKEN_FIELDS.iter().any(|key| {
        usage
            .get(*key)
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0)
    });
    if !has_tokens {
        return None;
    }
    let mut usage = usage.clone();
    if let Some(cost) = event.get("total_cost_usd").and_then(Value::as_f64) {
        if cost.is_finite() && cost >= 0.0 {
            if let Some(fields) = usage.as_object_mut() {
                fields.insert("total_cost_usd".to_string(), json!(cost));
            }
        }
    }
    Some(usage)
}

/// Track distinct model messages, including partial updates and repeated
/// assistant content blocks. A terminal result replaces the running totals.
#[derive(Default)]
pub(crate) struct ClaudeUsageTracker {
    messages: HashMap<String, Map<String, Value>>,
    current: HashMap<String, String>,
    next_id: u64,
}

impl ClaudeUsageTracker {
    pub(crate) fn observe(&mut self, event: &Value) -> Option<Value> {
        let kind = event.get("type").and_then(Value::as_str)?;
        if kind == "result" {
            return claude_message_usage(event);
        }

        let scope = event
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (message, usage, starts_message) = match kind {
            "stream_event" => {
                let inner = event.get("event")?;
                match inner.get("type").and_then(Value::as_str)? {
                    "message_start" => {
                        (inner.get("message"), inner.pointer("/message/usage"), true)
                    }
                    "message_delta" => (None, inner.get("usage"), false),
                    _ => return None,
                }
            }
            "assistant" => (event.get("message"), event.pointer("/message/usage"), false),
            _ => return None,
        };

        let explicit_id = message.and_then(|v| v.get("id")).and_then(Value::as_str);
        let key = if let Some(id) = explicit_id {
            format!("{scope}\0{id}")
        } else if !starts_message {
            self.current.get(scope).cloned().unwrap_or_else(|| {
                self.next_id += 1;
                format!("{scope}\0anonymous:{}", self.next_id)
            })
        } else {
            self.next_id += 1;
            format!("{scope}\0anonymous:{}", self.next_id)
        };
        self.current.insert(scope.to_string(), key.clone());
        let usage = usage?.as_object()?;
        let snapshot = self.messages.entry(key).or_default();
        for field in TOKEN_FIELDS {
            if let Some(count) = usage.get(field).and_then(Value::as_u64) {
                snapshot.insert(field.to_string(), json!(count));
            }
        }

        let mut total = Map::new();
        for field in TOKEN_FIELDS {
            let values = self
                .messages
                .values()
                .filter_map(|usage| usage.get(field).and_then(Value::as_u64));
            let (sum, present) = values.fold((0u64, false), |(sum, _), value| {
                (sum.saturating_add(value), true)
            });
            if present {
                total.insert(field.to_string(), json!(sum));
            }
        }
        if total
            .values()
            .any(|value| value.as_u64().is_some_and(|n| n > 0))
        {
            Some(Value::Object(total))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_and_assistant_events_update_live_totals_without_double_counting() {
        let mut tracker = ClaudeUsageTracker::default();
        let first_start = json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"one","usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":5,"output_tokens":1}}}});
        assert_eq!(
            tracker.observe(&first_start).unwrap(),
            json!({"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":5,"output_tokens":1})
        );
        let first_delta = json!({"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":20}}});
        assert_eq!(tracker.observe(&first_delta).unwrap()["output_tokens"], 20);
        let first_assistant = json!({"type":"assistant","message":{"id":"one","usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":5,"output_tokens":20}}});
        tracker.observe(&first_assistant);
        assert_eq!(
            tracker.observe(&first_assistant).unwrap()["output_tokens"],
            20
        );
        let second = json!({"type":"assistant","message":{"id":"two","usage":{"input_tokens":3,"cache_read_input_tokens":90,"cache_creation_input_tokens":2,"output_tokens":7}}});
        assert_eq!(
            tracker.observe(&second).unwrap(),
            json!({"input_tokens":13,"cache_read_input_tokens":170,"cache_creation_input_tokens":7,"output_tokens":27})
        );
        let result = json!({"type":"result","total_cost_usd":0.045,"usage":{"input_tokens":14,"cache_read_input_tokens":175,"cache_creation_input_tokens":8,"output_tokens":29}});
        assert_eq!(
            tracker.observe(&result).unwrap(),
            json!({"input_tokens":14,"cache_read_input_tokens":175,"cache_creation_input_tokens":8,"output_tokens":29,"total_cost_usd":0.045})
        );
    }

    #[test]
    fn ignores_empty_usage_and_keeps_partial_values_across_separate_scopes() {
        let mut tracker = ClaudeUsageTracker::default();
        assert!(tracker.observe(&json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"empty","usage":{"input_tokens":0,"output_tokens":0}}}})).is_none());
        tracker.observe(&json!({"type":"stream_event","parent_tool_use_id":"child","event":{"type":"message_start","message":{"id":"child-message","usage":{"input_tokens":5,"output_tokens":1}}}}));
        tracker.observe(&json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"main-message","usage":{"input_tokens":10,"output_tokens":1}}}}));
        let child_delta = json!({"type":"stream_event","parent_tool_use_id":"child","event":{"type":"message_delta","usage":{"output_tokens":7}}});
        assert_eq!(
            tracker.observe(&child_delta).unwrap(),
            json!({"input_tokens":15,"output_tokens":8})
        );
    }
}

// Generated from engine/wire/ds-transport-v1.json; run node eng/generate-ds-close-codes.mjs.
export const DS_CLOSE_CODES = Object.freeze({
  "shutdown": 1000,
  "normal_logout": 1000,
  "session_closed": 1000,
  "superseded": 1000,
  "bad_envelope": 1008,
  "protocol_violation": 1008,
  "connection_timeout": 1008,
  "input_rate_exceeded": 1008,
  "queue_full": 1009,
  "send_buffer_overflow": 1009,
  "internal_error": 1011,
  "not_serving": 1013,
  "admission_refused": 1008,
  "admission_capacity": 1013
});
export const DS_CLOSE_CLIENT_ACTIONS = Object.freeze({
  "shutdown": "normal",
  "normal_logout": "normal",
  "session_closed": "normal",
  "superseded": "superseded",
  "bad_envelope": "policy_rejected",
  "protocol_violation": "policy_rejected",
  "connection_timeout": "reconnect",
  "input_rate_exceeded": "policy_rejected",
  "queue_full": "reconnect",
  "send_buffer_overflow": "reconnect",
  "internal_error": "fault",
  "not_serving": "retry_later",
  "admission_refused": "admission_failed",
  "admission_capacity": "retry_later"
});

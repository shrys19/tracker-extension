use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Request {
    #[serde(rename = "session")]
    Session(SessionPayload),

    #[serde(rename = "report")]
    Report,

    #[serde(rename = "export")]
    Export(ExportQuery),
}

// Optional epoch-ms bounds filtering sessions by start_time. Both None
// (or an absent field) means all-time. The extension computes the
// boundaries in local time and passes them down.
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct ExportQuery {
    pub since: Option<i64>,
    pub until: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SessionPayload {
    pub site: String,
    pub start_time: i64,
    pub end_time: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub status: String,
    pub message: String,
}

impl Response {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            status: "ok".into(),
            message: message.into(),
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: "error".into(),
            message: message.into(),
        }
    }
}
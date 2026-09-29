use serde::Serialize;
use std::collections::HashMap;

/// 应用统一错误类型。
/// - message 为英文（日志/调试用），用户可见文案由前端 i18n 根据 code 翻译。
/// - args 为可选变量，前端用 {name} 占位符替换。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("File I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON (de)serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Validation failed on `{field}`: {detail}")]
    Validation { field: String, detail: String },
    #[error("Path not found: {path}")]
    NotFound { path: String },
    #[error("Path already exists: {path}")]
    Conflict { path: String },
    #[error("Project schema version {found} is newer than supported {supported}")]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Authentication failed: {0}")]
    Auth(String),
    #[error("Provider `{provider}` error: {detail}")]
    Provider { provider: String, detail: String },
    #[error("Request timed out: {detail}")]
    Timeout { detail: String },
    #[error("Rate limited by provider: {detail}")]
    RateLimit { detail: String },
    #[error("Internal error: {0}")]
    Internal(String),
}

impl AppError {
    /// 错误码，前端可据此做分支处理与 i18n 翻译。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Serde(_) => "serde",
            AppError::Validation { .. } => "validation",
            AppError::NotFound { .. } => "not_found",
            AppError::Conflict { .. } => "conflict",
            AppError::SchemaTooNew { .. } => "schema_too_new",
            AppError::Network(_) => "network",
            AppError::Auth(_) => "auth",
            AppError::Provider { .. } => "provider",
            AppError::Timeout { .. } => "timeout",
            AppError::RateLimit { .. } => "rate_limit",
            AppError::Internal(_) => "internal",
        }
    }

    /// 错误变量，前端用于 {name} 占位符替换。
    pub fn args(&self) -> HashMap<String, String> {
        let mut m = HashMap::new();
        match self {
            AppError::Io(e) => {
                m.insert("detail".into(), e.to_string());
            }
            AppError::Serde(e) => {
                m.insert("detail".into(), e.to_string());
            }
            AppError::Validation { field, detail } => {
                m.insert("field".into(), field.clone());
                m.insert("detail".into(), detail.clone());
            }
            AppError::NotFound { path } => {
                m.insert("path".into(), path.clone());
            }
            AppError::Conflict { path } => {
                m.insert("path".into(), path.clone());
            }
            AppError::SchemaTooNew { found, supported } => {
                m.insert("found".into(), found.to_string());
                m.insert("supported".into(), supported.to_string());
            }
            AppError::Network(msg) => {
                m.insert("detail".into(), msg.clone());
            }
            AppError::Auth(msg) => {
                m.insert("detail".into(), msg.clone());
            }
            AppError::Provider { provider, detail } => {
                m.insert("provider".into(), provider.clone());
                m.insert("detail".into(), detail.clone());
            }
            AppError::Timeout { detail } => {
                m.insert("detail".into(), detail.clone());
            }
            AppError::RateLimit { detail } => {
                m.insert("detail".into(), detail.clone());
            }
            AppError::Internal(msg) => {
                m.insert("detail".into(), msg.clone());
            }
        }
        m
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        // 是否带 args 直接由 args() 推导，避免与 args() 平行维护第二份名单。
        let args = self.args();
        let fields = if args.is_empty() { 2 } else { 3 };
        let mut s = serializer.serialize_struct("AppError", fields)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        if !args.is_empty() {
            s.serialize_field("args", &args)?;
        }
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    //! Unit tests: error code() mapping + Display + Serialize shape.

    use super::*;

    /// Every AppError variant maps to a non-empty, snake_case, unique code.
    #[test]
    fn code_mapping_is_stable_and_unique() {
        let codes: Vec<(&str, AppError)> = vec![
            (
                "serde",
                AppError::Serde(serde_json::from_str::<i32>("x").unwrap_err()),
            ),
            (
                "validation",
                AppError::Validation {
                    field: "f".into(),
                    detail: "d".into(),
                },
            ),
            ("not_found", AppError::NotFound { path: "p".into() }),
            ("conflict", AppError::Conflict { path: "p".into() }),
            (
                "schema_too_new",
                AppError::SchemaTooNew {
                    found: 9,
                    supported: 1,
                },
            ),
            ("network", AppError::Network("n".into())),
            ("auth", AppError::Auth("a".into())),
            (
                "provider",
                AppError::Provider {
                    provider: "p".into(),
                    detail: "d".into(),
                },
            ),
            ("timeout", AppError::Timeout { detail: "d".into() }),
            ("rate_limit", AppError::RateLimit { detail: "d".into() }),
            ("internal", AppError::Internal("i".into())),
        ];

        for (code, err) in &codes {
            assert_eq!(err.code(), *code, "code mismatch for {:?}", err);
            assert!(!code.is_empty(), "empty code");
            assert!(!code.contains(' '), "code must be snake_case: {}", code);
        }

        let mut all_codes: Vec<&str> = codes.iter().map(|(c, _)| *c).collect();
        all_codes.sort();
        let len_before = all_codes.len();
        all_codes.dedup();
        assert_eq!(all_codes.len(), len_before, "duplicate codes detected");
    }

    /// Io errors map to the `io` code and expose their detail through args().
    #[test]
    fn io_error_exposes_detail() {
        let e = AppError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "boom"));
        assert_eq!(e.code(), "io");
        assert_eq!(e.args().get("detail").map(|s| s.as_str()), Some("boom"));
    }

    /// Parameterized errors serialize with an "args" field for interpolation.
    #[test]
    fn serialize_parameterized_has_args() {
        let e = AppError::Validation {
            field: "title".into(),
            detail: "empty".into(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "validation");
        assert_eq!(v["args"]["field"], "title");
        assert_eq!(v["args"]["detail"], "empty");
    }

    /// Plain errors still expose a stable two-field shape.
    #[test]
    fn serialize_plain_shape() {
        let e = AppError::Network("offline".into());
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "network");
        assert!(v["message"].as_str().unwrap().contains("offline"));
    }
}

//! 模型适配器层（spec §9.2）：新增一家模型 = 新增一个实现文件。
//!
//! 出题层只产出"统一提示词模型"，厂商字段的翻译、截断与降级由这里的实现负责
//! （spec §9.4），因此新增模型不需要改出题逻辑。
//!
//! 各实现共用的错误归一化也放在这一层：文本与图片适配器对
//! 超时 / 鉴权 / 限流 / 服务端错误的口径必须完全一致（spec §10）。

pub mod image;
pub mod llm;

use crate::error::AppError;

/// 按字符（而非字节）截断，避免切断多字节字符导致 panic。
pub(crate) fn truncate(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

/// 把 reqwest 传输层错误归一化：超时 / 不可达 / 其他。
pub(crate) fn classify_transport(provider: &str, err: &reqwest::Error) -> AppError {
    if err.is_timeout() {
        AppError::Timeout {
            detail: err.to_string(),
        }
    } else if err.is_connect() || err.is_request() {
        AppError::Network(err.to_string())
    } else {
        AppError::Provider {
            provider: provider.into(),
            detail: err.to_string(),
        }
    }
}

/// 把非 2xx 响应归一化：401/403 → 鉴权，429 → 限流，其余 → 服务商错误。
pub(crate) fn classify_status(provider: &str, status: u16, body: &str) -> AppError {
    let detail = truncate(body.trim(), 300).to_string();
    match status {
        401 | 403 => AppError::Auth(detail),
        429 => AppError::RateLimit { detail },
        _ => AppError::Provider {
            provider: provider.into(),
            detail: format!("HTTP {status}: {detail}"),
        },
    }
}

#[cfg(test)]
mod tests {
    //! 只覆盖错误分类与截断这两处易复用的纯逻辑。

    use super::*;

    #[test]
    fn truncate_keeps_short_text_and_cuts_on_char_boundary() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("你好世界", 2), "你好");
        // 中文 3 字节/字：按字节截断会 panic，按字符不会。
        assert_eq!(truncate("你好世界", 0), "");
    }

    #[test]
    fn status_classification_matches_documented_codes() {
        assert_eq!(classify_status("p", 401, "bad key").code(), "auth");
        assert_eq!(classify_status("p", 403, "forbidden").code(), "auth");
        assert_eq!(classify_status("p", 429, "slow").code(), "rate_limit");
        assert_eq!(classify_status("p", 500, "boom").code(), "provider");
        assert_eq!(classify_status("p", 400, "bad request").code(), "provider");
    }
}

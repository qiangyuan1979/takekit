//! 出题命令（spec §5.6、§9.4）：把统一提示词模型翻译成各家请求体。
//!
//! M6 只做**翻译**，不发网络请求：用户还没配 API Key 也能先看到"改成这个参数后，
//! 可灵那条会变成什么"。真正的生成调用是 M7，届时在本层之上再补 HTTP 实现。
//!
//! 命令层只做两件事：暴露可选 provider 清单、按名字建适配器；字段改名与降级提示
//! 全在 `adapters::video` 里。

use crate::adapters::video::{self, Translated, VideoRequest};
use crate::error::{AppError, AppResult};

/// 已支持的视频 provider 标识，供前端下拉与校验共用。
#[tauri::command]
pub fn list_video_providers() -> Vec<&'static str> {
    video::SUPPORTED.to_vec()
}

/// 按 provider 把统一请求翻译成该家请求体；`model` 为空时用该家默认版本。
///
/// 未知 provider 报 `validation`（`field = "provider"`），由前端提示"这家还没支持"。
#[tauri::command]
pub fn translate_video_request(
    provider: String,
    model: String,
    request: VideoRequest,
) -> AppResult<Translated> {
    let adapter = video::provider(&provider, &model).ok_or_else(|| AppError::Validation {
        field: "provider".into(),
        detail: format!("unsupported video provider: {provider}"),
    })?;
    Ok(adapter.translate(&request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{AspectRatio, VideoParams};

    fn sample_request() -> VideoRequest {
        VideoRequest {
            prompt: "短发女主推开玻璃门，中景，缓慢推近。".into(),
            params: VideoParams {
                duration_ms: 5_000,
                aspect_ratio: AspectRatio::Portrait,
                resolution: "1080x1920".into(),
                fps: 30,
                ..VideoParams::default()
            },
        }
    }

    #[test]
    fn supported_providers_are_listed_for_the_frontend() {
        let names = list_video_providers();
        assert!(names.contains(&"kling"));
        assert!(names.contains(&"jimeng"));
    }

    #[test]
    fn translate_reports_the_chosen_provider() {
        let out = translate_video_request("kling".into(), String::new(), sample_request()).unwrap();
        assert_eq!(out.provider, "kling");
        assert!(out.body.is_object());
    }

    #[test]
    fn unknown_provider_is_rejected() {
        let error =
            translate_video_request("mystery".into(), String::new(), sample_request()).unwrap_err();
        assert_eq!(error.code(), "validation");
        assert_eq!(
            error.args().get("field").map(String::as_str),
            Some("provider")
        );
    }
}

//! LLM 命令：前端只传消息，Key 由后端从密钥库取（spec §9.2，前端不接触明文）。
//!
//! 命令层只做三件事：取配置、建 provider、补默认生成参数；协议细节全在适配器里。

use crate::adapters::llm::{openai_compat, LlmChunk, LlmProvider, LlmRequest, LlmResponse};
use crate::commands::settings::{load_llm_config, LlmOptions};
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;

/// 非流式请求的整体超时；流式不设总超时，避免长回答被拦腰截断。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// 取配置 → 建 provider → 补齐生成参数。
fn prepare(
    app: &AppHandle,
    request: LlmRequest,
) -> AppResult<(openai_compat::OpenAiCompatProvider, LlmRequest)> {
    let (config, options) = load_llm_config(app)?;
    let provider = openai_compat::OpenAiCompatProvider::new(
        &config.base_url,
        &config.api_key,
        &config.model,
        REQUEST_TIMEOUT,
    )?;
    Ok((provider, with_defaults(request, &options)))
}

/// 用设置里的默认值补齐请求中未指定的生成参数。
fn with_defaults(mut request: LlmRequest, options: &LlmOptions) -> LlmRequest {
    if request.temperature.is_none() {
        request.temperature = Some(options.temperature);
    }
    if request.max_tokens.is_none() {
        request.max_tokens = Some(options.max_tokens);
    }
    request
}

/// 一次性拿到完整回答。
#[tauri::command]
pub async fn llm_complete(app: AppHandle, request: LlmRequest) -> AppResult<LlmResponse> {
    let (provider, request) = prepare(&app, request)?;
    provider.complete(&request).await
}

/// 流式回答：逐片段推给前端 `Channel`，直到 `done` 被送出。
#[tauri::command]
pub async fn llm_stream(
    app: AppHandle,
    request: LlmRequest,
    on_event: Channel<LlmChunk>,
) -> AppResult<()> {
    let (provider, request) = prepare(&app, request)?;
    let mut stream = provider.stream(&request).await?;

    while let Some(item) = stream.next().await {
        let chunk = item?;
        let done = chunk.done;
        on_event
            .send(chunk)
            .map_err(|e| AppError::Internal(format!("failed to deliver stream chunk: {e}")))?;
        if done {
            break;
        }
    }
    Ok(())
}

//! Tauri 命令层：前端唯一入口，所有参数校验与落盘都在这里收口。

pub mod project;
pub mod settings;

use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 应用数据目录（密钥、最近项目、全局模板库都落这里）。
pub(crate) fn app_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app data dir unavailable: {e}")))
}

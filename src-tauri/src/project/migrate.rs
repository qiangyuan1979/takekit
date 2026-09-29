//! `schemaVersion` 迁移框架（spec §7 / §8）。
//!
//! 规则：
//! - 缺失或非法版本号视为基线版本（`BASELINE_VERSION`），迁移后补写当前版本号；
//! - 版本高于当前支持版本 → `SchemaTooNew`，拒绝加载（避免新版字段被静默丢弃）；
//! - 每级迁移写成一个 `step_*`，`step()` 负责分派，便于逐个补历史样本测试。

use crate::error::{AppError, AppResult};
use serde_json::Value;

/// 当前代码支持的 schema 版本，与 `project::SCHEMA_VERSION` 保持一致。
pub const CURRENT_VERSION: u32 = 2;

/// 最早的、被承认的历史版本；缺失/非法版本号按它处理。
///
/// 与 `CURRENT_VERSION` 分开是必须的：一旦二者混用，升级到 v2 后
/// "没有版本号的旧文件"会被误判成"已是 v2"，跳过迁移与备份。
pub const BASELINE_VERSION: u32 = 1;

/// 把任意版本的 `project.json` 值迁移到当前版本。
pub fn migrate_to_current(mut value: Value) -> AppResult<Value> {
    if !value.is_object() {
        return Err(AppError::Validation {
            field: "project".into(),
            detail: "root must be a JSON object".into(),
        });
    }

    let mut version = peek_version(&value);
    if version > CURRENT_VERSION {
        return Err(AppError::SchemaTooNew {
            found: version,
            supported: CURRENT_VERSION,
        });
    }

    while version < CURRENT_VERSION {
        version = step(version, &mut value)?;
    }

    if let Some(obj) = value.as_object_mut() {
        obj.insert("schemaVersion".into(), Value::from(CURRENT_VERSION));
    }
    Ok(value)
}

/// 读取版本号；缺失或非法（0 / 非数字 / 超出 u32）视为基线版本。
pub fn peek_version(value: &Value) -> u32 {
    value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .map(|n| n as u32)
        .unwrap_or(BASELINE_VERSION)
}

/// 是否需要迁移（磁盘版本与当前版本不一致）。
/// 读取方据此在迁移前自动备份原文件。
pub fn needs_migration(value: &Value) -> bool {
    peek_version(value) != CURRENT_VERSION
}

/// 从 `from` 版本迁移到 `from + 1`，返回新版本号。
fn step(from: u32, value: &mut Value) -> AppResult<u32> {
    match from {
        1 => step_1_to_2(value)?,
        _ => {}
    }
    Ok(from + 1)
}

/// v1 → v2：新增 `script` 段（创意核 / 大纲）。
///
/// 只补缺失的键，已有内容原样保留；空对象交由 `Script` 的字段默认值填充。
fn step_1_to_2(value: &mut Value) -> AppResult<()> {
    if let Some(obj) = value.as_object_mut() {
        obj.entry("script")
            .or_insert_with(|| Value::Object(Default::default()));
    }
    Ok(())
}

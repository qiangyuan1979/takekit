//! `schemaVersion` 迁移框架（spec §7 / §8）。
//!
//! 规则：
//! - 缺失或非法版本号视为最早版本（v1），迁移后补写当前版本号；
//! - 版本高于当前支持版本 → `SchemaTooNew`，拒绝加载（避免新版字段被静默丢弃）；
//! - 每级迁移写成一个 `step_*`，`step()` 负责分派，便于逐个补历史样本测试。
//!
//! v1 是首个版本，因此暂时没有任何实际迁移步骤。

use crate::error::{AppError, AppResult};
use serde_json::Value;

/// 当前代码支持的 schema 版本，与 `project::SCHEMA_VERSION` 保持一致。
pub const CURRENT_VERSION: u32 = 1;

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

/// 读取版本号；缺失或非法（0 / 非数字 / 超出 u32）视为当前基线版本。
pub fn peek_version(value: &Value) -> u32 {
    value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .map(|n| n as u32)
        .unwrap_or(CURRENT_VERSION)
}

/// 是否需要迁移（磁盘版本与当前版本不一致）。
/// 读取方据此在迁移前自动备份原文件。
pub fn needs_migration(value: &Value) -> bool {
    peek_version(value) != CURRENT_VERSION
}

/// 从 `from` 版本迁移到 `from + 1`，返回新版本号。
fn step(from: u32, value: &mut Value) -> AppResult<u32> {
    // v1 是基线版本，尚无历史版本需要升级。后续新增版本时在此分派：
    //   1 => step_1_to_2(value)?,   // 例如补字段默认值
    let _ = value;
    Ok(from + 1)
}

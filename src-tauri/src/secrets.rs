//! 密钥存储。
//!
//! 设计规格 §9.3 要求 Key 由 Rust 侧持有、前端不接触明文。
//!
//! **M1 阶段为明文占位实现**：落应用数据目录下的 `secrets.json`，且
//! 该文件既不进仓库也不进项目目录（见 `.gitignore`）。之所以先用明文，
//! 是为了尽快打通「设置 → 适配器」链路，避免密钥库依赖阻塞 M2。
//!
//! M8 将把内部实现替换为系统凭据库（失败时降级为本地加密文件），
//! `SecretStore` 的公开接口保持不变，调用方无需改动。

use crate::error::AppResult;
use crate::project::store::atomic_write;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 密钥文件名（位于应用数据目录下）。
pub const SECRETS_FILE: &str = "secrets.json";

type SecretMap = BTreeMap<String, String>;

/// 密钥清单的落盘形态，留出 `version` 便于 M8 迁移到加密格式。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SecretsDoc {
    version: u32,
    items: SecretMap,
}

/// 密钥存取句柄。
#[derive(Debug, Clone)]
pub struct SecretStore {
    path: PathBuf,
}

impl SecretStore {
    /// 在应用数据目录下创建句柄（不立即读写磁盘）。
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join(SECRETS_FILE),
        }
    }

    /// 密钥文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取全部密钥；文件不存在视为空。
    fn read_all(&self) -> AppResult<SecretMap> {
        if !self.path.is_file() {
            return Ok(SecretMap::new());
        }
        let bytes = fs::read(&self.path)?;
        let doc: SecretsDoc = serde_json::from_slice(&bytes)?;
        Ok(doc.items)
    }

    fn write_all(&self, items: &SecretMap) -> AppResult<()> {
        let doc = SecretsDoc {
            version: 1,
            items: items.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&doc)?;
        atomic_write(&self.path, &bytes)
    }

    /// 读取单个密钥。
    pub fn get(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self.read_all()?.get(key).cloned())
    }

    /// 写入（覆盖）单个密钥。
    pub fn set(&self, key: &str, value: &str) -> AppResult<()> {
        let mut items = self.read_all()?;
        items.insert(key.to_string(), value.to_string());
        self.write_all(&items)
    }

    /// 删除单个密钥（不存在时静默通过）。
    pub fn remove(&self, key: &str) -> AppResult<()> {
        let mut items = self.read_all()?;
        if items.remove(key).is_some() {
            self.write_all(&items)?;
        }
        Ok(())
    }

    /// 是否存在该密钥。
    pub fn has(&self, key: &str) -> AppResult<bool> {
        Ok(self.read_all()?.contains_key(key))
    }
}

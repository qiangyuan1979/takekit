//! 全局模板库命令（spec §6.2 / plan M8 ①）。
//!
//! 模板库存在应用数据目录（决策点 #8）：随应用升级保留、跨项目复用，
//! 不复制进任何 `project.json`——项目里只留 [`crate::project::TemplateRef`] 的 id。
//!
//! 约定：`payload` 是套用载荷，形状由 `kind` 决定（立项 / 剧本 / 分镜 / 运镜 / 提示词），
//! 后端不解释语义、只校验它是个 JSON 对象；怎么套用由前端 `lib/templateOps.ts` 负责。

use crate::commands::app_data_dir;
use crate::error::{AppError, AppResult};
use crate::project::store::atomic_write;
use crate::project::{new_id, now_iso};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 模板库文件名（位于应用数据目录下）。
pub const TEMPLATES_FILE: &str = "templates.json";

/// 合法模板种类；与前端 `TemplateKind` 一一对应。
const KINDS: [&str; 5] = ["meta", "script", "storyboard", "camera", "prompt"];

/// 一条模板。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    /// 用户模板为新建 uuid；内置模板用固定 id（由前端持有，不入库）。
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 套用载荷，形状由 `kind` 决定。
    pub payload: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

fn templates_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(TEMPLATES_FILE)
}

/// 读取模板库；文件缺失或损坏时返回空列表（不阻塞启动）。
fn read_templates(app_data_dir: &Path) -> Vec<Template> {
    let path = templates_file(app_data_dir);
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<Template>>(&bytes).unwrap_or_default()
}

fn write_templates(app_data_dir: &Path, items: &[Template]) -> AppResult<()> {
    fs::create_dir_all(app_data_dir)?;
    let bytes = serde_json::to_vec_pretty(items)?;
    atomic_write(&templates_file(app_data_dir), &bytes)
}

/// 落盘前的校验：名字非空、种类合法、载荷是对象。
fn validate(template: &Template) -> AppResult<()> {
    if template.name.trim().is_empty() {
        return Err(AppError::Validation {
            field: "name".into(),
            detail: "template name must not be empty".into(),
        });
    }
    if !KINDS.contains(&template.kind.as_str()) {
        return Err(AppError::Validation {
            field: "kind".into(),
            detail: format!("unsupported template kind: {}", template.kind),
        });
    }
    if !template.payload.is_object() {
        return Err(AppError::Validation {
            field: "payload".into(),
            detail: "template payload must be a JSON object".into(),
        });
    }
    Ok(())
}

/// 列表：全部用户模板（内置模板由前端合并，不在这里）。
#[tauri::command]
pub fn list_templates(app: AppHandle) -> AppResult<Vec<Template>> {
    let data = app_data_dir(&app)?;
    Ok(read_templates(&data))
}

/// 新增或覆盖一条模板（按 id 判定），返回落盘后的完整列表。
#[tauri::command]
pub fn save_template(app: AppHandle, mut template: Template) -> AppResult<Vec<Template>> {
    validate(&template)?;
    let data = app_data_dir(&app)?;
    let mut items = read_templates(&data);

    template.name = template.name.trim().to_string();
    template.updated_at = now_iso();
    if template.id.trim().is_empty() {
        template.id = new_id();
        template.created_at = template.updated_at.clone();
    } else if template.created_at.trim().is_empty() {
        template.created_at = template.updated_at.clone();
    }

    match items.iter_mut().find(|item| item.id == template.id) {
        Some(existing) => *existing = template,
        None => items.push(template),
    }
    write_templates(&data, &items)?;
    Ok(items)
}

/// 删除一条模板；id 不存在时视为已删除，返回删除后的完整列表。
#[tauri::command]
pub fn delete_template(app: AppHandle, id: String) -> AppResult<Vec<Template>> {
    let data = app_data_dir(&app)?;
    let mut items = read_templates(&data);
    let before = items.len();
    items.retain(|item| item.id != id);
    if items.len() != before {
        write_templates(&data, &items)?;
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    //! Unit tests: template library roundtrip + validation.

    use super::*;
    use tempfile::TempDir;

    fn make(kind: &str, name: &str) -> Template {
        Template {
            id: String::new(),
            kind: kind.into(),
            name: name.into(),
            description: String::new(),
            payload: serde_json::json!({ "genre": "都市逆袭" }),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = TempDir::new().unwrap();
        assert!(read_templates(dir.path()).is_empty());
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = TempDir::new().unwrap();
        let mut item = make("meta", "都市逆袭三幕");
        item.id = "tpl-1".into();
        item.created_at = "2026-01-01T00:00:00Z".into();
        item.updated_at = "2026-01-01T00:00:00Z".into();
        write_templates(dir.path(), &[item.clone()]).unwrap();
        assert_eq!(read_templates(dir.path()), vec![item]);
    }

    #[test]
    fn corrupt_file_reads_as_empty() {
        let dir = TempDir::new().unwrap();
        fs::write(templates_file(dir.path()), b"{ not json").unwrap();
        assert!(read_templates(dir.path()).is_empty());
    }

    #[test]
    fn validate_rejects_empty_name_unknown_kind_and_non_object_payload() {
        let empty_name = make("meta", "   ");
        assert_eq!(validate(&empty_name).unwrap_err().code(), "validation");

        let bad_kind = make("post", "x");
        let error = validate(&bad_kind).unwrap_err();
        assert_eq!(error.code(), "validation");
        assert_eq!(error.args().get("field").map(String::as_str), Some("kind"));

        let mut bad_payload = make("meta", "x");
        bad_payload.payload = serde_json::json!("nope");
        let error = validate(&bad_payload).unwrap_err();
        assert_eq!(
            error.args().get("field").map(String::as_str),
            Some("payload")
        );
    }

    #[test]
    fn validate_accepts_every_known_kind() {
        for kind in KINDS {
            assert!(validate(&make(kind, "ok")).is_ok(), "kind {kind} rejected");
        }
    }
}

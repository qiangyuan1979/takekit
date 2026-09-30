//! 全局素材库命令（spec §6.5 / plan M8 ④）：参考图 / 音频 / 字体跨项目复用。
//!
//! 素材库存在应用数据目录：`materials.json` 索引 + `materials/` 实体文件（`{id}.{ext}`）。
//! 与模板库同规矩——随应用升级保留、跨项目复用，**不复制进任何 `project.json`**；
//! 项目里要用时，由前端把库内文件的绝对路径交给 `import_asset_image`（复制一份进项目）。
//!
//! 音频 / 字体在 v1 的消费端分别是「后期选曲（v1.5）」与「界面字体（设置页）」，
//! 因此这里只做统一的库管理，不解释语义。

use crate::commands::app_data_dir;
use crate::error::{AppError, AppResult};
use crate::project::store::atomic_write;
use crate::project::{new_id, now_iso};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 素材库索引文件名（位于应用数据目录下）。
pub const MATERIALS_FILE: &str = "materials.json";

/// 实体文件目录名（位于应用数据目录下）。
const MATERIALS_DIR: &str = "materials";

/// 素材种类；与前端 `MaterialKind` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialKind {
    Image,
    Audio,
    Font,
}

impl MaterialKind {
    /// 该种类允许的扩展名（小写）。
    fn exts(self) -> &'static [&'static str] {
        match self {
            MaterialKind::Image => &["png", "jpg", "jpeg", "webp"],
            MaterialKind::Audio => &["mp3", "wav", "m4a", "aac", "ogg", "flac"],
            MaterialKind::Font => &["ttf", "otf", "woff", "woff2"],
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            MaterialKind::Image => "image",
            MaterialKind::Audio => "audio",
            MaterialKind::Font => "font",
        }
    }
}

/// 一条素材记录。实体文件在 `materials/{id}.{ext}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub id: String,
    pub kind: MaterialKind,
    /// 展示名（用户可改；默认取源文件名）。
    pub name: String,
    /// 小写扩展名，同时决定实体文件名后缀。
    pub ext: String,
    /// 字节数，供前端展示体积。
    pub bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

/// 返回给前端的视图：记录 + 库内绝对路径（供 `convertFileSrc` 预览 / 作为导入源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialView {
    #[serde(flatten)]
    material: Material,
    path: String,
}

fn materials_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(MATERIALS_DIR)
}

fn materials_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(MATERIALS_FILE)
}

fn material_path(app_data_dir: &Path, material: &Material) -> PathBuf {
    materials_dir(app_data_dir).join(format!("{}.{}", material.id, material.ext))
}

/// 读取素材库；文件缺失或损坏时返回空列表（不阻塞启动）。
fn read_materials(app_data_dir: &Path) -> Vec<Material> {
    let Ok(bytes) = fs::read(materials_file(app_data_dir)) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<Material>>(&bytes).unwrap_or_default()
}

fn write_materials(app_data_dir: &Path, items: &[Material]) -> AppResult<()> {
    fs::create_dir_all(app_data_dir)?;
    let bytes = serde_json::to_vec_pretty(items)?;
    atomic_write(&materials_file(app_data_dir), &bytes)
}

/// 扩展名白名单校验。
fn check_ext(kind: MaterialKind, ext: &str) -> AppResult<()> {
    if !kind.exts().contains(&ext) {
        return Err(AppError::Validation {
            field: "sourcePath".into(),
            detail: format!("unsupported {} type: .{ext}", kind.as_str()),
        });
    }
    Ok(())
}

/// 源文件名（不含扩展名），用作默认展示名。
fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// 导入一份素材：复制进库目录并追加记录，返回更新后的完整列表。
///
/// 先落盘再写索引：复制失败时索引里不会留下指向空文件的记录。
fn import_into(
    app_data_dir: &Path,
    kind: MaterialKind,
    source: &Path,
    name: Option<String>,
) -> AppResult<Vec<Material>> {
    if !source.is_file() {
        return Err(AppError::NotFound {
            path: source.display().to_string(),
        });
    }
    let ext = extension_of(source);
    check_ext(kind, &ext)?;

    let mut items = read_materials(app_data_dir);
    let dir = materials_dir(app_data_dir);
    fs::create_dir_all(&dir)?;

    let id = new_id();
    let dest = dir.join(format!("{id}.{ext}"));
    fs::copy(source, &dest)?;
    let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

    let display = name.unwrap_or_else(|| file_stem(source)).trim().to_string();
    let now = now_iso();
    items.push(Material {
        id,
        kind,
        name: display,
        ext,
        bytes,
        created_at: now.clone(),
        updated_at: now,
    });
    write_materials(app_data_dir, &items)?;
    Ok(items)
}

/// 删除一份素材：删实体文件 + 删记录，返回更新后的完整列表。
///
/// id 不存在时视为已删除（幂等），不写盘。
fn delete_from(app_data_dir: &Path, id: &str) -> AppResult<Vec<Material>> {
    let mut items = read_materials(app_data_dir);
    let Some(index) = items.iter().position(|item| item.id == id) else {
        return Ok(items);
    };
    let removed = items.remove(index);
    match fs::remove_file(material_path(app_data_dir, &removed)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    write_materials(app_data_dir, &items)?;
    Ok(items)
}

fn views(app_data_dir: &Path, items: Vec<Material>) -> Vec<MaterialView> {
    items
        .into_iter()
        .map(|material| MaterialView {
            path: material_path(app_data_dir, &material).display().to_string(),
            material,
        })
        .collect()
}

/// 扩展名（小写，无扩展名时为空串）。
fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 列表：全部素材（含绝对路径）。
#[tauri::command]
pub fn list_materials(app: AppHandle) -> AppResult<Vec<MaterialView>> {
    let data = app_data_dir(&app)?;
    Ok(views(&data, read_materials(&data)))
}

/// 导入一份本地文件到素材库，返回落盘后的完整列表。
#[tauri::command]
pub fn import_material(
    app: AppHandle,
    kind: MaterialKind,
    source_path: String,
    name: Option<String>,
) -> AppResult<Vec<MaterialView>> {
    let data = app_data_dir(&app)?;
    let items = import_into(&data, kind, Path::new(&source_path), name)?;
    Ok(views(&data, items))
}

/// 删除一份素材；id 不存在时视为已删除，返回删除后的完整列表。
#[tauri::command]
pub fn delete_material(app: AppHandle, id: String) -> AppResult<Vec<MaterialView>> {
    let data = app_data_dir(&app)?;
    let items = delete_from(&data, &id)?;
    Ok(views(&data, items))
}

#[cfg(test)]
mod tests {
    //! Unit tests: material library roundtrip + import/delete + extension whitelist.

    use super::*;
    use tempfile::TempDir;

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = TempDir::new().unwrap();
        assert!(read_materials(dir.path()).is_empty());
    }

    #[test]
    fn corrupt_file_reads_as_empty() {
        let dir = TempDir::new().unwrap();
        fs::write(materials_file(dir.path()), b"{ not json").unwrap();
        assert!(read_materials(dir.path()).is_empty());
    }

    #[test]
    fn check_ext_accepts_only_the_kind_whitelist() {
        assert!(check_ext(MaterialKind::Image, "png").is_ok());
        assert!(check_ext(MaterialKind::Audio, "mp3").is_ok());
        assert!(check_ext(MaterialKind::Font, "woff2").is_ok());

        // 错配与未知类型都必须被拒。
        for (kind, ext) in [
            (MaterialKind::Image, "txt"),
            (MaterialKind::Image, "mp3"),
            (MaterialKind::Audio, "png"),
            (MaterialKind::Font, "ttf2"),
            (MaterialKind::Font, ""),
        ] {
            let error = check_ext(kind, ext).unwrap_err();
            assert_eq!(error.code(), "validation", "{kind:?} .{ext} 必须被拒绝");
            assert_eq!(
                error.args().get("field").map(String::as_str),
                Some("sourcePath")
            );
        }
    }

    #[test]
    fn import_copies_the_file_and_records_it() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("cover.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\nfake").unwrap();

        let items = import_into(dir.path(), MaterialKind::Image, &source, None).unwrap();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.kind, MaterialKind::Image);
        assert_eq!(item.name, "cover");
        assert_eq!(item.ext, "png");
        assert_eq!(item.bytes, 12);
        assert!(item.bytes > 0 && !item.id.is_empty());
        assert!(
            material_path(dir.path(), item).is_file(),
            "实体文件应已复制"
        );

        // 再读一次，记录应已落盘。
        assert_eq!(read_materials(dir.path()), items);
    }

    #[test]
    fn import_rejects_a_missing_or_wrong_type_source() {
        let dir = TempDir::new().unwrap();

        let missing = import_into(
            dir.path(),
            MaterialKind::Image,
            &dir.path().join("nope.png"),
            None,
        )
        .unwrap_err();
        assert_eq!(missing.code(), "not_found");

        let text = dir.path().join("note.txt");
        fs::write(&text, b"hi").unwrap();
        let wrong = import_into(dir.path(), MaterialKind::Image, &text, None).unwrap_err();
        assert_eq!(wrong.code(), "validation");
    }

    #[test]
    fn import_honours_an_explicit_name() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("a.mp3");
        fs::write(&source, b"ID3fake").unwrap();

        let items = import_into(
            dir.path(),
            MaterialKind::Audio,
            &source,
            Some("  片头曲  ".to_string()),
        )
        .unwrap();
        assert_eq!(items[0].name, "片头曲");
    }

    #[test]
    fn delete_removes_file_and_record_and_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("font.ttf");
        fs::write(&source, b"fake-font").unwrap();
        let items = import_into(dir.path(), MaterialKind::Font, &source, None).unwrap();
        let id = items[0].id.clone();
        let path = material_path(dir.path(), &items[0]);
        assert!(path.is_file());

        let after = delete_from(dir.path(), &id).unwrap();
        assert!(after.is_empty());
        assert!(!path.exists(), "实体文件应已删除");

        // 再删一次返回空列表，而不是报错。
        assert!(delete_from(dir.path(), &id).unwrap().is_empty());
    }

    #[test]
    fn views_expose_absolute_paths_inside_the_library_dir() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("bg.webp");
        fs::write(&source, b"fake-webp").unwrap();
        let items = import_into(dir.path(), MaterialKind::Image, &source, None).unwrap();

        let rendered = views(dir.path(), items.clone());
        assert_eq!(rendered.len(), 1);
        assert_eq!(rendered[0].material, items[0]);
        assert_eq!(
            PathBuf::from(&rendered[0].path),
            material_path(dir.path(), &items[0])
        );

        // 序列化后是「扁平」的 camelCase 视图，前端直接可用。
        let json = serde_json::to_value(&rendered[0]).unwrap();
        assert_eq!(json["kind"], "image");
        assert_eq!(json["ext"], "webp");
        assert!(json["path"].as_str().unwrap().ends_with(".webp"));
        assert!(json.get("material").is_none(), "视图应被扁平化");
    }
}

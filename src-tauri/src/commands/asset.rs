//! 资产命令：参考图导入 / 候选图生成落盘 / 删除清理（spec §5.3、§8）。
//!
//! 约定两条，目的是让项目目录可以整体搬家：
//! 1. 图片一律落在 `<项目根>/assets/{characters,scenes,props,style}/<ownerId>/`；
//! 2. `project.json` 里只存**项目相对路径**（正斜杠），绝不存绝对路径。
//!
//! 适配器不碰文件系统（spec §9.2）：本地参考图在这里读出来编码成 data URL 再交出去，
//! 生成结果在这里落盘。

use crate::adapters::image::{jimeng, ImageProvider, ImageRequest};
use crate::commands::project::resolve_project_path;
use crate::commands::settings::load_image_config;
use crate::error::{AppError, AppResult};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

/// 出图整体超时：比对话慢得多，给足 5 分钟。
const IMAGE_TIMEOUT: Duration = Duration::from_secs(300);

/// 允许导入的图片扩展名（小写）。
const ALLOWED_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// 资产类别 → 项目内的图片子目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Character,
    Scene,
    Prop,
    Style,
}

impl AssetKind {
    /// 项目内的相对子目录。
    fn dir(self) -> &'static str {
        match self {
            AssetKind::Character => "assets/characters",
            AssetKind::Scene => "assets/scenes",
            AssetKind::Prop => "assets/props",
            AssetKind::Style => "assets/style",
        }
    }
}

/// 生成请求的传输形态，字段名与前端一致。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GenerateImageArgs {
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub count: u32,
    pub seed: Option<i64>,
    /// 参考图：项目相对路径（如 `assets/characters/c1/ref-1.png`）。
    pub ref_images: Vec<String>,
}

impl GenerateImageArgs {
    /// 把本地参考图读成 data URL，适配器因此无需知道项目目录在哪。
    fn into_provider_request(self, root: &Path) -> AppResult<ImageRequest> {
        let mut ref_images = Vec::with_capacity(self.ref_images.len());
        for relative in &self.ref_images {
            let path = resolve_relative(root, relative)?;
            let bytes = fs::read(&path).map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => AppError::NotFound {
                    path: relative.clone(),
                },
                _ => AppError::Io(e),
            })?;
            let mime = mime_for_ext(&extension_of(&path));
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            ref_images.push(format!("data:{mime};base64,{encoded}"));
        }

        Ok(ImageRequest {
            prompt: self.prompt,
            negative_prompt: self.negative_prompt,
            width: self.width,
            height: self.height,
            count: self.count,
            seed: self.seed,
            ref_images,
        })
    }
}

/// 导入一张本地参考图到资产目录，返回项目相对路径。
#[tauri::command]
pub fn import_asset_image(
    project_path: String,
    kind: AssetKind,
    owner_id: String,
    source_path: String,
) -> AppResult<String> {
    let root = project_root(&project_path)?;
    let dir = owner_dir(&root, kind, &owner_id)?;

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(AppError::NotFound { path: source_path });
    }
    let ext = extension_of(&source);
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(AppError::Validation {
            field: "sourcePath".into(),
            detail: format!("unsupported image type: .{ext}"),
        });
    }

    fs::create_dir_all(&dir)?;
    let dest = dir.join(format!("ref-{}.{ext}", stamp()));
    fs::copy(&source, &dest)?;
    to_relative(&root, &dest)
}

/// 删除项目内的若干图片，返回实际删除数量；已不存在的视为已删（幂等）。
#[tauri::command]
pub fn delete_asset_files(project_path: String, paths: Vec<String>) -> AppResult<usize> {
    let root = project_root(&project_path)?;
    let mut removed = 0;
    for relative in &paths {
        let path = resolve_relative(&root, relative)?;
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(removed)
}

/// 删除某个资产的全部图片目录（删除资产卡时调用）；目录不存在时静默通过。
#[tauri::command]
pub fn delete_asset_dir(project_path: String, kind: AssetKind, owner_id: String) -> AppResult<()> {
    let root = project_root(&project_path)?;
    let dir = owner_dir(&root, kind, &owner_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// 生成候选图并落盘，返回项目相对路径列表（顺序即候选顺序）。
#[tauri::command]
pub async fn generate_asset_images(
    app: AppHandle,
    project_path: String,
    kind: AssetKind,
    owner_id: String,
    request: GenerateImageArgs,
) -> AppResult<Vec<String>> {
    let root = project_root(&project_path)?;
    let dir = owner_dir(&root, kind, &owner_id)?;

    let config = load_image_config(&app)?;
    let provider = jimeng::JimengProvider::new(
        &config.base_url,
        &config.api_key,
        &config.model,
        IMAGE_TIMEOUT,
    )?;

    let request = request.into_provider_request(&root)?;
    let outputs = provider.generate(&request).await?;

    fs::create_dir_all(&dir)?;
    // 同一批候选共用一个批次号，便于「重出一次」时区分旧图。
    let batch = stamp();
    let mut saved = Vec::with_capacity(outputs.len());
    for (index, output) in outputs.iter().enumerate() {
        let dest = dir.join(format!("gen-{batch}-{index}.{}", image_ext(&output.mime)));
        fs::write(&dest, &output.bytes)?;
        saved.push(to_relative(&root, &dest)?);
    }
    Ok(saved)
}

// ---------- 路径与类型助手 ----------

/// 项目根目录（`project.json` 所在目录）。
fn project_root(project_path: &str) -> AppResult<PathBuf> {
    Ok(resolve_project_path(project_path)?.0)
}

/// owner 目录：`<root>/<kind.dir()>/<ownerId>`。
///
/// `ownerId` 必须是纯标识符，否则一条脏数据就能把文件写到项目外。
fn owner_dir(root: &Path, kind: AssetKind, owner_id: &str) -> AppResult<PathBuf> {
    let id = owner_id.trim();
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::Validation {
            field: "ownerId".into(),
            detail: "owner id must be a non-empty identifier".into(),
        });
    }
    Ok(root.join(kind.dir()).join(id))
}

/// 绝对路径 → 项目相对路径（统一正斜杠，避免 Windows 反斜杠进数据）。
fn to_relative(root: &Path, path: &Path) -> AppResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| AppError::Validation {
        field: "path".into(),
        detail: "path must live inside the project directory".into(),
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// 项目相对路径 → 绝对路径；拒绝绝对路径与 `..` 穿越。
fn resolve_relative(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(relative);
    let escapes = candidate.is_absolute()
        || candidate.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        });
    if escapes {
        return Err(AppError::Validation {
            field: "path".into(),
            detail: "path must be project-relative and must not contain '..'".into(),
        });
    }
    Ok(root.join(candidate))
}

/// 路径扩展名（小写，无扩展名时为空串）。
fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

/// mime → 落盘扩展名；未知一律按 png 存（后续仍可按文件头识别）。
fn image_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// 扩展名 → mime，用于把本地参考图包成 data URL。
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// 文件名时间戳：毫秒（字典序等价时间序）+ 8 位随机，避免同毫秒覆盖。
fn stamp() -> String {
    let millis = chrono::Utc::now().timestamp_millis();
    let unique = uuid::Uuid::new_v4().simple().to_string();
    format!("{millis}-{}", &unique[..8])
}

#[cfg(test)]
mod tests {
    //! 只覆盖路径与类型映射这两处纯逻辑——落盘流程由 `tests/asset.rs` 端到端覆盖。

    use super::*;
    use tempfile::TempDir;

    #[test]
    fn relative_paths_round_trip_and_use_forward_slashes() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let file = root.join("assets/characters/c1/ref-1.png");

        let relative = to_relative(root, &file).unwrap();
        assert_eq!(relative, "assets/characters/c1/ref-1.png");
        assert_eq!(resolve_relative(root, &relative).unwrap(), file);
    }

    #[test]
    fn relative_paths_outside_the_project_are_rejected() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        let outside = dir.path().join("project-other/ref.png");
        assert_eq!(
            to_relative(&root, &outside).unwrap_err().code(),
            "validation"
        );
    }

    #[test]
    fn resolve_relative_rejects_absolute_and_escaping_paths() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        for sneaky in [
            "../secrets.json",
            "assets/../../secrets.json",
            "/etc/passwd",
        ] {
            assert_eq!(
                resolve_relative(root, sneaky).unwrap_err().code(),
                "validation",
                "{sneaky} 必须被拒绝"
            );
        }
    }

    #[test]
    fn owner_dir_only_accepts_plain_identifiers() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        for bad in ["", "  ", "../x", "a/b", "a\\b"] {
            assert_eq!(
                owner_dir(root, AssetKind::Character, bad)
                    .unwrap_err()
                    .code(),
                "validation",
                "{bad:?} 必须被拒绝"
            );
        }
        assert_eq!(
            owner_dir(root, AssetKind::Prop, "prop-1").unwrap(),
            root.join("assets/props/prop-1")
        );
        assert_eq!(
            owner_dir(root, AssetKind::Style, "style_lock").unwrap(),
            root.join("assets/style/style_lock")
        );
    }

    #[test]
    fn extension_and_mime_map_to_each_other() {
        assert_eq!(image_ext("image/jpeg"), "jpg");
        assert_eq!(image_ext("image/webp"), "webp");
        assert_eq!(image_ext("image/png"), "png");
        assert_eq!(image_ext("application/octet-stream"), "png");

        assert_eq!(mime_for_ext("jpg"), "image/jpeg");
        assert_eq!(mime_for_ext("jpeg"), "image/jpeg");
        assert_eq!(mime_for_ext("webp"), "image/webp");
        assert_eq!(mime_for_ext("png"), "image/png");
        assert_eq!(mime_for_ext(""), "image/png");
    }

    /// 临时目录本身就是一个合法「项目目录」，可用来端到端跑导入与清理。
    fn png_header() -> &'static [u8] {
        b"\x89PNG\r\n\x1a\nfake-body"
    }

    #[test]
    fn import_names_files_predictably_and_delete_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let source = root.join("incoming.png");
        fs::write(&source, png_header()).unwrap();

        let project_path = root.display().to_string();
        let relative = import_asset_image(
            project_path.clone(),
            AssetKind::Character,
            "c1".to_string(),
            source.display().to_string(),
        )
        .unwrap();

        assert!(
            relative.starts_with("assets/characters/c1/ref-"),
            "{relative}"
        );
        assert!(relative.ends_with(".png"), "{relative}");
        let saved = resolve_relative(root, &relative).unwrap();
        assert!(saved.is_file(), "导入后文件应存在");

        assert_eq!(
            delete_asset_files(project_path.clone(), vec![relative.clone()]).unwrap(),
            1
        );
        assert!(!saved.exists());
        // 再删一次返回 0，而不是报错。
        assert_eq!(delete_asset_files(project_path, vec![relative]).unwrap(), 0);
    }

    #[test]
    fn non_image_source_is_rejected() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let source = root.join("note.txt");
        fs::write(&source, b"hi").unwrap();

        let error = import_asset_image(
            root.display().to_string(),
            AssetKind::Scene,
            "s1".to_string(),
            source.display().to_string(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "validation");
    }

    #[test]
    fn delete_asset_dir_removes_everything_and_tolerates_absence() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let source = root.join("in.png");
        fs::write(&source, png_header()).unwrap();

        let project_path = root.display().to_string();
        let relative = import_asset_image(
            project_path.clone(),
            AssetKind::Scene,
            "s1".to_string(),
            source.display().to_string(),
        )
        .unwrap();

        delete_asset_dir(project_path.clone(), AssetKind::Scene, "s1".to_string()).unwrap();
        assert!(!resolve_relative(root, &relative).unwrap().exists());
        // 目录已不在，再删一次仍应通过。
        delete_asset_dir(project_path, AssetKind::Scene, "s1".to_string()).unwrap();
    }
}

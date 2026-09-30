//! 项目目录落盘：原子写 + 备份滚动 + 最近项目（spec §8）。

use crate::error::{AppError, AppResult};
use crate::project::{migrate, Project, WorkKind};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// 项目文件名（唯一真相源）。
pub const PROJECT_FILE: &str = "project.json";
/// 备份目录。
pub const BACKUP_DIR: &str = "backups";
/// 内部元数据目录（锁文件等）。
pub const META_DIR: &str = ".takekit";
/// 最近项目记录文件名（存应用数据目录，不属于任何项目）。
pub const RECENT_FILE: &str = "recent.json";
/// 备份保留份数。
pub const MAX_BACKUPS: usize = 10;
/// 最近项目保留条数。
pub const MAX_RECENT: usize = 15;

/// 项目目录下需要预建的子目录（spec §8）。
const SUB_DIRS: [&str; 8] = [
    "assets/characters",
    "assets/scenes",
    "assets/props",
    "assets/style",
    "keyframes",
    "clips",
    "exports",
    BACKUP_DIR,
];

/// 预建项目目录骨架。
pub fn ensure_dirs(root: &Path) -> AppResult<()> {
    for sub in SUB_DIRS {
        fs::create_dir_all(root.join(sub))?;
    }
    fs::create_dir_all(root.join(META_DIR))?;
    Ok(())
}

/// 项目根目录下的 `project.json` 路径。
pub fn project_file(root: &Path) -> PathBuf {
    root.join(PROJECT_FILE)
}

// ---------- 原子写 ----------

/// 第一阶段：把内容写到目标目录下的临时文件，返回临时文件路径。
///
/// 拆成两段是为了可测：调用 `stage_write` 后目标文件应保持原样，
/// 只有 `commit_write` 之后才发生替换，因此崩溃不会留下半截文件。
pub fn stage_write(target: &Path, bytes: &[u8]) -> AppResult<PathBuf> {
    let dir = target.parent().ok_or_else(|| {
        AppError::Internal(format!(
            "target has no parent directory: {}",
            target.display()
        ))
    })?;
    fs::create_dir_all(dir)?;

    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("data");
    let staged = dir.join(format!(".{file_name}.tmp-{}", Uuid::new_v4()));

    let mut file = File::create(&staged)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(staged)
}

/// 第二阶段：把临时文件 rename 到目标路径（同目录 rename 在同一卷内是原子的）。
pub fn commit_write(staged: &Path, target: &Path) -> AppResult<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(staged, target)?;
    Ok(())
}

/// 原子写：`stage_write` + `commit_write`；提交失败时清理临时文件。
pub fn atomic_write(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let staged = stage_write(target, bytes)?;
    if let Err(err) = commit_write(&staged, target) {
        let _ = fs::remove_file(&staged);
        return Err(err);
    }
    Ok(())
}

/// 原子写文本。
pub fn atomic_write_str(target: &Path, contents: &str) -> AppResult<()> {
    atomic_write(target, contents.as_bytes())
}

// ---------- 备份滚动 ----------

/// 把当前 `project.json` 备份一份到 `backups/`，并滚动淘汰最旧备份。
/// 目标文件不存在时返回 `None`（首次保存无需备份）。
pub fn backup_project(root: &Path) -> AppResult<Option<PathBuf>> {
    let src = project_file(root);
    if !src.is_file() {
        return Ok(None);
    }
    let dir = root.join(BACKUP_DIR);
    fs::create_dir_all(&dir)?;

    // 时间戳格式在字典序上等价于时间序，便于直接用文件名排序淘汰；
    // 追加随机短后缀避免同一毫秒内的连续保存互相覆盖。
    let stamp = Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let unique = Uuid::new_v4().simple().to_string();
    let dest = dir.join(format!("project-{stamp}-{}.json", &unique[..8]));
    fs::copy(&src, &dest)?;

    prune_backups(&dir, MAX_BACKUPS)?;
    Ok(Some(dest))
}

/// 保留最新的 `keep` 份 `project-*.json`，其余删除。
fn prune_backups(dir: &Path, keep: usize) -> AppResult<()> {
    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("project-") && name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort();
    if names.len() > keep {
        for name in &names[..names.len() - keep] {
            fs::remove_file(dir.join(name))?;
        }
    }
    Ok(())
}

// ---------- 读写 ----------

/// 写项目：先备份现有文件，再原子替换。
pub fn write_project(root: &Path, project: &Project) -> AppResult<()> {
    ensure_dirs(root)?;
    backup_project(root)?;
    let bytes = serde_json::to_vec_pretty(project)?;
    atomic_write(&project_file(root), &bytes)
}

/// 读项目：解析 → 迁移 → 反序列化。
pub fn read_project(root: &Path) -> AppResult<Project> {
    read_project_file(&project_file(root))
}

/// 从指定 `project.json` 路径读取（含迁移）。
pub fn read_project_file(path: &Path) -> AppResult<Project> {
    if !path.is_file() {
        return Err(AppError::NotFound {
            path: path.display().to_string(),
        });
    }
    let text = fs::read(path)?;
    let value: serde_json::Value = serde_json::from_slice(&text)?;

    // 迁移前自动备份（spec §8）。此处尚未写盘，备份到的就是迁移前的内容；
    // 备份失败不阻塞读取。
    if migrate::needs_migration(&value) {
        if let Some(root) = path.parent() {
            let _ = backup_project(root);
        }
    }

    let migrated = migrate::migrate_to_current(value)?;
    let project: Project = serde_json::from_value(migrated)?;
    Ok(project)
}

/// 新建项目目录并落盘首份 `project.json`。
pub fn create_project_dir(parent: &Path, name: &str) -> AppResult<(Project, PathBuf)> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation {
            field: "name".into(),
            detail: "project name must not be empty".into(),
        });
    }
    if !parent.is_dir() {
        return Err(AppError::NotFound {
            path: parent.display().to_string(),
        });
    }

    let root = parent.join(sanitize_folder_name(trimmed));
    if root.exists() {
        return Err(AppError::Conflict {
            path: root.display().to_string(),
        });
    }
    fs::create_dir_all(&root)?;
    ensure_dirs(&root)?;

    let project = Project::new(trimmed, WorkKind::default());
    write_project(&root, &project)?;
    Ok((project, root))
}

/// 复制项目整目录到 `parent_dir/<newName>`，并重置 id / 名称 / 时间戳。
pub fn duplicate_project(
    src_root: &Path,
    parent_dir: &Path,
    new_name: &str,
) -> AppResult<(Project, PathBuf)> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation {
            field: "newName".into(),
            detail: "project name must not be empty".into(),
        });
    }
    if !src_root.is_dir() {
        return Err(AppError::NotFound {
            path: src_root.display().to_string(),
        });
    }

    let dest = parent_dir.join(sanitize_folder_name(trimmed));
    if dest.exists() {
        return Err(AppError::Conflict {
            path: dest.display().to_string(),
        });
    }
    let mut project = read_project(src_root)?;
    copy_dir_all(src_root, &dest)?;

    project.id = crate::project::new_id();
    project.name = trimmed.to_string();
    project.meta.title = trimmed.to_string();
    project.created_at = crate::project::now_iso();
    project.touch();
    write_project(&dest, &project)?;
    Ok((project, dest))
}

/// 递归复制目录（跳过临时文件与备份，避免把历史备份一起带走）。
fn copy_dir_all(src: &Path, dest: &Path) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == BACKUP_DIR || name == META_DIR || name.starts_with('.') {
            continue;
        }
        let from = entry.path();
        let to = dest.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 目录名净化：替换 Windows / POSIX 非法字符，末尾点与空格、空名回落默认值。
fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "takekit-project".to_string()
    } else {
        cleaned
    }
}

// ---------- 最近项目 ----------

/// 最近项目记录（存应用数据目录，不属于任何项目目录）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

/// 最近项目记录文件路径。
pub fn recent_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RECENT_FILE)
}

/// 读取最近项目；文件缺失或损坏时返回空列表（不阻塞启动）。
pub fn load_recent(app_data_dir: &Path) -> Vec<RecentProject> {
    let path = recent_file(app_data_dir);
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<RecentProject>>(&bytes).unwrap_or_default()
}

/// 写入最近项目列表。
pub fn save_recent(app_data_dir: &Path, items: &[RecentProject]) -> AppResult<()> {
    fs::create_dir_all(app_data_dir)?;
    let bytes = serde_json::to_vec_pretty(items)?;
    atomic_write(&recent_file(app_data_dir), &bytes)
}

/// 记录一次打开：按路径去重后置顶，超出上限截断。
pub fn push_recent(app_data_dir: &Path, project: &Project, root: &Path) -> AppResult<()> {
    let path = root.display().to_string();
    let mut items = load_recent(app_data_dir);
    items.retain(|item| item.path != path);
    items.insert(
        0,
        RecentProject {
            path,
            name: project.name.clone(),
            opened_at: crate::project::now_iso(),
        },
    );
    items.truncate(MAX_RECENT);
    save_recent(app_data_dir, &items)
}

/// 归档：把某个项目从「最近打开」里移出，返回剩余列表。
///
/// 只动 `recent.json`，磁盘上的项目目录原样保留——归档不等于删除。
pub fn remove_recent(app_data_dir: &Path, path: &str) -> AppResult<Vec<RecentProject>> {
    let mut items = load_recent(app_data_dir);
    items.retain(|item| item.path != path);
    save_recent(app_data_dir, &items)?;
    Ok(items)
}

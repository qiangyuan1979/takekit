//! 项目管理命令：新建 / 打开 / 保存 / 最近 / 复制。

use crate::commands::app_data_dir;
use crate::error::{AppError, AppResult};
use crate::project::store::{self, RecentProject};
use crate::project::{Project, SCHEMA_VERSION};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

/// 项目 + 其所在目录（前端后续所有读写都基于该目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    pub project: Project,
    pub path: String,
}

/// 把「目录或 project.json 路径」统一解析为「根目录 + 文件路径」。
pub(crate) fn resolve_project_path(path: &str) -> AppResult<(PathBuf, PathBuf)> {
    let given = PathBuf::from(path);
    if given.is_dir() {
        let file = store::project_file(&given);
        return Ok((given, file));
    }
    if given.is_file() {
        if given.file_name().and_then(|s| s.to_str()) != Some(store::PROJECT_FILE) {
            return Err(AppError::Validation {
                field: "path".into(),
                detail: "expected a project directory or a project.json file".into(),
            });
        }
        let root = given.parent().ok_or_else(|| AppError::NotFound {
            path: path.to_string(),
        })?;
        return Ok((root.to_path_buf(), given));
    }
    Err(AppError::NotFound {
        path: path.to_string(),
    })
}

/// 新建项目：在 `parentDir` 下创建 `<项目名>/` 目录并写入首份 `project.json`。
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    parent_dir: String,
    name: String,
) -> AppResult<LoadedProject> {
    let (project, root) = store::create_project_dir(&PathBuf::from(&parent_dir), &name)?;
    remember(&app, &project, &root)?;
    Ok(LoadedProject {
        project,
        path: root.display().to_string(),
    })
}

/// 打开项目：接受项目目录或 `project.json` 路径。
#[tauri::command]
pub fn open_project(app: AppHandle, path: String) -> AppResult<LoadedProject> {
    let (root, file) = resolve_project_path(&path)?;
    let project = store::read_project_file(&file)?;
    remember(&app, &project, &root)?;
    Ok(LoadedProject {
        project,
        path: root.display().to_string(),
    })
}

/// 保存项目：刷新 `updatedAt`、先备份再原子写。返回更新后的项目（含新时间戳）。
#[tauri::command]
pub fn save_project(app: AppHandle, path: String, mut project: Project) -> AppResult<Project> {
    let (root, _file) = resolve_project_path(&path)?;
    project.schema_version = SCHEMA_VERSION;
    project.touch();
    store::write_project(&root, &project)?;
    remember(&app, &project, &root)?;
    Ok(project)
}

/// 最近项目列表（过滤掉已被移动 / 删除的目录）。
#[tauri::command]
pub fn list_recent_projects(app: AppHandle) -> AppResult<Vec<RecentProject>> {
    let data = app_data_dir(&app)?;
    Ok(store::load_recent(&data)
        .into_iter()
        .filter(|item| PathBuf::from(&item.path).is_dir())
        .collect())
}

/// 复制项目到 `parentDir/<newName>`，并重置 id / 名称 / 时间戳。
#[tauri::command]
pub fn duplicate_project(
    app: AppHandle,
    path: String,
    parent_dir: String,
    new_name: String,
) -> AppResult<LoadedProject> {
    let (root, _file) = resolve_project_path(&path)?;
    let (project, dest) = store::duplicate_project(&root, &PathBuf::from(&parent_dir), &new_name)?;
    remember(&app, &project, &dest)?;
    Ok(LoadedProject {
        project,
        path: dest.display().to_string(),
    })
}

/// 归档项目：只把它移出「最近打开」列表，磁盘上的项目文件原样保留。
#[tauri::command]
pub fn archive_project(app: AppHandle, path: String) -> AppResult<Vec<RecentProject>> {
    let (root, _file) = resolve_project_path(&path)?;
    let data = app_data_dir(&app)?;
    fs::create_dir_all(&data)?;
    store::remove_recent(&data, &root.display().to_string())
}

/// 记录到「最近项目」；失败不影响主流程（只在日志层面可见）。
fn remember(app: &AppHandle, project: &Project, root: &PathBuf) -> AppResult<()> {
    let data = app_data_dir(app)?;
    fs::create_dir_all(&data)?;
    store::push_recent(&data, project, root)
}

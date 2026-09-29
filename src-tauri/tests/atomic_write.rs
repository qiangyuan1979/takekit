//! 集成测试：原子写（stage/commit 两段式）与备份滚动。
//!
//! 目标文件必须"要么是旧内容、要么是新内容"，绝不能出现半截文件；
//! 备份目录只保留最近 `MAX_BACKUPS` 份。

use std::fs;
use std::path::Path;
use tempfile::tempdir;

use takekit_lib::project::store;
use takekit_lib::project::{Project, WorkKind};

/// 统计备份目录里 `project-*.json` 的数量。
fn backup_count(root: &Path) -> usize {
    let dir = root.join(store::BACKUP_DIR);
    if !dir.is_dir() {
        return 0;
    }
    fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with("project-") && name.ends_with(".json")
        })
        .count()
}

/// 统计目录里残留的原子写临时文件（形如 `.{name}.tmp-{uuid}`）。
fn temp_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp-"))
        .collect()
}

#[test]
fn stage_write_leaves_target_intact_until_commit() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("data.json");

    store::atomic_write(&target, b"v1").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "v1");

    // 只暂存、不提交：目标文件必须保持旧内容，新内容待在临时文件里。
    let staged = store::stage_write(&target, b"v2").unwrap();
    assert!(staged.is_file(), "staged file must exist");
    assert!(staged
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(".data.json.tmp-"));
    assert_eq!(fs::read_to_string(&staged).unwrap(), "v2");
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "v1",
        "target must not change before commit"
    );

    // 提交后：目标变成新内容，临时文件消失。
    store::commit_write(&staged, &target).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "v2");
    assert!(!staged.exists(), "staged file must be renamed away");
    assert!(temp_files(dir.path()).is_empty());
}

#[test]
fn atomic_write_leaves_no_temp_file_behind() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("nested").join("data.json");

    store::atomic_write_str(&target, "hello 世界").unwrap();

    assert_eq!(fs::read_to_string(&target).unwrap(), "hello 世界");
    // 父目录被自动创建，且不留临时文件。
    assert!(temp_files(&target.parent().unwrap().to_path_buf()).is_empty());
    assert!(temp_files(dir.path()).is_empty());
}

#[test]
fn write_project_backs_up_and_keeps_only_max_backups() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let mut project = Project::new("滚动备份", WorkKind::ShortDrama);

    // 首次保存：还没有可备份的旧文件。
    store::write_project(root, &project).unwrap();
    assert_eq!(
        backup_count(root),
        0,
        "first save should not create a backup"
    );

    // 再保存 12 次 → 每次备份上一版 → 滚动保留 MAX_BACKUPS 份。
    for _ in 0..12 {
        project.touch();
        store::write_project(root, &project).unwrap();
    }
    assert_eq!(backup_count(root), store::MAX_BACKUPS);

    // 备份滚动不影响可读性。
    let loaded = store::read_project(root).unwrap();
    assert_eq!(loaded, project);
    assert!(store::project_file(root).is_file());
}

#[test]
fn ensure_dirs_creates_expected_skeleton() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    store::ensure_dirs(root).unwrap();

    for sub in [
        "assets/characters",
        "assets/scenes",
        "assets/props",
        "assets/style",
        "keyframes",
        "clips",
        "exports",
        store::BACKUP_DIR,
        store::META_DIR,
    ] {
        assert!(root.join(sub).is_dir(), "missing dir: {sub}");
    }
}

#[test]
fn recent_projects_deduplicate_and_cap() {
    let dir = tempdir().unwrap();
    let data = dir.path();
    let project = Project::new("最近项目", WorkKind::ShortDrama);

    // 同一路径重复记录应去重并置顶。
    for _ in 0..(store::MAX_RECENT + 5) {
        store::push_recent(data, &project, Path::new("E:/tmp/one")).unwrap();
    }
    let items = store::load_recent(data);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].path, "E:/tmp/one");
    assert_eq!(items[0].name, "最近项目");
}

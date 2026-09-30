//! 导出 / 交接命令（spec §5.6 的「产出」、plan M6 ⑨⑩）。
//!
//! 分工：`crate::storyboard` 负责「项目 ↔ 扁平表格」的纯数据搬运；本模块只负责
//! 选格式、读写文件，以及把分镜表 / 提示词包 / 参数表 / 关键帧打成一个能整体拷走的交接包。
//!
//! 三条约定：
//! 1. 导出不改项目——唯一例外是导入，它把覆盖后的项目原样返回，由前端决定何时保存
//!    （因此这里不调 `touch`，`save_project` 会做）。
//! 2. 写进 [`ExportRecord`] 的路径一律正斜杠，与 `project.json` 里其它路径口径一致。
//! 3. 交接包内所有引用都相对 `<destDir>`，整个目录可以直接发给剪辑或代生成的人。

use crate::commands::asset::{extension_of, resolve_relative};
use crate::commands::project::resolve_project_path;
use crate::error::{AppError, AppResult};
use crate::project::{new_id, now_iso, ExportRecord, Frame, FrameRole, Project, Shot};
use crate::storyboard::{self, Row};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 交接包里各文件的固定名字。
const STORYBOARD_CSV: &str = "storyboard.csv";
const STORYBOARD_JSON: &str = "storyboard.json";
const STORYBOARD_XLSX: &str = "storyboard.xlsx";
const PROMPTS_MD: &str = "prompts.md";
const PARAMS_CSV: &str = "params.csv";
const KEYFRAMES_CSV: &str = "keyframes.csv";
const FRAMES_DIR: &str = "frames";

/// 参数表的列：只讲「怎么生成」，不讲剧情（剧情在分镜表里）。
const PARAM_COLUMNS: [&str; 13] = [
    "episodeNo",
    "sceneNo",
    "shotNo",
    "durationMs",
    "aspectRatio",
    "resolution",
    "fps",
    "motionStrength",
    "seed",
    "negativePrompt",
    "refImages",
    "firstFrame",
    "lastFrame",
];

/// 关键帧清单的列；`source` 取 `adopted`（定稿）/ `candidate`（候选），
/// `file` 是它在交接包内的相对路径。
const KEYFRAME_COLUMNS: [&str; 6] = ["episodeNo", "sceneNo", "shotNo", "role", "source", "file"];

/// 导入结果：被覆盖的镜数 / 定位不到或枚举非法而跳过的行数，外加覆盖后的项目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub project: Project,
    pub updated: usize,
    pub skipped: usize,
}

/// 交接包产物：目录、导出记录、包内相对文件清单。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoverOutcome {
    pub dir: String,
    pub record: ExportRecord,
    /// 包内相对路径，含 `frames/` 下的每一张关键帧。
    pub files: Vec<String>,
}

// ---------- 命令 ----------

/// 导出分镜表到指定路径；`format` 取 `csv` / `json` / `xlsx`（大小写不敏感）。
///
/// 返回本次导出记录，由调用方追加进 `project.exports`——命令层不替项目做主。
#[tauri::command]
pub fn export_storyboard(
    project: Project,
    format: String,
    dest_path: String,
) -> AppResult<ExportRecord> {
    let rows = storyboard::rows_from_project(&project);
    let (kind, bytes) = encode(&format, &rows)?;

    let dest = PathBuf::from(&dest_path);
    write_file(&dest, &bytes)?;
    Ok(record(&kind, &dest))
}

/// 从分镜表（CSV / JSON / xlsx）导入，覆盖现有镜头；未匹配的行计入 `skipped`。
#[tauri::command]
pub fn import_storyboard(mut project: Project, source_path: String) -> AppResult<ImportOutcome> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(AppError::NotFound { path: source_path });
    }
    let bytes = fs::read(&source)?;
    let rows = decode(&source, &bytes)?;
    let stats = storyboard::apply_rows(&mut project, &rows);

    Ok(ImportOutcome {
        project,
        updated: stats.updated,
        skipped: stats.skipped,
    })
}

/// 导出交接包：分镜表三格式 + 提示词包 + 参数表 + 关键帧。
#[tauri::command]
pub fn export_handover_pack(
    project_path: String,
    project: Project,
    dest_dir: String,
) -> AppResult<HandoverOutcome> {
    let root = resolve_project_path(&project_path)?.0;
    let dest = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dest)?;

    let rows = storyboard::rows_from_project(&project);
    let mut files = Vec::new();
    let parts: [(&str, Vec<u8>); 5] = [
        (STORYBOARD_CSV, storyboard::to_csv(&rows)?),
        (STORYBOARD_JSON, storyboard::to_json(&rows)?),
        (STORYBOARD_XLSX, storyboard::to_xlsx(&rows)?),
        (PROMPTS_MD, prompts_markdown(&project).into_bytes()),
        (PARAMS_CSV, params_csv(&project)?),
    ];
    for (name, bytes) in parts {
        write_file(&dest.join(name), &bytes)?;
        files.push(name.to_string());
    }

    let (keyframes, copied) = copy_keyframes(&root, &project, &dest)?;
    write_file(&dest.join(KEYFRAMES_CSV), &keyframes)?;
    files.push(KEYFRAMES_CSV.to_string());
    files.extend(copied);

    Ok(HandoverOutcome {
        dir: dest.display().to_string(),
        record: record("handover", &dest),
        files,
    })
}

// ---------- 格式分派与落盘 ----------

/// 格式名 → 规范化名 + 编码结果；未知格式报 `validation`（`field = "format"`）。
fn encode(format: &str, rows: &[Row]) -> AppResult<(String, Vec<u8>)> {
    let kind = format.trim().to_ascii_lowercase();
    let bytes = match kind.as_str() {
        "csv" => storyboard::to_csv(rows)?,
        "json" => storyboard::to_json(rows)?,
        "xlsx" => storyboard::to_xlsx(rows)?,
        other => {
            return Err(AppError::Validation {
                field: "format".into(),
                detail: format!("unsupported storyboard format: {other}"),
            })
        }
    };
    Ok((kind, bytes))
}

/// 按扩展名分派解码；不认识的后缀报 `validation`（`field = "sourcePath"`）。
fn decode(source: &Path, bytes: &[u8]) -> AppResult<Vec<Row>> {
    match extension_of(source).as_str() {
        "csv" => storyboard::from_csv(bytes),
        "json" => storyboard::from_json(bytes),
        "xlsx" => storyboard::from_xlsx(bytes),
        other => Err(AppError::Validation {
            field: "sourcePath".into(),
            detail: format!("unsupported storyboard file type: .{other}"),
        }),
    }
}

/// 写文件，必要时先把父目录建出来（用户挑的路径可能指向还不存在的目录）。
fn write_file(dest: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = dest.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, bytes)?;
    Ok(())
}

/// 本次导出记录；时间与 id 在这里生成，`path` 统一正斜杠。
fn record(kind: &str, path: &Path) -> ExportRecord {
    ExportRecord {
        id: new_id(),
        kind: kind.to_string(),
        path: path.display().to_string().replace('\\', "/"),
        created_at: now_iso(),
    }
}

// ---------- 参数表 ----------

/// 生成参数表：一镜一行，`episodeNo/sceneNo/shotNo` 之外全空表示该镜还没出题。
fn params_csv(project: &Project) -> AppResult<Vec<u8>> {
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(PARAM_COLUMNS)
        .map_err(storyboard::csv_error)?;
    for episode in &project.episodes {
        for scene in &episode.scenes {
            for shot in &scene.shots {
                writer
                    .write_record(param_cells(episode.no, scene.no, shot))
                    .map_err(storyboard::csv_error)?;
            }
        }
    }
    writer
        .into_inner()
        .map_err(|e| AppError::Internal(format!("csv: {e}")))
}

fn param_cells(episode_no: u32, scene_no: u32, shot: &Shot) -> [String; 13] {
    let mut cells: [String; 13] = Default::default();
    cells[0] = episode_no.to_string();
    cells[1] = scene_no.to_string();
    cells[2] = shot.no.to_string();

    let Some(bundle) = &shot.prompt_bundle else {
        return cells;
    };
    let params = &bundle.params;
    cells[3] = params.duration_ms.to_string();
    cells[4] = params.aspect_ratio.as_str().to_string();
    cells[5] = params.resolution.clone();
    cells[6] = params.fps.to_string();
    cells[7] = params.motion_strength.to_string();
    cells[8] = params.seed.map(|seed| seed.to_string()).unwrap_or_default();
    cells[9] = params.negative_prompt.clone();
    cells[10] = params
        .ref_images
        .iter()
        .map(|image| {
            let (path, weight) = (&image.path, image.weight);
            format!("{path}*{weight}")
        })
        .collect::<Vec<_>>()
        .join("|");
    cells[11] = params.first_frame.clone().unwrap_or_default();
    cells[12] = params.last_frame.clone().unwrap_or_default();
    cells
}

// ---------- 关键帧 ----------

/// 把每镜的定稿帧（没有定稿则退回首张候选）拷进 `<dest>/frames/`。
///
/// 返回关键帧清单 CSV 与包内相对路径清单。指向已不存在文件的帧会明确报错——
/// 静默少一张会让接手的人以为"这镜本来就没帧"。
fn copy_keyframes(
    root: &Path,
    project: &Project,
    dest: &Path,
) -> AppResult<(Vec<u8>, Vec<String>)> {
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(KEYFRAME_COLUMNS)
        .map_err(storyboard::csv_error)?;

    let mut copied = Vec::new();
    for episode in &project.episodes {
        for scene in &episode.scenes {
            for shot in &scene.shots {
                for frame in &shot.frames {
                    let Some(source) = pick_frame(frame) else {
                        continue;
                    };
                    let role = role_name(frame.role);
                    let name = format!(
                        "e{}-s{}-sh{}-{role}{}",
                        episode.no,
                        scene.no,
                        shot.no,
                        suffix_of(source)
                    );
                    let from = resolve_relative(root, source)?;
                    let bytes = fs::read(&from).map_err(|e| match e.kind() {
                        std::io::ErrorKind::NotFound => AppError::NotFound {
                            path: source.to_string(),
                        },
                        _ => AppError::Io(e),
                    })?;
                    let relative = format!("{FRAMES_DIR}/{name}");
                    write_file(&dest.join(FRAMES_DIR).join(&name), &bytes)?;

                    writer
                        .write_record([
                            episode.no.to_string(),
                            scene.no.to_string(),
                            shot.no.to_string(),
                            role.to_string(),
                            if frame.adopted.is_some() {
                                "adopted".to_string()
                            } else {
                                "candidate".to_string()
                            },
                            relative.clone(),
                        ])
                        .map_err(storyboard::csv_error)?;
                    copied.push(relative);
                }
            }
        }
    }

    let bytes = writer
        .into_inner()
        .map_err(|e| AppError::Internal(format!("csv: {e}")))?;
    Ok((bytes, copied))
}

/// 定稿优先；没有定稿退回首张候选；两者都没有 = 这帧还没生成。
fn pick_frame(frame: &Frame) -> Option<&str> {
    frame
        .adopted
        .as_deref()
        .or_else(|| frame.candidates.first().map(String::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
}

fn role_name(role: FrameRole) -> &'static str {
    match role {
        FrameRole::First => "first",
        FrameRole::Last => "last",
    }
}

/// 源文件的扩展名后缀（含点）；没有扩展名时为空串。
fn suffix_of(path: &str) -> String {
    let ext = extension_of(Path::new(path));
    if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    }
}

// ---------- 提示词包（Markdown） ----------

/// 提示词包：每镜的中英提示词、拆解后的六段结构、参数、以及各家请求体。
///
/// 面向"接手的人"而不是程序——所以是 Markdown 表格与代码块，段落标题带集/场/镜号，
/// 方便直接对着分镜表找。
fn prompts_markdown(project: &Project) -> String {
    let total: usize = project
        .episodes
        .iter()
        .flat_map(|episode| &episode.scenes)
        .flat_map(|scene| &scene.shots)
        .count();
    let ready: usize = project
        .episodes
        .iter()
        .flat_map(|episode| &episode.scenes)
        .flat_map(|scene| &scene.shots)
        .filter(|shot| shot.prompt_bundle.is_some())
        .count();

    let mut out = String::new();
    out.push_str(&format!("# 提示词包 · {}\n\n", project.name));
    out.push_str(&format!("- 导出时间：{}\n", now_iso()));
    out.push_str(&format!("- 镜头：共 {total} 镜，已出题 {ready} 镜\n"));
    out.push_str(&format!(
        "- 规格：{} · {} · {}fps\n",
        project.meta.aspect_ratio.as_str(),
        project.meta.resolution,
        project.meta.fps
    ));
    if !project.meta.visual_style.trim().is_empty() {
        out.push_str(&format!("- 风格：{}\n", project.meta.visual_style));
    }
    out.push('\n');

    for episode in &project.episodes {
        out.push_str(&format!("## 第 {} 集 · {}\n\n", episode.no, episode.title));
        for scene in &episode.scenes {
            for shot in &scene.shots {
                write_shot_markdown(&mut out, episode.no, scene.no, shot);
            }
        }
    }
    out
}

fn write_shot_markdown(out: &mut String, episode_no: u32, scene_no: u32, shot: &Shot) {
    out.push_str(&format!(
        "### 第 {episode_no} 集 · 第 {scene_no} 场 · 第 {} 镜\n\n",
        shot.no
    ));
    out.push_str(&format!(
        "- 景别：{} · 运镜：{} · 时长：{:.1}s · 转场：{}\n",
        storyboard::literal(&shot.shot_size),
        storyboard::literal(&shot.camera_move),
        shot.duration_ms as f64 / 1000.0,
        storyboard::literal(&shot.transition),
    ));
    if !shot.characters.is_empty() {
        out.push_str(&format!("- 出场角色：{}\n", shot.characters.join("、")));
    }
    if !shot.visual_desc.trim().is_empty() {
        out.push_str(&format!("- 画面：{}\n", shot.visual_desc.trim()));
    }
    if let Some(text) = text_of(&shot.dialogue) {
        out.push_str(&format!("- 台词：{text}\n"));
    }
    if let Some(text) = text_of(&shot.narration) {
        out.push_str(&format!("- 旁白：{text}\n"));
    }
    if !shot.sfx_hint.trim().is_empty() {
        out.push_str(&format!("- 音效：{}\n", shot.sfx_hint.trim()));
    }
    if !shot.note.trim().is_empty() {
        out.push_str(&format!("- 备注：{}\n", shot.note.trim()));
    }
    out.push('\n');

    let Some(bundle) = &shot.prompt_bundle else {
        out.push_str("> 尚未出题。\n\n");
        return;
    };

    push_code_block(out, "中文提示词", &bundle.zh);
    push_code_block(out, "English prompt", &bundle.en);

    let unified = &bundle.unified;
    let sections = [
        ("主体", &unified.subject),
        ("环境", &unified.environment),
        ("镜头", &unified.camera),
        ("光线", &unified.lighting),
        ("风格", &unified.style),
        ("画质", &unified.quality),
    ];
    let mut wrote_header = false;
    for (label, value) in sections {
        if value.trim().is_empty() {
            continue;
        }
        if !wrote_header {
            out.push_str("**结构拆解**\n\n");
            wrote_header = true;
        }
        out.push_str(&format!("- {label}：{}\n", value.trim()));
    }
    if wrote_header {
        out.push('\n');
    }

    let params = &bundle.params;
    out.push_str("**参数**\n\n");
    out.push_str(&format!(
        "- 时长：{}ms · 画幅：{} · 分辨率：{} · 帧率：{}fps · 运动强度：{}\n",
        params.duration_ms,
        params.aspect_ratio.as_str(),
        params.resolution,
        params.fps,
        params.motion_strength,
    ));
    if let Some(seed) = params.seed {
        out.push_str(&format!("- 随机种子：{seed}（同种子可复现同一版画面）\n"));
    }
    if !params.negative_prompt.trim().is_empty() {
        out.push_str(&format!(
            "- 负向提示词：{}\n",
            params.negative_prompt.trim()
        ));
    }
    if !params.ref_images.is_empty() {
        let refs: Vec<String> = params
            .ref_images
            .iter()
            .map(|image| {
                let (path, weight) = (&image.path, image.weight);
                format!("{path}（权重 {weight}）")
            })
            .collect();
        out.push_str(&format!("- 参考图：{}\n", refs.join("、")));
    }
    if let Some(first) = text_of(&params.first_frame) {
        out.push_str(&format!("- 首帧：{first}\n"));
    }
    if let Some(last) = text_of(&params.last_frame) {
        out.push_str(&format!("- 尾帧：{last}\n"));
    }
    out.push('\n');

    if bundle.per_provider.is_empty() {
        return;
    }
    out.push_str("**各家请求体**\n\n");
    for (provider, body) in &bundle.per_provider {
        let pretty = serde_json::to_string_pretty(body).unwrap_or_else(|_| body.to_string());
        out.push_str(&format!("`{provider}`\n\n```json\n{pretty}\n```\n\n"));
    }
}

fn push_code_block(out: &mut String, title: &str, body: &str) {
    out.push_str(&format!("**{title}**\n\n```text\n{}\n```\n\n", body.trim()));
}

/// `Option<String>` → 非空文本；空白串视同没有。
fn text_of(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{
        AspectRatio, Episode, Frame, FrameRole, PromptBundle, Scene, Shot, UnifiedPrompt,
        VideoParams, WorkKind,
    };
    use tempfile::TempDir;

    /// 一集一场一镜，且该镜已出题（含中英提示词、参数、可灵请求体）。
    fn ready_project() -> Project {
        let mut project = Project::new("交接测试", WorkKind::ShortDrama);
        let shot = Shot {
            no: 1,
            visual_desc: "女主推开玻璃门".into(),
            duration_ms: 3_000,
            prompt_bundle: Some(PromptBundle {
                unified: UnifiedPrompt {
                    subject: "短发女主".into(),
                    camera: "中景，缓慢推近".into(),
                    ..UnifiedPrompt::default()
                },
                zh: "短发女主推开玻璃门，中景，缓慢推近，冷色调，实拍写实感。".into(),
                en: "A short-haired woman pushes open a glass door, medium shot, slow push-in."
                    .into(),
                params: VideoParams {
                    duration_ms: 5_000,
                    aspect_ratio: AspectRatio::Portrait,
                    resolution: "1080x1920".into(),
                    fps: 30,
                    motion_strength: 0.6,
                    seed: Some(42),
                    negative_prompt: "模糊".into(),
                    ..VideoParams::default()
                },
                per_provider: [(
                    "kling".to_string(),
                    serde_json::json!({ "model": "kling-v1", "duration": 5 }),
                )]
                .into_iter()
                .collect(),
            }),
            ..Shot::default()
        };
        let scene = Scene {
            no: 1,
            shots: vec![shot],
            ..Scene::default()
        };
        project.episodes = vec![Episode {
            no: 1,
            title: "主片".into(),
            scenes: vec![scene],
            ..Episode::new(1, "主片")
        }];
        project
    }

    fn path_of(dir: &TempDir, name: &str) -> String {
        dir.path().join(name).display().to_string()
    }

    #[test]
    fn storyboard_round_trips_through_every_format() {
        let dir = TempDir::new().unwrap();
        let project = ready_project();

        for (format, name) in [
            ("csv", "board.csv"),
            ("json", "board.json"),
            ("xlsx", "board.xlsx"),
            // 大小写不敏感：前端下拉给的是小写，手打大写的路径也该能用。
            ("CSV", "board-upper.csv"),
        ] {
            let dest = path_of(&dir, name);
            let record = export_storyboard(project.clone(), format.into(), dest.clone()).unwrap();
            assert_eq!(record.kind, format.to_ascii_lowercase());
            assert!(Path::new(&dest).is_file(), "{format} 未写出");
            assert!(!record.path.contains('\\'), "导出路径应统一正斜杠");
            assert!(!record.id.is_empty() && !record.created_at.is_empty());

            let outcome = import_storyboard(project.clone(), dest).unwrap();
            assert_eq!(outcome.updated, 1, "{format} 应覆盖 1 镜");
            assert_eq!(outcome.skipped, 0, "{format} 不该有跳过");
            assert_eq!(
                storyboard::rows_from_project(&outcome.project),
                storyboard::rows_from_project(&project),
                "{format} 往返应无损"
            );
        }
    }

    #[test]
    fn unknown_export_format_is_rejected() {
        let dir = TempDir::new().unwrap();
        let error =
            export_storyboard(ready_project(), "pdf".into(), path_of(&dir, "a.pdf")).unwrap_err();
        assert_eq!(error.code(), "validation");
        assert_eq!(
            error.args().get("field").map(String::as_str),
            Some("format")
        );
    }

    #[test]
    fn unsupported_import_extension_is_rejected() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("board.txt");
        fs::write(&source, b"episodeNo,sceneNo,shotNo\n1,1,1\n").unwrap();

        let error = import_storyboard(ready_project(), source.display().to_string()).unwrap_err();
        assert_eq!(error.code(), "validation");
        assert_eq!(
            error.args().get("field").map(String::as_str),
            Some("sourcePath")
        );
    }

    #[test]
    fn missing_import_source_is_not_found() {
        let dir = TempDir::new().unwrap();
        let error = import_storyboard(ready_project(), path_of(&dir, "nope.csv")).unwrap_err();
        assert_eq!(error.code(), "not_found");
    }

    #[test]
    fn params_csv_blanks_every_shot_that_has_no_prompt_yet() {
        let mut project = ready_project();
        project.episodes[0].scenes[0].shots.push(Shot {
            no: 2,
            ..Shot::default()
        });

        let bytes = params_csv(&project).unwrap();
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        assert_eq!(
            reader.headers().unwrap().iter().collect::<Vec<_>>(),
            PARAM_COLUMNS.to_vec()
        );
        let rows: Vec<csv::StringRecord> = reader.records().map(|r| r.unwrap()).collect();
        assert_eq!(rows.len(), 2);

        // 已出题：集/场/镜号 + 全套参数。
        assert_eq!(rows[0].get(0), Some("1"));
        assert_eq!(rows[0].get(3), Some("5000"));
        assert_eq!(rows[0].get(4), Some("9:16"));
        assert_eq!(rows[0].get(7), Some("0.6"));
        assert_eq!(rows[0].get(8), Some("42"));
        // 未出题：只剩定位三列，一眼看出哪几镜还没出题。
        assert_eq!(rows[1].get(2), Some("2"));
        assert!(rows[1].iter().skip(3).all(|cell| cell.is_empty()));
    }

    #[test]
    fn handover_pack_writes_every_expected_file() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();

        let mut project = ready_project();
        let frame_path = "assets/frames/shot-1/kf.png";
        let source = resolve_relative(&root, frame_path).unwrap();
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"png-bytes").unwrap();
        project.episodes[0].scenes[0].shots[0].frames = vec![Frame {
            role: FrameRole::First,
            adopted: Some(frame_path.into()),
            ..Frame::default()
        }];

        let dest = dir.path().join("handover");
        let outcome = export_handover_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
        )
        .unwrap();

        for name in [
            STORYBOARD_CSV,
            STORYBOARD_JSON,
            STORYBOARD_XLSX,
            PROMPTS_MD,
            PARAMS_CSV,
            KEYFRAMES_CSV,
        ] {
            assert!(dest.join(name).is_file(), "{name} 未生成");
            assert!(
                outcome.files.iter().any(|file| file == name),
                "{name} 未登记"
            );
        }

        let copied = dest.join(FRAMES_DIR).join("e1-s1-sh1-first.png");
        assert_eq!(fs::read(&copied).unwrap(), b"png-bytes");

        assert_eq!(outcome.record.kind, "handover");
        assert_eq!(outcome.dir, dest.display().to_string());

        let keyframes = fs::read_to_string(dest.join(KEYFRAMES_CSV)).unwrap();
        assert!(keyframes.contains("adopted"));
        assert!(keyframes.contains("frames/e1-s1-sh1-first.png"));

        let markdown = fs::read_to_string(dest.join(PROMPTS_MD)).unwrap();
        assert!(markdown.contains("短发女主推开玻璃门"));
        assert!(markdown.contains("kling-v1"));
        assert!(markdown.contains("已出题 1 镜"));
    }

    #[test]
    fn handover_pack_reports_a_keyframe_file_that_is_gone() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();

        let mut project = ready_project();
        project.episodes[0].scenes[0].shots[0].frames = vec![Frame {
            role: FrameRole::First,
            adopted: Some("assets/frames/shot-1/gone.png".into()),
            ..Frame::default()
        }];

        let error = export_handover_pack(
            root.display().to_string(),
            project,
            dir.path().join("out").display().to_string(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "not_found");
    }

    #[test]
    fn keyframes_fall_back_to_the_first_candidate() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();

        let mut project = ready_project();
        let frame_path = "assets/frames/shot-1/gen-1-0.jpg";
        let source = resolve_relative(&root, frame_path).unwrap();
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"jpg-bytes").unwrap();
        project.episodes[0].scenes[0].shots[0].frames = vec![Frame {
            role: FrameRole::First,
            candidates: vec![frame_path.into()],
            ..Frame::default()
        }];

        let dest = dir.path().join("handover");
        export_handover_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
        )
        .unwrap();

        // 扩展名沿用源文件，没定稿时记的是候选。
        assert!(dest.join(FRAMES_DIR).join("e1-s1-sh1-first.jpg").is_file());
        let keyframes = fs::read_to_string(dest.join(KEYFRAMES_CSV)).unwrap();
        assert!(keyframes.contains("candidate"));
    }
}

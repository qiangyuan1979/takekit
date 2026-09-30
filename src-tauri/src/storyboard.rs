//! 分镜表：项目 ↔ 扁平表格的双向交换（spec §5.6 产出、plan M6 ⑨）。
//!
//! 交换单元是一行 [`Row`]，13 列与 `project.json` 的镜头字段一一对应。三条约定：
//! 1. 列名 = JSON 键名（camelCase），**枚举写 `project.json` 的原字面量**
//!    （`medium_shot` / `push_in` / `cut`…），不写中文标签——分镜表是交换格式，
//!    写标签会破坏"导出再导入无损"；中文展示是前端的事。
//! 2. 一镜的多个出场角色用 `|` 连接（角色 id 只含字母数字与 `-`/`_`，可无损拆分）。
//! 3. 空单元格 ↔ 无（`dialogue`/`narration` 为空即 `None`）。
//!
//! 本模块只做纯数据搬运，不碰文件系统；读写文件由 `commands::export` 负责。

use crate::error::{AppError, AppResult};
use crate::project::{CameraMove, Project, Shot, ShotSize, Transition};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use rust_xlsxwriter::Workbook;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Cursor;

/// xlsx 里的工作表名；导入时若找不到则回落到第一个工作表（容忍用户改名/另存）。
const XLSX_SHEET: &str = "storyboard";

/// 数值列在 `Row::COLUMNS` 中的下标，写 xlsx 时按数字落格（便于排序/筛选）。
const NUMERIC_COLUMNS: [usize; 4] = [0, 1, 2, 5];

/// 各列在 xlsx 中的显示宽度（仅影响观感，不影响数据）。
const COLUMN_WIDTHS: [f64; 13] = [
    10.0, 8.0, 8.0, 14.0, 14.0, 12.0, 40.0, 18.0, 30.0, 30.0, 16.0, 12.0, 24.0,
];

/// 一镜一行。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Row {
    pub episode_no: u32,
    pub scene_no: u32,
    pub shot_no: u32,
    pub shot_size: String,
    pub camera_move: String,
    pub duration_ms: u64,
    pub visual_desc: String,
    /// 出场角色 id，用 `|` 连接。
    pub characters: String,
    pub dialogue: String,
    pub narration: String,
    pub sfx_hint: String,
    pub transition: String,
    pub note: String,
}

impl Row {
    /// 列顺序的唯一定义；CSV 表头与 xlsx 首行都用它。
    pub const COLUMNS: [&'static str; 13] = [
        "episodeNo",
        "sceneNo",
        "shotNo",
        "shotSize",
        "cameraMove",
        "durationMs",
        "visualDesc",
        "characters",
        "dialogue",
        "narration",
        "sfxHint",
        "transition",
        "note",
    ];

    /// 按 `COLUMNS` 顺序摊平成单元格文本。
    fn cells(&self) -> [String; 13] {
        [
            self.episode_no.to_string(),
            self.scene_no.to_string(),
            self.shot_no.to_string(),
            self.shot_size.clone(),
            self.camera_move.clone(),
            self.duration_ms.to_string(),
            self.visual_desc.clone(),
            self.characters.clone(),
            self.dialogue.clone(),
            self.narration.clone(),
            self.sfx_hint.clone(),
            self.transition.clone(),
            self.note.clone(),
        ]
    }
}

/// 导入结果：命中并覆盖的镜数 / 因定位不到或枚举非法而跳过的行数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub updated: usize,
    pub skipped: usize,
}

// ---------- 导出：项目 → 行 ----------

/// 把项目里所有集/场/镜按顺序摊平成行。
pub fn rows_from_project(project: &Project) -> Vec<Row> {
    let mut rows = Vec::new();
    for episode in &project.episodes {
        for scene in &episode.scenes {
            for shot in &scene.shots {
                rows.push(Row {
                    episode_no: episode.no,
                    scene_no: scene.no,
                    shot_no: shot.no,
                    shot_size: literal(&shot.shot_size),
                    camera_move: literal(&shot.camera_move),
                    duration_ms: shot.duration_ms,
                    visual_desc: shot.visual_desc.clone(),
                    characters: shot.characters.join("|"),
                    dialogue: shot.dialogue.clone().unwrap_or_default(),
                    narration: shot.narration.clone().unwrap_or_default(),
                    sfx_hint: shot.sfx_hint.clone(),
                    transition: literal(&shot.transition),
                    note: shot.note.clone(),
                });
            }
        }
    }
    rows
}

// ---------- 导入：行 → 项目 ----------

/// 按 `(集号, 场号, 镜号)` 覆盖镜头字段；定位不到或枚举非法则计入 `skipped`。
///
/// 只覆盖分镜字段：`id` / `frames` / `promptBundle` / `adoptedClipId` 一律不动，
/// 否则一次导入就会把关键帧与已出好的题连同 id 一起冲掉。
pub fn apply_rows(project: &mut Project, rows: &[Row]) -> ImportStats {
    let mut stats = ImportStats::default();
    for row in rows {
        let Some(shot) = find_shot_mut(project, row.episode_no, row.scene_no, row.shot_no) else {
            stats.skipped += 1;
            continue;
        };
        let (Ok(shot_size), Ok(camera_move), Ok(transition)) = (
            parse_literal::<ShotSize>(&row.shot_size, "shotSize"),
            parse_literal::<CameraMove>(&row.camera_move, "cameraMove"),
            parse_literal::<Transition>(&row.transition, "transition"),
        ) else {
            stats.skipped += 1;
            continue;
        };

        shot.shot_size = shot_size;
        shot.camera_move = camera_move;
        shot.duration_ms = row.duration_ms;
        shot.visual_desc = row.visual_desc.clone();
        shot.characters = split_characters(&row.characters);
        shot.dialogue = optional(&row.dialogue);
        shot.narration = optional(&row.narration);
        shot.sfx_hint = row.sfx_hint.clone();
        shot.transition = transition;
        shot.note = row.note.clone();
        stats.updated += 1;
    }
    stats
}

fn find_shot_mut(
    project: &mut Project,
    episode_no: u32,
    scene_no: u32,
    shot_no: u32,
) -> Option<&mut Shot> {
    project
        .episodes
        .iter_mut()
        .find(|episode| episode.no == episode_no)?
        .scenes
        .iter_mut()
        .find(|scene| scene.no == scene_no)?
        .shots
        .iter_mut()
        .find(|shot| shot.no == shot_no)
}

// ---------- CSV ----------

pub fn to_csv(rows: &[Row]) -> AppResult<Vec<u8>> {
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer.write_record(Row::COLUMNS).map_err(csv_error)?;
    for row in rows {
        writer.write_record(row.cells()).map_err(csv_error)?;
    }
    writer
        .into_inner()
        .map_err(|e| AppError::Internal(format!("csv: {e}")))
}

pub fn from_csv(bytes: &[u8]) -> AppResult<Vec<Row>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(bytes);
    let headers = collect_headers(reader.headers().map_err(csv_error)?);
    let index = column_index(&headers)?;

    let mut rows = Vec::new();
    for (offset, record) in reader.records().enumerate() {
        let record = record.map_err(csv_error)?;
        let values: Vec<String> = record.iter().map(str::to_string).collect();
        rows.push(row_from_cells(&index, &values, offset + 2)?);
    }
    Ok(rows)
}

// ---------- JSON ----------

pub fn to_json(rows: &[Row]) -> AppResult<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(rows)?)
}

pub fn from_json(bytes: &[u8]) -> AppResult<Vec<Row>> {
    serde_json::from_slice(bytes).map_err(|e| AppError::Validation {
        field: "sourcePath".into(),
        detail: format!("不是合法的分镜 JSON：{e}"),
    })
}

// ---------- xlsx ----------

pub fn to_xlsx(rows: &[Row]) -> AppResult<Vec<u8>> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name(XLSX_SHEET).map_err(xlsx_error)?;

    for (col, width) in COLUMN_WIDTHS.iter().enumerate() {
        sheet
            .set_column_width(col as u16, *width)
            .map_err(xlsx_error)?;
    }
    for (col, name) in Row::COLUMNS.iter().enumerate() {
        sheet
            .write_string(0, col as u16, *name)
            .map_err(xlsx_error)?;
    }

    for (offset, row) in rows.iter().enumerate() {
        // 第 0 行是表头，数据从第 1 行开始。
        let line = offset as u32 + 1;
        sheet
            .write_number(line, 0, row.episode_no as f64)
            .map_err(xlsx_error)?;
        sheet
            .write_number(line, 1, row.scene_no as f64)
            .map_err(xlsx_error)?;
        sheet
            .write_number(line, 2, row.shot_no as f64)
            .map_err(xlsx_error)?;
        sheet
            .write_number(line, 5, row.duration_ms as f64)
            .map_err(xlsx_error)?;

        for (col, value) in row.cells().iter().enumerate() {
            if NUMERIC_COLUMNS.contains(&col) {
                continue;
            }
            sheet
                .write_string(line, col as u16, value.as_str())
                .map_err(xlsx_error)?;
        }
    }

    workbook.save_to_buffer().map_err(xlsx_error)
}

pub fn from_xlsx(bytes: &[u8]) -> AppResult<Vec<Row>> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut workbook = open_workbook_auto_from_rs(cursor).map_err(sheet_error)?;

    // 优先读同名工作表；用户改名或另存后回落第一个工作表。
    let names = workbook.sheet_names();
    let sheet_name = names
        .iter()
        .find(|name| name.as_str() == XLSX_SHEET)
        .or_else(|| names.first())
        .cloned()
        .ok_or_else(|| AppError::Validation {
            field: "sourcePath".into(),
            detail: "表格里没有工作表".into(),
        })?;

    let range = workbook.worksheet_range(&sheet_name).map_err(sheet_error)?;
    let mut iter = range.rows();
    let header_row = iter.next().ok_or_else(|| AppError::Validation {
        field: "header".into(),
        detail: "表格为空".into(),
    })?;
    let headers: Vec<String> = header_row.iter().map(cell_to_string).collect();
    let index = column_index(&headers)?;

    let mut rows = Vec::new();
    for (offset, record) in iter.enumerate() {
        let values: Vec<String> = record.iter().map(cell_to_string).collect();
        // 跳过全空行：Excel 保存后常有尾部空行，不该被当成数据。
        if values.iter().all(|value| value.trim().is_empty()) {
            continue;
        }
        rows.push(row_from_cells(&index, &values, offset + 2)?);
    }
    Ok(rows)
}

// ---------- 表格通用助手 ----------

/// 表头名 → 列下标；只认 `Row::COLUMNS` 里的列，容忍列重排与多余列。
fn column_index(headers: &[String]) -> AppResult<HashMap<&'static str, usize>> {
    let mut index = HashMap::new();
    for (position, header) in headers.iter().enumerate() {
        let name = header.trim();
        if let Some(known) = Row::COLUMNS.iter().find(|column| **column == name) {
            index.entry(*known).or_insert(position);
        }
    }
    if index.is_empty() {
        return Err(AppError::Validation {
            field: "header".into(),
            detail: format!("不是分镜表：表头缺少 {} 等已知列", Row::COLUMNS.join("/")),
        });
    }
    Ok(index)
}

/// 一行单元格 → [`Row`]；缺失的列按空处理（与 `#[serde(default)]` 一致）。
fn row_from_cells(
    index: &HashMap<&'static str, usize>,
    values: &[String],
    line: usize,
) -> AppResult<Row> {
    let cell = |name: &'static str| -> String {
        index
            .get(name)
            .and_then(|position| values.get(*position))
            .cloned()
            .unwrap_or_default()
    };

    Ok(Row {
        episode_no: parse_number(&cell("episodeNo"), "episodeNo", line)?,
        scene_no: parse_number(&cell("sceneNo"), "sceneNo", line)?,
        shot_no: parse_number(&cell("shotNo"), "shotNo", line)?,
        shot_size: cell("shotSize").trim().to_string(),
        camera_move: cell("cameraMove").trim().to_string(),
        duration_ms: parse_number(&cell("durationMs"), "durationMs", line)?,
        visual_desc: cell("visualDesc"),
        characters: cell("characters"),
        dialogue: cell("dialogue"),
        narration: cell("narration"),
        sfx_hint: cell("sfxHint"),
        transition: cell("transition").trim().to_string(),
        note: cell("note"),
    })
}

fn collect_headers(record: &csv::StringRecord) -> Vec<String> {
    record.iter().map(str::to_string).collect()
}

/// 枚举 → `project.json` 原字面量（走 serde，保证与迁移/前端完全一致）。
/// 交接包里的提示词包也要按同一口径写枚举取值，故对 `commands::export` 开放。
pub(crate) fn literal<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(text)) => text,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

/// 字面量 → 枚举；空白与未知取值都算非法（由调用方决定是否跳过该行）。
fn parse_literal<T: DeserializeOwned>(raw: &str, field: &str) -> AppResult<T> {
    serde_json::from_value::<T>(Value::String(raw.trim().to_string())).map_err(|_| {
        AppError::Validation {
            field: field.into(),
            detail: format!("无法识别的取值：{raw:?}"),
        }
    })
}

fn parse_number<T: std::str::FromStr>(raw: &str, field: &str, line: usize) -> AppResult<T> {
    raw.trim().parse::<T>().map_err(|_| AppError::Validation {
        field: field.into(),
        detail: format!("第 {line} 行「{field}」不是有效数字：{raw:?}"),
    })
}

/// `a|b|c` → `["a", "b", "c"]`；去空白、丢空项。
fn split_characters(raw: &str) -> Vec<String> {
    raw.split('|')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

/// 空串（含纯空白）视同无；非空值原样保留（不 trim，保持往返无损）。
fn optional(raw: &str) -> Option<String> {
    if raw.trim().is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// 任意单元格 → 文本；数值整数化，避免 `3000` 变 `3000.0`。
fn cell_to_string(data: &Data) -> String {
    match data {
        Data::Int(value) => value.to_string(),
        Data::Float(value) => {
            if value.fract() == 0.0 {
                (*value as i64).to_string()
            } else {
                value.to_string()
            }
        }
        Data::String(text) => text.clone(),
        Data::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

pub(crate) fn csv_error(err: csv::Error) -> AppError {
    AppError::Internal(format!("csv: {err}"))
}

fn xlsx_error(err: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::Internal(format!("xlsx: {err}"))
}

fn sheet_error(err: calamine::Error) -> AppError {
    AppError::Validation {
        field: "sourcePath".into(),
        detail: format!("无法读取表格：{err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Episode, PromptBundle, Scene, WorkKind};

    /// 一集一场一镜的最小项目，字段都非默认值，便于验证往返。
    fn sample_project() -> Project {
        let mut project = Project::new("测试", WorkKind::ShortDrama);

        let shot = Shot {
            no: 1,
            shot_size: ShotSize::CloseUp,
            camera_move: CameraMove::PushIn,
            duration_ms: 3_000,
            visual_desc: "女主推开玻璃门".into(),
            characters: vec!["c-lin".into(), "c-gu".into()],
            dialogue: Some("你敢吗？".into()),
            narration: None,
            sfx_hint: "玻璃门吱呀".into(),
            transition: Transition::Cut,
            note: "注意门反光".into(),
            ..Shot::default()
        };
        let scene = Scene {
            no: 1,
            shots: vec![shot],
            ..Scene::default()
        };
        let episode = Episode {
            no: 1,
            title: "主片".into(),
            scenes: vec![scene],
            ..Episode::new(1, "主片")
        };
        project.episodes = vec![episode];
        project
    }

    #[test]
    fn columns_match_serde_field_names() {
        // COLUMNS 是给用户看的表头，也是读表时的匹配键；与 serde 字段名漂移就会读不回来。
        let value = serde_json::to_value(Row::default()).expect("serialize row");
        let mut keys: Vec<String> = value
            .as_object()
            .expect("row is an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();

        let mut columns: Vec<String> = Row::COLUMNS.iter().map(|c| c.to_string()).collect();
        columns.sort();
        assert_eq!(columns, keys);
    }

    #[test]
    fn every_column_has_a_width() {
        assert_eq!(Row::COLUMNS.len(), COLUMN_WIDTHS.len());
    }

    #[test]
    fn csv_round_trip_is_lossless() {
        let rows = rows_from_project(&sample_project());
        assert_eq!(rows.len(), 1);

        let bytes = to_csv(&rows).expect("write csv");
        let back = from_csv(&bytes).expect("read csv");
        assert_eq!(back, rows);
    }

    #[test]
    fn csv_import_can_overwrite_storyboard_fields() {
        let rows =
            from_csv(&to_csv(&rows_from_project(&sample_project())).expect("write")).expect("read");
        let mut project = sample_project();
        let stats = apply_rows(&mut project, &rows);
        assert_eq!(
            stats,
            ImportStats {
                updated: 1,
                skipped: 0
            }
        );
        assert_eq!(
            rows_from_project(&project),
            rows_from_project(&sample_project())
        );
    }

    #[test]
    fn json_round_trip_is_lossless() {
        let rows = rows_from_project(&sample_project());
        let bytes = to_json(&rows).expect("write json");
        assert_eq!(from_json(&bytes).expect("read json"), rows);
    }

    #[test]
    fn xlsx_round_trip_is_lossless() {
        let rows = rows_from_project(&sample_project());
        let bytes = to_xlsx(&rows).expect("write xlsx");
        assert_eq!(from_xlsx(&bytes).expect("read xlsx"), rows);
    }

    #[test]
    fn apply_rows_overwrites_and_reports_skipped() {
        let mut project = sample_project();
        let mut rows = rows_from_project(&project);
        rows[0].visual_desc = "改过的描述".into();
        rows[0].duration_ms = 5_000;

        // 定位不到：没有第 9 集。
        let mut missing = rows[0].clone();
        missing.episode_no = 9;
        // 枚举非法：不是 ShotSize 的字面量。
        let mut illegal = rows[0].clone();
        illegal.shot_size = "gigantic".into();
        rows.push(missing);
        rows.push(illegal);

        let stats = apply_rows(&mut project, &rows);
        assert_eq!(
            stats,
            ImportStats {
                updated: 1,
                skipped: 2
            }
        );
        let shot = &project.episodes[0].scenes[0].shots[0];
        assert_eq!(shot.visual_desc, "改过的描述");
        assert_eq!(shot.duration_ms, 5_000);
    }

    #[test]
    fn apply_rows_leaves_id_and_prompt_bundle_untouched() {
        let mut project = sample_project();
        project.episodes[0].scenes[0].shots[0].id = "fixed-id".into();
        project.episodes[0].scenes[0].shots[0].prompt_bundle = Some(PromptBundle {
            zh: "已有题".into(),
            ..PromptBundle::default()
        });

        let mut rows = rows_from_project(&project);
        rows[0].note = "新备注".into();
        apply_rows(&mut project, &rows);

        let shot = &project.episodes[0].scenes[0].shots[0];
        assert_eq!(shot.id, "fixed-id");
        assert_eq!(
            shot.prompt_bundle.as_ref().map(|bundle| bundle.zh.as_str()),
            Some("已有题")
        );
        assert_eq!(shot.note, "新备注");
    }

    #[test]
    fn non_storyboard_table_is_rejected() {
        let err = from_csv(b"a,b,c\n1,2,3\n").expect_err("非分镜表应被拒绝");
        assert_eq!(err.code(), "validation");
    }

    #[test]
    fn blank_optional_cells_become_none() {
        assert_eq!(optional(""), None);
        assert_eq!(optional("   "), None);
        assert_eq!(optional(" 留白 "), Some(" 留白 ".into()));
    }

    #[test]
    fn characters_split_on_pipe_and_drop_blanks() {
        assert_eq!(
            split_characters("c-lin|c-gu"),
            vec!["c-lin".to_string(), "c-gu".to_string()]
        );
        assert_eq!(split_characters(""), Vec::<String>::new());
        assert_eq!(
            split_characters("a|| b "),
            vec!["a".to_string(), "b".to_string()]
        );
    }
}

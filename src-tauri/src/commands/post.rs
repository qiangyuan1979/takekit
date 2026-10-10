//! 后期出片命令（spec §5.8 的「产出」，plan M9）。
//!
//! 应用自身不调用 ffmpeg（跨平台二进制体积与网络下载风险），而是把
//! 「片段轨 / 配音轨 / 字幕轨 / BGM 轨」落成一个能整体拷走的剪辑工程包：
//! 结构化时间线 + 软字幕 / 样式字幕 + 素材清单 + 一键渲染脚本。
//!
//! 三条约定，与 `commands::export` 保持一致：
//! 1. 导出不改项目——包里的内容全部由传入的 `project` 派生，命令只写文件。
//! 2. 写进 [`ExportRecord`] 的路径一律正斜杠。
//! 3. 先验完整性再落盘：时间线为空或引用的素材已丢失，就整个不导出，
//!    免得留下一个"看着齐、其实放不出片"的目录。
//!
//! 默认不复制媒体：片段动辄上百 MB，复制既慢又占地。脚本按 `ROOT`（导出时的项目根）
//! 去找素材，`materials.csv` 供换台机器时按清单放回原位。需要「整包搬走」时可以
//! 打开 `self_contained`：把被引用的媒体复制进包内 `media/`，脚本改用包内相对路径。

use crate::commands::asset::{extension_of, resolve_relative};
use crate::commands::project::resolve_project_path;
use crate::error::{AppError, AppResult};
use crate::project::{
    new_id, now_iso, BgmTrack, ExportRecord, LipsyncCue, Project, SfxCue, SubtitleCue,
    SubtitleStyle, TimelineClip, Transition, VoiceLine,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 工程包内各文件的固定名字。
const TIMELINE_JSON: &str = "timeline.json";
const SUBTITLES_SRT: &str = "subtitles.srt";
const SUBTITLES_ASS: &str = "subtitles.ass";
const SUBTITLES_VTT: &str = "subtitles.vtt";
const SCRIPT_LINES: &str = "lines.txt";
const TIMELINE_EDL: &str = "timeline.edl";
const MATERIALS_CSV: &str = "materials.csv";
const RENDER_SH: &str = "render.sh";
const RENDER_BAT: &str = "render.bat";
const RENDER_STEMS_SH: &str = "render_stems.sh";
const RENDER_STEMS_BAT: &str = "render_stems.bat";
const MANIFEST_JSON: &str = "manifest.json";
const README_TXT: &str = "README.txt";

/// 自带媒体时，包内媒体目录与分轨音频名字。
const MEDIA_DIR: &str = "media";
const STEM_VOICE: &str = "stems_voice.wav";
const STEM_BGM: &str = "stems_bgm.wav";
const STEM_SFX: &str = "stems_sfx.wav";
const STEM_NOVOICE: &str = "stems_novoice.wav";

/// 脚本渲染出的成片名。
const OUTPUT_MP4: &str = "out.mp4";

/// 素材清单的列。
const MATERIAL_COLUMNS: [&str; 4] = ["kind", "shotNo", "path", "note"];

/// 淡入 / 淡出时长（秒）。应用不做复杂特效，转场只到这一档。
const FADE_SECS: f64 = 0.3;

/// 音频归一化链的前半段；所有音频输入都先统一到 48kHz 立体声 fltp。
const AFORMAT: &str = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/// 对白闪避参数：人声一过阈值就按固定比例压低 BGM。
const SIDECHAIN: &str = "sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400";

/// 剪辑工程包产物：目录、导出记录、包内相对文件清单。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPackOutcome {
    pub dir: String,
    pub record: ExportRecord,
    pub files: Vec<String>,
}

/// 导出剪辑工程包的可选项；字段缺省时按 [`Default`] 补齐。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PostPackOptions {
    /// 把被引用的媒体复制进包内 `media/`，使整包可搬走（默认关：复制重）。
    pub self_contained: bool,
    /// 额外输出 `subtitles.vtt`。
    pub webvtt: bool,
    /// 额外输出纯文本台词本 `lines.txt`。
    pub script_lines: bool,
    /// 额外输出剪辑软件交换文件 `timeline.edl`（CMX3600）。
    pub edl: bool,
    /// 额外输出分轨渲染脚本 `render_stems.sh` / `render_stems.bat`。
    pub stems: bool,
}

impl Default for PostPackOptions {
    fn default() -> Self {
        Self {
            self_contained: false,
            webvtt: true,
            script_lines: true,
            edl: true,
            stems: true,
        }
    }
}

// ---------- 命令 ----------

/// 导出剪辑工程包：时间线 JSON + 字幕（SRT / ASS / VTT）+ 素材清单 + 一键渲染脚本。
///
/// `options` 控制可选增强：自带媒体、额外文本格式、EDL 交换文件、分轨渲染脚本。
/// 返回本次导出记录，由调用方追加进 `project.exports`——命令层不替项目做主。
#[tauri::command]
pub fn export_post_pack(
    project_path: String,
    project: Project,
    dest_dir: String,
    options: Option<PostPackOptions>,
) -> AppResult<PostPackOutcome> {
    let options = options.unwrap_or_default();

    if project.post.timeline.is_empty() {
        return Err(AppError::Validation {
            field: "post".into(),
            detail: "时间线为空：请先在第 7 步采用片段".into(),
        });
    }

    let root = resolve_project_path(&project_path)?.0;
    // 先验完整性：所有被引用的媒体文件必须还在（缺一个就整个不导出）。
    let plan = build_plan(&root, &project)?;

    let dest = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dest)?;

    let (width, height) = plan_dims(&project);
    let fps = if project.meta.fps == 0 {
        30
    } else {
        project.meta.fps
    };
    let total_ms = timeline_duration_ms(&project.post.timeline);
    let created_at = now_iso();

    // 安排输入；自带媒体时顺带登记要复制进包内的文件。
    let mut media = MediaMap::new(&root, options.self_contained);
    let inputs = plan_inputs(&project, &plan, &mut media)?;
    let materials = materials_csv(&project, &plan, &mut media)?;

    let kinds: Vec<InputKind> = inputs.iter().map(|input| input.kind.clone()).collect();
    let burn_in = project.post.subtitle_style.burn_in;
    let enabled_subs: Vec<SubtitleCue> = project
        .post
        .subtitles
        .iter()
        .filter(|cue| cue.enabled)
        .cloned()
        .collect();
    let has_subtitles = !enabled_subs.is_empty();
    let ducking = project.post.bgm.as_ref().is_some_and(|bgm| bgm.ducking);
    let (graph, has_audio) = filter_graph(
        &kinds,
        width,
        height,
        fps,
        burn_in && has_subtitles,
        ducking,
    );
    let stems = if options.stems && has_audio {
        stem_graphs(&kinds, ducking)
    } else {
        Vec::new()
    };

    let mut files = Vec::new();

    // 自带媒体：把被引用的文件复制进包内 media/。
    for copy in &media.copies {
        copy_file(&dest.join(&copy.target), &copy.source)?;
        files.push(copy.target.clone());
    }

    let doc = TimelineDoc {
        project: project.name.clone(),
        created_at: created_at.clone(),
        preset: project.post.export_preset.clone(),
        width,
        height,
        fps,
        total_ms,
        clips: project.post.timeline.clone(),
        voice_lines: plan
            .voice_refs
            .iter()
            .map(|voice| voice.line.clone())
            .collect(),
        subtitles: project.post.subtitles.clone(),
        subtitle_style: project.post.subtitle_style.clone(),
        bgm: plan.bgm.clone(),
        sfx: plan.sfx.clone(),
        lipsync: project.post.lipsync.clone(),
        pending_voice_lines: plan.pending.clone(),
    };

    let parts: [(&str, Vec<u8>); 4] = [
        (TIMELINE_JSON, serde_json::to_vec_pretty(&doc)?),
        (SUBTITLES_SRT, build_srt(&enabled_subs).into_bytes()),
        (
            SUBTITLES_ASS,
            build_ass(&enabled_subs, &project.post.subtitle_style, width, height).into_bytes(),
        ),
        (MATERIALS_CSV, materials),
    ];
    for (name, bytes) in parts {
        write_file(&dest.join(name), &bytes)?;
        files.push(name.to_string());
    }

    if options.webvtt {
        write_file(
            &dest.join(SUBTITLES_VTT),
            build_vtt(&enabled_subs).as_bytes(),
        )?;
        files.push(SUBTITLES_VTT.to_string());
    }
    if options.script_lines {
        write_file(
            &dest.join(SCRIPT_LINES),
            build_lines(&project, &created_at, &enabled_subs).as_bytes(),
        )?;
        files.push(SCRIPT_LINES.to_string());
    }
    if options.edl {
        write_file(
            &dest.join(TIMELINE_EDL),
            build_edl(&project, fps).as_bytes(),
        )?;
        files.push(TIMELINE_EDL.to_string());
    }

    let command = ffmpeg_command(ScriptStyle::Sh, &inputs, has_audio, fps, total_ms);
    write_file(
        &dest.join(RENDER_SH),
        render_sh(&root, &command, &graph).as_bytes(),
    )?;
    files.push(RENDER_SH.to_string());

    let command = ffmpeg_command(ScriptStyle::Bat, &inputs, has_audio, fps, total_ms);
    write_file(
        &dest.join(RENDER_BAT),
        render_bat(&root, &command, &graph).as_bytes(),
    )?;
    files.push(RENDER_BAT.to_string());

    if !stems.is_empty() {
        write_file(
            &dest.join(RENDER_STEMS_SH),
            render_stems_sh(&root, &inputs, &stems, total_ms).as_bytes(),
        )?;
        files.push(RENDER_STEMS_SH.to_string());
        write_file(
            &dest.join(RENDER_STEMS_BAT),
            render_stems_bat(&root, &inputs, &stems, total_ms).as_bytes(),
        )?;
        files.push(RENDER_STEMS_BAT.to_string());
    }

    // manifest 与说明文件也列入清单（在写 manifest 之前先登记好名字）。
    files.push(MANIFEST_JSON.to_string());
    files.push(README_TXT.to_string());

    let manifest = Manifest {
        project: project.name.clone(),
        created_at: created_at.clone(),
        preset: project.post.export_preset.clone(),
        width,
        height,
        fps,
        total_ms,
        clip_count: project.post.timeline.len(),
        voice_line_count: plan.voice_refs.len(),
        subtitle_count: enabled_subs.len(),
        sfx_count: plan.sfx.len(),
        lipsync_enabled: project
            .post
            .lipsync
            .iter()
            .filter(|cue| cue.enabled)
            .count(),
        burn_in: burn_in && has_subtitles,
        self_contained: options.self_contained,
        output: OUTPUT_MP4.to_string(),
        files: files.clone(),
        pending_voice_lines: plan.pending.clone(),
    };
    write_file(
        &dest.join(MANIFEST_JSON),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;

    write_file(
        &dest.join(README_TXT),
        readme(&project, &manifest, &root).as_bytes(),
    )?;

    Ok(PostPackOutcome {
        dir: dest.display().to_string(),
        record: record("post", &dest),
        files,
    })
}

// ---------- 完整性校验与导出计划 ----------

/// 一条被采用的配音句：音频 + 它在时间线上的起点。
#[derive(Debug, Clone)]
struct VoiceRef {
    line: VoiceLine,
    start_ms: u64,
}

/// 本次导出的媒体引用计划；`pending` 是还没生成音频的句子。
struct PostPlan {
    voice_refs: Vec<VoiceRef>,
    bgm: Option<BgmTrack>,
    sfx: Vec<SfxCue>,
    pending: Vec<String>,
}

/// 汇总要写进脚本的媒体，并逐一确认它们还在磁盘上。
///
/// 只收「在时间线里的镜头」的配音——没有采用片段的镜头即便有配音也放不进片，
/// 硬塞进去只会在 0 秒处冒出一句没有画面的声音。
fn build_plan(root: &Path, project: &Project) -> AppResult<PostPlan> {
    let mut shot_ids: HashSet<&str> = HashSet::new();
    for clip in &project.post.timeline {
        ensure_file(root, &clip.clip_path)?;
        shot_ids.insert(clip.shot_id.as_str());
    }

    // 配音起点取自字幕（由配音句派生，同一句一一对应）。
    let starts: std::collections::HashMap<&str, u64> = project
        .post
        .subtitles
        .iter()
        .filter(|cue| !cue.voice_line_id.is_empty())
        .map(|cue| (cue.voice_line_id.as_str(), cue.start_ms))
        .collect();

    let mut voice_refs = Vec::new();
    let mut pending = Vec::new();
    for line in &project.post.voice_lines {
        if !shot_ids.contains(line.shot_id.as_str()) {
            continue;
        }
        match text_of(&line.audio_path) {
            Some(path) => {
                ensure_file(root, path)?;
                voice_refs.push(VoiceRef {
                    line: line.clone(),
                    start_ms: starts.get(line.id.as_str()).copied().unwrap_or(0),
                });
            }
            None => {
                if !line.text.trim().is_empty() {
                    pending.push(line.text.trim().to_string());
                }
            }
        }
    }

    let bgm = match &project.post.bgm {
        Some(track) => match text_of_some(&track.path) {
            Some(path) => {
                ensure_file(root, path)?;
                Some(track.clone())
            }
            None => None,
        },
        None => None,
    };

    let mut sfx = Vec::new();
    for cue in &project.post.sfx {
        match text_of_some(&cue.path) {
            Some(path) => {
                ensure_file(root, path)?;
                sfx.push(cue.clone());
            }
            None => {}
        }
    }

    Ok(PostPlan {
        voice_refs,
        bgm,
        sfx,
        pending,
    })
}

/// 素材引用可以是项目相对路径（项目内产物）或绝对路径（素材库条目）。
fn resolve_media(root: &Path, raw: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        Ok(candidate.to_path_buf())
    } else {
        resolve_relative(root, raw)
    }
}

/// 确认引用还在；不在就报 `not_found`（路径原样回传，前端能指着它说话）。
fn ensure_file(root: &Path, raw: &str) -> AppResult<()> {
    let path = resolve_media(root, raw)?;
    if path.is_file() {
        Ok(())
    } else {
        Err(AppError::NotFound {
            path: raw.to_string(),
        })
    }
}

// ---------- 尺寸与预设 ----------

/// 成片尺寸：预设优先，退回合立项分辨率，再兜底竖屏。
fn plan_dims(project: &Project) -> (u32, u32) {
    if let Some((width, height)) = preset_dims(&project.post.export_preset) {
        return (width, height);
    }
    if let Some((width, height)) = parse_resolution(&project.meta.resolution) {
        return (even(width), even(height));
    }
    (1080, 1920)
}

/// 导出预设 → 平台标准尺寸（与前端 `postOps.EXPORT_PRESETS` 一一对应）。
fn preset_dims(preset: &str) -> Option<(u32, u32)> {
    match preset.trim() {
        "douyin" | "kuaishou" | "shipinhao" => Some((1080, 1920)),
        "bilibili" | "youtube" => Some((1920, 1080)),
        _ => None,
    }
}

/// 解析 `1080x1920` / `1920X1080` / `1080*1920` 形式的分辨率。
fn parse_resolution(text: &str) -> Option<(u32, u32)> {
    let (width, height) = text
        .trim()
        .split_once(|c: char| c == 'x' || c == 'X' || c == '*' || c == '×')?;
    let width: u32 = width.trim().parse().ok()?;
    let height: u32 = height.trim().parse().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

/// libx264 要求宽高为偶数。
fn even(value: u32) -> u32 {
    if value < 2 {
        2
    } else if value % 2 == 0 {
        value
    } else {
        value - 1
    }
}

/// 时间线总时长 = 最靠后的片段结束点。
fn timeline_duration_ms(timeline: &[TimelineClip]) -> u64 {
    timeline
        .iter()
        .map(|clip| clip.start_ms + clip.duration_ms)
        .max()
        .unwrap_or(0)
}

// ---------- 字幕 ----------

/// SRT 软字幕；只出启用句，文本里的换行压成空格（SRT 用空行分隔条目）。
fn build_srt(cues: &[SubtitleCue]) -> String {
    let mut out = String::new();
    for (index, cue) in cues.iter().enumerate() {
        out.push_str(&format!("{}\n", index + 1));
        out.push_str(&format!(
            "{} --> {}\n",
            srt_time(cue.start_ms),
            srt_time(cue.end_ms)
        ));
        out.push_str(&one_line(&cue.text));
        out.push_str("\n\n");
    }
    out
}

/// WebVTT 软字幕：内容与 SRT 一致，时间戳用 `.` 分隔毫秒。
fn build_vtt(cues: &[SubtitleCue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (index, cue) in cues.iter().enumerate() {
        out.push_str(&format!("{}\n", index + 1));
        out.push_str(&format!(
            "{} --> {}\n",
            srt_time(cue.start_ms).replace(',', "."),
            srt_time(cue.end_ms).replace(',', ".")
        ));
        out.push_str(&one_line(&cue.text));
        out.push_str("\n\n");
    }
    out
}

/// 纯文本台词本：按镜头列台词/旁白与时间，方便配音或念稿。
fn build_lines(project: &Project, created_at: &str, cues: &[SubtitleCue]) -> String {
    let mut out = format!(
        "TakeKit 台词本 · {}\n导出于 {}\n\n",
        project.name, created_at
    );
    for cue in cues {
        out.push_str(&format!(
            "[第 {} 镜] {} → {}\n{}\n\n",
            cue.shot_no,
            srt_time(cue.start_ms),
            srt_time(cue.end_ms),
            one_line(&cue.text)
        ));
    }
    out
}

/// ASS 样式字幕；`PlayResX/Y` 跟成片一致，安全区按百分比折算边距。
fn build_ass(cues: &[SubtitleCue], style: &SubtitleStyle, width: u32, height: u32) -> String {
    let margin_h = width.saturating_mul(style.safe_margin_percent) / 100;
    let margin_v = height.saturating_mul(style.safe_margin_percent) / 100;
    let alignment = ass_alignment(&style.position);
    let font_size = if style.font_size == 0 {
        48
    } else {
        style.font_size
    };

    let mut out = String::new();
    out.push_str("[Script Info]\n");
    out.push_str("ScriptType: v4.00+\n");
    out.push_str("WrapStyle: 2\n");
    out.push_str("ScaledBorderAndShadow: yes\n");
    out.push_str(&format!("PlayResX: {width}\n"));
    out.push_str(&format!("PlayResY: {height}\n"));
    out.push('\n');

    out.push_str("[V4+ Styles]\n");
    out.push_str(
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, \
         BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, \
         BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
    );
    out.push_str(&format!(
        "Style: Default,{}, {}, {}, {}, {}, &H00000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, {}, 0, {}, \
         {}, {}, {}, 1\n",
        if style.font.trim().is_empty() {
            "Sans"
        } else {
            style.font.trim()
        },
        font_size,
        ass_color(&style.color),
        ass_color(&style.color),
        ass_color(&style.outline_color),
        style.outline_width,
        alignment,
        margin_h,
        margin_h,
        margin_v,
    ));
    out.push('\n');

    out.push_str("[Events]\n");
    out.push_str(
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    for cue in cues {
        out.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            ass_time(cue.start_ms),
            ass_time(cue.end_ms),
            one_line(&cue.text),
        ));
    }
    out
}

/// `#RRGGBB` → ASS 的 `&HAABBGGRR`（字节序相反）；非法值退回白色。
fn ass_color(hex: &str) -> String {
    let trimmed = hex.trim().trim_start_matches('#');
    if trimmed.len() == 6 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        let red = &trimmed[0..2];
        let green = &trimmed[2..4];
        let blue = &trimmed[4..6];
        format!(
            "&H00{}{}{}",
            blue.to_uppercase(),
            green.to_uppercase(),
            red.to_uppercase()
        )
    } else {
        "&H00FFFFFF".to_string()
    }
}

fn ass_alignment(position: &str) -> u32 {
    match position.trim() {
        "top" => 8,
        "center" => 5,
        _ => 2,
    }
}

/// SRT 时间：`HH:MM:SS,mmm`。
fn srt_time(ms: u64) -> String {
    let millis = ms % 1000;
    let seconds = ms / 1000;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        millis
    )
}

/// ASS 时间：`H:MM:SS.cc`（百分秒）。
fn ass_time(ms: u64) -> String {
    let centis = (ms % 1000) / 10;
    let seconds = ms / 1000;
    format!(
        "{}:{:02}:{:02}.{:02}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        centis
    )
}

/// 单行化：换行与制表符压成空格，顺带去掉首尾空白。
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------- EDL ----------

/// EDL 时间码：`HH:MM:SS:FF`（非丢帧），帧号按项目帧率折算。
fn edl_time(ms: u64, fps: u32) -> String {
    let fps = if fps == 0 { 30 } else { fps };
    let total_frames = ((ms as f64 / 1000.0) * fps as f64).round() as u64;
    let frames = total_frames % fps as u64;
    let seconds = total_frames / fps as u64;
    format!(
        "{:02}:{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        frames
    )
}

/// 非硬切转场在 EDL 里留一条注释（EDL 本身只表达硬切）。
fn transition_name(transition: &Transition) -> Option<&'static str> {
    match transition {
        Transition::Cut => None,
        Transition::Dissolve => Some("DISSOLVE"),
        Transition::FadeIn => Some("FADE IN"),
        Transition::FadeOut => Some("FADE OUT"),
        Transition::WhipPan => Some("WHIP PAN"),
    }
}

/// EDL（CMX3600）：每条片段一个事件，源入点从 0 起，录制入点用片段时间线起点。
///
/// Premiere / 达芬奇都能直接导入，作为「结构化时间线」的通用交换格式。
fn build_edl(project: &Project, fps: u32) -> String {
    let mut out = format!("TITLE: {}\nFCM: NON-DROP FRAME\n\n", project.name);
    for (index, clip) in project.post.timeline.iter().enumerate() {
        out.push_str(&format!(
            "{:03}  AX       V     C        {} {} {} {}\n",
            index + 1,
            edl_time(0, fps),
            edl_time(clip.duration_ms, fps),
            edl_time(clip.start_ms, fps),
            edl_time(clip.start_ms + clip.duration_ms, fps),
        ));
        if let Some(name) = transition_name(&clip.transition) {
            out.push_str(&format!("* TRANSITION: {name}\n"));
        }
        out.push_str(&format!("* FROM CLIP NAME: {}\n", clip.clip_path));
        out.push('\n');
    }
    out
}

// ---------- 素材清单 ----------

/// 素材清单：每个被引用的文件一行，供换台机器时按相对位置放回。
fn materials_csv(project: &Project, plan: &PostPlan, media: &mut MediaMap) -> AppResult<Vec<u8>> {
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(MATERIAL_COLUMNS)
        .map_err(|e| AppError::Internal(format!("csv: {e}")))?;

    for clip in &project.post.timeline {
        writer
            .write_record([
                "clip".to_string(),
                clip.shot_no.to_string(),
                media.material_ref(&clip.clip_path, "clip")?,
                format!("第 {} 镜画面片段", clip.shot_no),
            ])
            .map_err(|e| AppError::Internal(format!("csv: {e}")))?;
    }

    for voice in &plan.voice_refs {
        let line = &voice.line;
        let path = line.audio_path.clone().unwrap_or_default();
        let note = if line.is_narration {
            format!("第 {} 镜旁白配音", line.shot_no)
        } else {
            format!("第 {} 镜台词配音：{}", line.shot_no, one_line(&line.text))
        };
        writer
            .write_record([
                "voice".to_string(),
                line.shot_no.to_string(),
                media.material_ref(&path, "voice")?,
                note,
            ])
            .map_err(|e| AppError::Internal(format!("csv: {e}")))?;
    }

    if let Some(bgm) = &plan.bgm {
        let name = if bgm.name.trim().is_empty() {
            "BGM".to_string()
        } else {
            bgm.name.clone()
        };
        writer
            .write_record([
                "bgm".to_string(),
                String::new(),
                media.material_ref(&bgm.path, "bgm")?,
                name,
            ])
            .map_err(|e| AppError::Internal(format!("csv: {e}")))?;
    }

    for cue in &plan.sfx {
        writer
            .write_record([
                "sfx".to_string(),
                cue.shot_no.to_string(),
                media.material_ref(&cue.path, "sfx")?,
                format!("第 {} 镜音效：{}", cue.shot_no, one_line(&cue.hint)),
            ])
            .map_err(|e| AppError::Internal(format!("csv: {e}")))?;
    }

    writer
        .into_inner()
        .map_err(|e| AppError::Internal(format!("csv: {e}")))
}

// ---------- 自带媒体 ----------

/// 一个要复制进包内的媒体：源绝对路径 → 包内目标（相对包根，如 `media/clip_001.mp4`）。
#[derive(Debug, Clone)]
struct MediaCopy {
    source: PathBuf,
    target: String,
}

/// 媒体引用登记表；`self_contained` 打开时顺带安排复制与路径改写。
struct MediaMap {
    root: PathBuf,
    self_contained: bool,
    copies: Vec<MediaCopy>,
    /// 解析后的绝对路径 → 包内目标，保证同一来源只复制一次。
    seen: HashMap<PathBuf, String>,
}

impl MediaMap {
    fn new(root: &Path, self_contained: bool) -> Self {
        Self {
            root: root.to_path_buf(),
            self_contained,
            copies: Vec::new(),
            seen: HashMap::new(),
        }
    }

    /// 登记一条被引用的媒体，返回它在渲染脚本里该用的引用文本。
    ///
    /// 不自带媒体时按 `{ROOT}/相对` 引用（素材库的绝对路径原样）；自带时复制进包内，
    /// 引用改写为包内相对路径（脚本 `cd` 到包目录后即可直接读）。
    fn register(&mut self, raw: &str, stem: &str) -> AppResult<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        if !self.self_contained {
            return Ok(media_ref(trimmed));
        }
        let absolute = resolve_media(&self.root, trimmed)?;
        if let Some(target) = self.seen.get(&absolute) {
            return Ok(target.clone());
        }
        let target = self.next_target(&absolute, stem);
        self.seen.insert(absolute.clone(), target.clone());
        self.copies.push(MediaCopy {
            source: absolute,
            target: target.clone(),
        });
        Ok(target)
    }

    /// 素材清单里的路径列：自带时指向包内 `media/`，否则保持原始引用（便于放回原位）。
    fn material_ref(&mut self, raw: &str, stem: &str) -> AppResult<String> {
        if !self.self_contained {
            return Ok(raw.trim().replace('\\', "/"));
        }
        self.register(raw, stem)
    }

    /// 包内目标名：`media/<用途>_<序号>.<扩展名>`。
    fn next_target(&self, absolute: &Path, stem: &str) -> String {
        let ext = extension_of(absolute);
        let index = self.copies.len() + 1;
        let file = if ext.is_empty() {
            format!("{stem}_{index:03}")
        } else {
            format!("{stem}_{index:03}.{ext}")
        };
        format!("{MEDIA_DIR}/{file}")
    }
}

/// 复制一个媒体文件进包；目标父目录按需创建。
fn copy_file(dest: &Path, source: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, dest)?;
    Ok(())
}

// ---------- ffmpeg 输入与滤镜图 ----------

/// 一条 ffmpeg 输入：`args` 是完整输入参数（含 `-i` 与必要前置开关）。
struct FfmpegInput {
    args: String,
    kind: InputKind,
}

/// 输入的用途；决定滤镜链怎么处理它。
#[derive(Debug, Clone, PartialEq)]
enum InputKind {
    /// 画面片段：转场与时长决定是否加淡入淡出。
    Video {
        transition: Transition,
        duration_ms: u64,
    },
    /// 配音：起始毫秒做 `adelay`。
    Voice { start_ms: u64 },
    /// BGM：整轨音量。
    Bgm { volume: u32 },
    /// 音效：触发时间做 `adelay`。
    Sfx { at_ms: u64, volume: u32 },
}

/// 按「片段 → 配音 → BGM → 音效」的顺序编排输入；滤镜图里的索引与之对应。
fn plan_inputs(
    project: &Project,
    plan: &PostPlan,
    media: &mut MediaMap,
) -> AppResult<Vec<FfmpegInput>> {
    let mut inputs = Vec::new();

    for clip in &project.post.timeline {
        inputs.push(FfmpegInput {
            args: format!("-i \"{}\"", media.register(&clip.clip_path, "clip")?),
            kind: InputKind::Video {
                transition: clip.transition,
                duration_ms: clip.duration_ms,
            },
        });
    }

    for voice in &plan.voice_refs {
        let Some(path) = text_of(&voice.line.audio_path) else {
            continue;
        };
        inputs.push(FfmpegInput {
            args: format!("-i \"{}\"", media.register(path, "voice")?),
            kind: InputKind::Voice {
                start_ms: voice.start_ms,
            },
        });
    }

    if let Some(bgm) = &plan.bgm {
        let looped = if bgm.looping { "-stream_loop -1 " } else { "" };
        inputs.push(FfmpegInput {
            args: format!("{looped}-i \"{}\"", media.register(&bgm.path, "bgm")?),
            kind: InputKind::Bgm { volume: bgm.volume },
        });
    }

    for cue in &plan.sfx {
        inputs.push(FfmpegInput {
            args: format!("-i \"{}\"", media.register(&cue.path, "sfx")?),
            kind: InputKind::Sfx {
                at_ms: cue.at_ms,
                volume: cue.volume,
            },
        });
    }

    Ok(inputs)
}

/// 素材引用的脚本文本；相对路径挂在 `{ROOT}` 下，绝对路径（素材库）原样用。
fn media_ref(raw: &str) -> String {
    let normalized = raw.trim().replace('\\', "/");
    if Path::new(&normalized).is_absolute() {
        normalized
    } else {
        format!("{{ROOT}}/{normalized}")
    }
}

/// 生成滤镜图与「是否有音频」。
///
/// 画面：逐片段归一（缩放 + 补边 + 统一帧率与像素格式）→ `concat` 硬切拼接 →
/// 需要时烧字幕。音频：配音各句 `adelay` 后混成一条人声 → BGM 音量（需要闪避时
/// 用 `sidechaincompress` 以人声为触发压低）→ 音效各自 `adelay` → 总混。
fn filter_graph(
    inputs: &[InputKind],
    width: u32,
    height: u32,
    fps: u32,
    burn_in: bool,
    ducking: bool,
) -> (String, bool) {
    let mut parts: Vec<String> = Vec::new();
    video_chain(&mut parts, inputs, width, height, fps, burn_in);
    let has_audio = main_audio(&mut parts, inputs, ducking);
    (parts.join(";"), has_audio)
}

/// 画面链：逐片段归一 → `concat` 硬切 → 需要时烧字幕；输出 `[vout]`。
fn video_chain(
    parts: &mut Vec<String>,
    inputs: &[InputKind],
    width: u32,
    height: u32,
    fps: u32,
    burn_in: bool,
) {
    let mut labels: Vec<String> = Vec::new();
    for (index, kind) in inputs.iter().enumerate() {
        let InputKind::Video {
            transition,
            duration_ms,
        } = kind
        else {
            continue;
        };
        let mut chain = format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,\
             pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,\
             fps={fps},format=yuv420p"
        );
        let duration = *duration_ms as f64 / 1000.0;
        match transition {
            Transition::FadeIn => {
                chain.push_str(&format!(",fade=t=in:st=0:d={FADE_SECS}"));
            }
            Transition::FadeOut => {
                let start = (duration - FADE_SECS).max(0.0);
                chain.push_str(&format!(",fade=t=out:st={start:.3}:d={FADE_SECS}"));
            }
            // cut / dissolve / whip_pan 都按硬切拼：应用不做复杂特效。
            Transition::Cut | Transition::Dissolve | Transition::WhipPan => {}
        }
        let label = format!("[v{}]", labels.len());
        parts.push(format!("[{index}:v]{chain}{label}"));
        labels.push(label);
    }

    let count = labels.len();
    parts.push(format!("{}concat=n={count}:v=1:a=0[vcat]", labels.join("")));
    if burn_in {
        parts.push("[vcat]ass=subtitles.ass[vout]".to_string());
    } else {
        parts.push("[vcat]null[vout]".to_string());
    }
}

/// 追一条音频输入的归一链，返回它的标签；画面输入返回 `None`。
fn audio_input(
    parts: &mut Vec<String>,
    index: usize,
    kind: &InputKind,
    voice_index: usize,
    sfx_index: usize,
) -> Option<String> {
    match kind {
        InputKind::Voice { start_ms } => {
            let label = format!("[vc{voice_index}]");
            parts.push(format!(
                "[{index}:a]{AFORMAT},adelay={start_ms}:all=1,volume=1.0{label}"
            ));
            Some(label)
        }
        InputKind::Bgm { volume } => {
            parts.push(format!(
                "[{index}:a]{AFORMAT},volume={:.2}[bgm0]",
                *volume as f64 / 100.0
            ));
            Some("[bgm0]".to_string())
        }
        InputKind::Sfx { at_ms, volume } => {
            let label = format!("[sfx{sfx_index}]");
            parts.push(format!(
                "[{index}:a]{AFORMAT},adelay={at_ms}:all=1,volume={:.2}{label}",
                *volume as f64 / 100.0
            ));
            Some(label)
        }
        InputKind::Video { .. } => None,
    }
}

/// 主混音：人声 +（可闪避的）BGM + 音效 → `[aout]`；返回是否真有音频。
fn main_audio(parts: &mut Vec<String>, inputs: &[InputKind], ducking: bool) -> bool {
    let mut voice_labels: Vec<String> = Vec::new();
    let mut sfx_labels: Vec<String> = Vec::new();
    let mut bgm_label: Option<String> = None;
    let mut voice_count = 0;
    let mut sfx_count = 0;

    for (index, kind) in inputs.iter().enumerate() {
        let label = audio_input(parts, index, kind, voice_count, sfx_count);
        match kind {
            InputKind::Voice { .. } => {
                if let Some(label) = label {
                    voice_labels.push(label);
                }
                voice_count += 1;
            }
            InputKind::Bgm { .. } => bgm_label = label,
            InputKind::Sfx { .. } => {
                if let Some(label) = label {
                    sfx_labels.push(label);
                }
                sfx_count += 1;
            }
            InputKind::Video { .. } => {}
        }
    }

    // 人声轨。
    let mut voice_out = mix_labels(parts, &voice_labels, "[voc]");

    // BGM：有对白且开了闪避时，以人声为触发压低 BGM。
    let mut bgm_out: Option<String> = None;
    if let Some(bgm) = bgm_label {
        match (&voice_out, ducking) {
            (Some(voice), true) => {
                parts.push(format!("{voice}asplit=2[vocmix][vocsc]"));
                parts.push(format!("{bgm}[vocsc]{SIDECHAIN}[bgmv]"));
                voice_out = Some("[vocmix]".to_string());
                bgm_out = Some("[bgmv]".to_string());
            }
            _ => bgm_out = Some(bgm),
        }
    }

    let mut final_labels: Vec<String> = Vec::new();
    if let Some(voice) = &voice_out {
        final_labels.push(voice.clone());
    }
    if let Some(bgm) = &bgm_out {
        final_labels.push(bgm.clone());
    }
    final_labels.extend(sfx_labels);

    emit_mix(parts, &final_labels, "[aout]")
}

/// 把若干音频标签混成一条；0 个返回 `false`，1 个 `anull` 透传，多个 `amix`。
fn emit_mix(parts: &mut Vec<String>, labels: &[String], out: &str) -> bool {
    match labels.len() {
        0 => false,
        1 => {
            parts.push(format!("{}anull{out}", labels[0]));
            true
        }
        count => {
            parts.push(format!(
                "{}amix=inputs={count}:normalize=0:dropout_transition=0{out}",
                labels.join("")
            ));
            true
        }
    }
}

/// 把若干音频标签混成一个中间标签；0 个返回 `None`，1 个原样透传。
fn mix_labels(parts: &mut Vec<String>, labels: &[String], out: &str) -> Option<String> {
    match labels.len() {
        0 => None,
        1 => Some(labels[0].clone()),
        count => {
            parts.push(format!(
                "{}amix=inputs={count}:normalize=0{out}",
                labels.join("")
            ));
            Some(out.to_string())
        }
    }
}

// ---------- 脚本 ----------

/// 脚本方言。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScriptStyle {
    Sh,
    Bat,
}

/// 组装 ffmpeg 调用：sh 用 `\` 续行、`$ROOT`；bat 单行、`%ROOT%`。
fn ffmpeg_command(
    style: ScriptStyle,
    inputs: &[FfmpegInput],
    has_audio: bool,
    fps: u32,
    total_ms: u64,
) -> String {
    let var = match style {
        ScriptStyle::Sh => "$ROOT",
        ScriptStyle::Bat => "%ROOT%",
    };
    let input_args: Vec<String> = inputs
        .iter()
        .map(|input| input.args.replace("{ROOT}", var))
        .collect();

    let mut options: Vec<String> = vec![
        "-c:v libx264".to_string(),
        "-pix_fmt yuv420p".to_string(),
        format!("-r {fps}"),
        "-movflags +faststart".to_string(),
    ];
    if has_audio {
        options.push("-c:a aac".to_string());
        options.push("-b:a 192k".to_string());
        options.push("-ar 48000".to_string());
        options.push("-ac 2".to_string());
    }
    // 显式给总时长：BGM 循环时靠它收尾，也让成片长度严格贴着时间线。
    options.push(format!("-t {:.3}", total_ms as f64 / 1000.0));
    options.push(format!("\"{OUTPUT_MP4}\""));

    match style {
        ScriptStyle::Sh => {
            let mut out = String::from("ffmpeg -y");
            for arg in &input_args {
                out.push_str(&format!(" \\\n  {arg}"));
            }
            out.push_str(" \\\n  -filter_complex \"$FILTER\" \\\n  -map \"[vout]\"");
            if has_audio {
                out.push_str(" \\\n  -map \"[aout]\"");
            }
            for option in &options {
                out.push_str(&format!(" \\\n  {option}"));
            }
            out
        }
        ScriptStyle::Bat => {
            let mut out = String::from("ffmpeg -y");
            for arg in &input_args {
                out.push(' ');
                out.push_str(arg);
            }
            out.push_str(" -filter_complex \"%FILTER%\" -map \"[vout]\"");
            if has_audio {
                out.push_str(" -map \"[aout]\"");
            }
            for option in &options {
                out.push(' ');
                out.push_str(option);
            }
            out
        }
    }
}

fn render_sh(root: &Path, command: &str, graph: &str) -> String {
    let root = normalize_path(root);
    format!(
        "#!/usr/bin/env bash\n\
         # TakeKit 剪辑工程包 · 一键渲染脚本\n\
         # 用法：`bash render.sh`（需要 PATH 里有 ffmpeg）\n\
         set -euo pipefail\n\
         cd \"$(dirname \"$0\")\"\n\
         \n\
         ROOT=\"{root}\"\n\
         FILTER='{graph}'\n\
         \n\
         {command}\n"
    )
}

fn render_bat(root: &Path, command: &str, graph: &str) -> String {
    let root = normalize_path(root);
    let text = format!(
        "@echo off\n\
         setlocal\n\
         REM TakeKit 剪辑工程包 · 一键渲染脚本\n\
         REM 用法：双击 render.bat，或在本目录执行（需要 PATH 里有 ffmpeg）\n\
         cd /d \"%~dp0\"\n\
         \n\
         set \"ROOT={root}\"\n\
         set \"FILTER={graph}\"\n\
         \n\
         {command}\n\
         if errorlevel 1 (\n\
         echo ffmpeg 执行失败，请检查上方输出。\n\
         exit /b 1\n\
         )\n\
         echo 完成：{OUTPUT_MP4}\n"
    );
    text.replace('\n', "\r\n")
}

/// 绝对路径统一正斜杠（Windows 反斜杠在脚本里既难读又易错）。
fn normalize_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

// ---------- 分轨音频 ----------

/// 分轨的角色；决定这条 WAV 装哪些声音。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioRole {
    /// 纯人声（配音 / 旁白）。
    Voice,
    /// 纯 BGM（有对白时按对白闪避）。
    Bgm,
    /// 纯音效。
    Sfx,
    /// BGM + 音效的无配音混音。
    NoVoice,
}

/// 一条分轨：角色、输出文件名、只产出 `[aout]` 的滤镜图。
#[derive(Debug, Clone)]
struct Stem {
    role: AudioRole,
    file: &'static str,
    graph: String,
}

/// 分轨的角色名（写进脚本注释）。
fn stem_role_label(role: AudioRole) -> &'static str {
    match role {
        AudioRole::Voice => "人声",
        AudioRole::Bgm => "BGM",
        AudioRole::Sfx => "音效",
        AudioRole::NoVoice => "无配音混音",
    }
}

/// 生成各分轨：实际存在的角色才出；「无配音」需要 BGM 与音效同时存在。
fn stem_graphs(inputs: &[InputKind], ducking: bool) -> Vec<Stem> {
    let has_voice = inputs.iter().any(|k| matches!(k, InputKind::Voice { .. }));
    let has_bgm = inputs.iter().any(|k| matches!(k, InputKind::Bgm { .. }));
    let has_sfx = inputs.iter().any(|k| matches!(k, InputKind::Sfx { .. }));

    let mut stems = Vec::new();
    if has_voice {
        stems.push(Stem {
            role: AudioRole::Voice,
            file: STEM_VOICE,
            graph: stem_graph(inputs, &[AudioRole::Voice], false),
        });
    }
    if has_bgm {
        stems.push(Stem {
            role: AudioRole::Bgm,
            file: STEM_BGM,
            graph: stem_graph(inputs, &[AudioRole::Bgm], ducking),
        });
    }
    if has_sfx {
        stems.push(Stem {
            role: AudioRole::Sfx,
            file: STEM_SFX,
            graph: stem_graph(inputs, &[AudioRole::Sfx], false),
        });
    }
    if has_bgm && has_sfx {
        stems.push(Stem {
            role: AudioRole::NoVoice,
            file: STEM_NOVOICE,
            graph: stem_graph(inputs, &[AudioRole::Bgm, AudioRole::Sfx], ducking),
        });
    }
    stems
}

/// 单个分轨的滤镜图：挑出需要的角色混成 `[aout]`。
///
/// BGM 分轨要闪避时，人声虽不输出，但仍作为 `sidechaincompress` 的触发轨；
/// 若人声同时要输出，则 `asplit` 成「输出」与「触发」两条。
fn stem_graph(inputs: &[InputKind], roles: &[AudioRole], ducking: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut voice_labels: Vec<String> = Vec::new();
    let mut sfx_labels: Vec<String> = Vec::new();
    let mut bgm_label: Option<String> = None;
    let mut voice_count = 0;
    let mut sfx_count = 0;

    for (index, kind) in inputs.iter().enumerate() {
        let label = audio_input(&mut parts, index, kind, voice_count, sfx_count);
        match kind {
            InputKind::Voice { .. } => {
                if let Some(label) = label {
                    voice_labels.push(label);
                }
                voice_count += 1;
            }
            InputKind::Bgm { .. } => bgm_label = label,
            InputKind::Sfx { .. } => {
                if let Some(label) = label {
                    sfx_labels.push(label);
                }
                sfx_count += 1;
            }
            InputKind::Video { .. } => {}
        }
    }

    let want_voice = roles.contains(&AudioRole::Voice);
    let want_bgm = roles.contains(&AudioRole::Bgm);
    let want_sfx = roles.contains(&AudioRole::Sfx);
    let want_trigger = want_bgm && ducking && !voice_labels.is_empty();

    let voice_mix = if want_voice || want_trigger {
        mix_labels(&mut parts, &voice_labels, "[voc]")
    } else {
        None
    };

    let mut voice_out: Option<String> = None;
    let mut trigger: Option<String> = None;
    if let Some(voice) = &voice_mix {
        match (want_voice, want_trigger) {
            (true, true) => {
                parts.push(format!("{voice}asplit=2[vocout][vocsc]"));
                voice_out = Some("[vocout]".to_string());
                trigger = Some("[vocsc]".to_string());
            }
            (true, false) => voice_out = Some(voice.clone()),
            (false, true) => trigger = Some(voice.clone()),
            (false, false) => {}
        }
    }

    let mut bgm_out: Option<String> = None;
    if want_bgm {
        if let Some(bgm) = bgm_label {
            match &trigger {
                Some(trigger) => {
                    parts.push(format!("{bgm}{trigger}{SIDECHAIN}[bgmv]"));
                    bgm_out = Some("[bgmv]".to_string());
                }
                None => bgm_out = Some(bgm),
            }
        }
    }

    let mut final_labels: Vec<String> = Vec::new();
    if let Some(voice) = voice_out {
        final_labels.push(voice);
    }
    if let Some(bgm) = bgm_out {
        final_labels.push(bgm);
    }
    if want_sfx {
        final_labels.extend(sfx_labels);
    }

    emit_mix(&mut parts, &final_labels, "[aout]");
    parts.join(";")
}

/// 组装一条分轨的 ffmpeg 调用：同一批输入，换成该分轨的滤镜图，只出音频 WAV。
fn stem_command(style: ScriptStyle, inputs: &[FfmpegInput], stem: &Stem, total_ms: u64) -> String {
    let var = match style {
        ScriptStyle::Sh => "$ROOT",
        ScriptStyle::Bat => "%ROOT%",
    };
    let input_args: Vec<String> = inputs
        .iter()
        .map(|input| input.args.replace("{ROOT}", var))
        .collect();
    let options = format!(
        "-map \"[aout]\" -c:a pcm_s16le -ar 48000 -ac 2 -t {:.3} \"{}\"",
        total_ms as f64 / 1000.0,
        stem.file
    );

    match style {
        ScriptStyle::Sh => {
            let mut out = String::from("ffmpeg -y");
            for arg in &input_args {
                out.push_str(&format!(" \\\n  {arg}"));
            }
            out.push_str(&format!(" \\\n  -filter_complex '{}'", stem.graph));
            out.push_str(&format!(" \\\n  {options}"));
            out
        }
        ScriptStyle::Bat => {
            let mut out = String::from("ffmpeg -y");
            for arg in &input_args {
                out.push(' ');
                out.push_str(arg);
            }
            out.push_str(&format!(" -filter_complex \"{}\" {options}", stem.graph));
            out
        }
    }
}

/// 分轨渲染脚本（sh）：每条分轨一次 ffmpeg，产出四条 WAV。
fn render_stems_sh(root: &Path, inputs: &[FfmpegInput], stems: &[Stem], total_ms: u64) -> String {
    let root = normalize_path(root);
    let mut out = format!(
        "#!/usr/bin/env bash\n\
         # TakeKit 剪辑工程包 · 分轨渲染脚本\n\
         # 用法：`bash render_stems.sh`（需要 PATH 里有 ffmpeg）\n\
         # 产出：人声 / BGM / 音效 / 无配音 四条 WAV，便于单独调音。\n\
         set -euo pipefail\n\
         cd \"$(dirname \"$0\")\"\n\
         \n\
         ROOT=\"{root}\"\n"
    );
    for stem in stems {
        out.push_str(&format!(
            "\n# {} → {}\n",
            stem_role_label(stem.role),
            stem.file
        ));
        out.push_str(&format!("echo \"渲染分轨：{}\"\n", stem.file));
        out.push_str(&stem_command(ScriptStyle::Sh, inputs, stem, total_ms));
        out.push('\n');
    }
    out
}

/// 分轨渲染脚本（bat）：同上，Windows 方言。
fn render_stems_bat(root: &Path, inputs: &[FfmpegInput], stems: &[Stem], total_ms: u64) -> String {
    let root = normalize_path(root);
    let mut out = format!(
        "@echo off\n\
         setlocal\n\
         REM TakeKit 剪辑工程包 · 分轨渲染脚本\n\
         REM 用法：双击 render_stems.bat（需要 PATH 里有 ffmpeg）\n\
         cd /d \"%~dp0\"\n\
         \n\
         set \"ROOT={root}\"\n"
    );
    for stem in stems {
        out.push_str(&format!(
            "\nREM {} -> {}\n",
            stem_role_label(stem.role),
            stem.file
        ));
        out.push_str(&format!("echo 渲染分轨：{}\n", stem.file));
        out.push_str(&stem_command(ScriptStyle::Bat, inputs, stem, total_ms));
        out.push('\n');
        out.push_str("if errorlevel 1 (\n");
        out.push_str(&format!("echo 分轨渲染失败：{}\n", stem.file));
        out.push_str("exit /b 1\n");
        out.push_str(")\n");
    }
    out.push_str("\necho 全部分轨完成。\n");
    out.replace('\n', "\r\n")
}

// ---------- 说明文件 ----------

/// 包内固定文件的用途；媒体文件返回 `None`（说明里归入「包内媒体」区块）。
fn describe(name: &str) -> Option<&'static str> {
    match name {
        TIMELINE_JSON => Some("四轨结构化时间线（片段 / 配音 / 字幕 / BGM 与音效）"),
        SUBTITLES_SRT => Some("软字幕，可导入任意剪辑软件"),
        SUBTITLES_ASS => Some("带样式字幕；burn_in 打开时已烧进画面"),
        SUBTITLES_VTT => Some("WebVTT 软字幕，适合网页播放器"),
        SCRIPT_LINES => Some("纯文本台词本，便于配音或念稿"),
        TIMELINE_EDL => Some("EDL（CMX3600），可导入 Premiere / 达芬奇"),
        MATERIALS_CSV => Some("素材清单：每个被引用的文件与它的用途"),
        RENDER_SH => Some("macOS / Linux 一键渲染脚本"),
        RENDER_BAT => Some("Windows 一键渲染脚本"),
        RENDER_STEMS_SH => Some("macOS / Linux 分轨渲染脚本"),
        RENDER_STEMS_BAT => Some("Windows 分轨渲染脚本"),
        MANIFEST_JSON => Some("本次导出的汇总（镜数、时长、待办）"),
        README_TXT => Some("本说明文件"),
        _ => None,
    }
}

fn readme(project: &Project, manifest: &Manifest, root: &Path) -> String {
    let seconds = manifest.total_ms as f64 / 1000.0;
    let pending = if manifest.pending_voice_lines.is_empty() {
        "无".to_string()
    } else {
        format!(
            "还有 {} 句配音未生成（见 manifest.json 的 pendingVoiceLines）：\n  - {}",
            manifest.pending_voice_lines.len(),
            manifest.pending_voice_lines.join("\n  - ")
        )
    };

    let mut out = String::new();
    out.push_str("TakeKit 剪辑工程包\n");
    out.push_str("==================\n\n");
    out.push_str(&format!("项目：{}\n", project.name));
    out.push_str(&format!("导出时间：{}\n", manifest.created_at));
    out.push_str(&format!(
        "导出预设：{}（{}x{}，{}fps）\n",
        manifest.preset, manifest.width, manifest.height, manifest.fps
    ));
    out.push_str(&format!("成片时长：{:.1} 秒\n", seconds));
    out.push_str(&format!("输出文件：{}\n\n", manifest.output));

    // 包内文件：固定文件按用途列，媒体文件单列一区块。
    out.push_str("包内文件\n--------\n");
    for name in &manifest.files {
        if name == README_TXT {
            continue;
        }
        if let Some(purpose) = describe(name) {
            out.push_str(&format!("{name:<18}{purpose}\n"));
        }
    }
    let media: Vec<&String> = manifest
        .files
        .iter()
        .filter(|name| describe(name).is_none())
        .collect();
    if !media.is_empty() {
        out.push_str("\n包内媒体\n--------\n");
        out.push_str("本包已自带下列媒体，可直接搬走后渲染：\n");
        for name in media {
            out.push_str(&format!("{name}\n"));
        }
    }
    out.push('\n');

    out.push_str("怎么用\n------\n");
    out.push_str("1. 装好 ffmpeg（命令行能跑 `ffmpeg -version` 即可）。\n");
    if manifest.self_contained {
        out.push_str(
            "2. 本包已自带媒体：被引用的片段 / 配音 / BGM / 音效都复制进了 media/，\n   \
             脚本按包内相对路径取用，整个目录可以搬去任何地方直接渲染。\n",
        );
    } else {
        out.push_str(&format!(
            "2. 本包不复制媒体，脚本按下面的 ROOT 去找素材：\n   ROOT = {}\n   \
             换台机器时，请按 materials.csv 把素材放回原来的相对位置，\n   \
             或直接改脚本里的 ROOT 指向新位置。\n",
            normalize_path(root)
        ));
    }
    out.push_str("3. 运行 render.bat（Windows）或 bash render.sh（macOS / Linux）。\n");
    out.push_str(&format!(
        "4. 产物为 {}。软字幕在 subtitles.srt，可另外导入剪辑软件。\n",
        manifest.output
    ));

    if manifest.files.iter().any(|name| name == RENDER_STEMS_SH) {
        out.push_str("\n分轨音频\n--------\n");
        out.push_str(
            "运行 render_stems.bat（Windows）或 bash render_stems.sh，可另外导出四条 WAV 分轨：\n\
             stems_voice.wav    纯人声（配音 / 旁白）\n\
             stems_bgm.wav      纯 BGM（已按对白闪避）\n\
             stems_sfx.wav      纯音效\n\
             stems_novoice.wav  BGM + 音效（无配音混音）\n\
             便于在剪辑软件里单独调音或做二创。\n",
        );
    }

    out.push_str(
        "\n转场说明\n--------\n\
         应用不做复杂特效：dissolve / whip_pan 只记录在 timeline.json，\n\
         渲染时按硬切拼接；fade_in / fade_out 用 0.3 秒淡入淡出实现。\n",
    );

    out.push_str("\n待办\n----\n");
    out.push_str(&pending);
    out.push('\n');

    out
}

// ---------- 数据文档 ----------

/// 工程包的时间线文档：四轨结构化数据，可直接被脚本或程序读。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineDoc {
    project: String,
    created_at: String,
    preset: String,
    width: u32,
    height: u32,
    fps: u32,
    total_ms: u64,
    clips: Vec<TimelineClip>,
    voice_lines: Vec<VoiceLine>,
    subtitles: Vec<SubtitleCue>,
    subtitle_style: SubtitleStyle,
    bgm: Option<BgmTrack>,
    sfx: Vec<SfxCue>,
    lipsync: Vec<LipsyncCue>,
    pending_voice_lines: Vec<String>,
}

/// 导出汇总。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    project: String,
    created_at: String,
    preset: String,
    width: u32,
    height: u32,
    fps: u32,
    total_ms: u64,
    clip_count: usize,
    voice_line_count: usize,
    subtitle_count: usize,
    sfx_count: usize,
    lipsync_enabled: usize,
    burn_in: bool,
    self_contained: bool,
    output: String,
    files: Vec<String>,
    pending_voice_lines: Vec<String>,
}

// ---------- 落盘 ----------

/// 写文件，必要时先把父目录建出来。
fn write_file(dest: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = dest.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, bytes)?;
    Ok(())
}

/// 本次导出记录；`path` 统一正斜杠。
fn record(kind: &str, path: &Path) -> ExportRecord {
    ExportRecord {
        id: new_id(),
        kind: kind.to_string(),
        created_at: now_iso(),
        path: path.display().to_string().replace('\\', "/"),
    }
}

/// 非空文本；空白串视同没有。
fn text_of(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// 同上，但入参是裸字符串。
fn text_of_some(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::WorkKind;
    use tempfile::TempDir;

    fn write_media(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// 一镜一片段 + 一句配音 + 一条字幕的最小可导出项目。
    fn sample_project(root: &Path) -> Project {
        let mut project = Project::new("后期测试", WorkKind::ShortDrama);
        project.meta.resolution = "1080x1920".into();
        project.meta.fps = 30;
        project.post.export_preset = "douyin".into();

        let clip_path = "clips/001_01.mp4";
        let audio_path = "voice/line-1.wav";
        write_media(root, clip_path, b"mp4-bytes");
        write_media(root, audio_path, b"wav-bytes");

        project.post.timeline = vec![TimelineClip {
            shot_id: "shot-1".into(),
            shot_no: 1,
            clip_path: clip_path.into(),
            start_ms: 0,
            duration_ms: 3_000,
            transition: Transition::Cut,
            ..TimelineClip::default()
        }];
        project.post.voice_lines = vec![VoiceLine {
            id: "voice-1".into(),
            shot_id: "shot-1".into(),
            shot_no: 1,
            text: "你好".into(),
            audio_path: Some(audio_path.into()),
            duration_ms: 900,
            ..VoiceLine::default()
        }];
        project.post.subtitles = vec![SubtitleCue {
            id: "sub-1".into(),
            voice_line_id: "voice-1".into(),
            shot_id: "shot-1".into(),
            shot_no: 1,
            text: "你好".into(),
            start_ms: 200,
            end_ms: 1_100,
            enabled: true,
            ..SubtitleCue::default()
        }];
        project
    }

    #[test]
    fn preset_and_resolution_decide_the_frame_size() {
        assert_eq!(preset_dims("douyin"), Some((1080, 1920)));
        assert_eq!(preset_dims("youtube"), Some((1920, 1080)));
        assert_eq!(preset_dims("unknown"), None);
        assert_eq!(parse_resolution("1080x1920"), Some((1080, 1920)));
        assert_eq!(parse_resolution(" 1920X1080 "), Some((1920, 1080)));
        assert_eq!(parse_resolution("720*1280"), Some((720, 1280)));
        assert_eq!(parse_resolution("nope"), None);
        assert_eq!(even(1081), 1080);
        assert_eq!(even(1080), 1080);
    }

    #[test]
    fn subtitle_timestamps_use_each_formats_own_shape() {
        assert_eq!(srt_time(0), "00:00:00,000");
        assert_eq!(srt_time(62_345), "00:01:02,345");
        assert_eq!(ass_time(0), "0:00:00.00");
        assert_eq!(ass_time(62_345), "0:01:02.34");
    }

    #[test]
    fn ass_color_swaps_to_bgr_and_falls_back_to_white() {
        assert_eq!(ass_color("#FFFFFF"), "&H00FFFFFF");
        assert_eq!(ass_color("#FF0000"), "&H000000FF");
        assert_eq!(ass_color("bad"), "&H00FFFFFF");
    }

    #[test]
    fn srt_and_ass_skip_disabled_cues() {
        let style = SubtitleStyle::default();
        let cues = vec![
            SubtitleCue {
                text: "第一句".into(),
                start_ms: 0,
                end_ms: 1_000,
                enabled: true,
                ..SubtitleCue::default()
            },
            SubtitleCue {
                text: "不要这句".into(),
                enabled: false,
                ..SubtitleCue::default()
            },
        ];
        let enabled: Vec<SubtitleCue> = cues.iter().filter(|cue| cue.enabled).cloned().collect();

        let srt = build_srt(&enabled);
        assert!(srt.contains("第一句"));
        assert!(!srt.contains("不要这句"));

        let ass = build_ass(&enabled, &style, 1080, 1920);
        assert!(ass.contains("PlayResX: 1080"));
        assert!(ass.contains("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,第一句"));
        assert!(!ass.contains("不要这句"));
    }

    #[test]
    fn filter_graph_concats_clips_and_mixes_voice() {
        let inputs = vec![
            InputKind::Video {
                transition: Transition::Cut,
                duration_ms: 3_000,
            },
            InputKind::Voice { start_ms: 200 },
        ];
        let (graph, has_audio) = filter_graph(&inputs, 1080, 1920, 30, false, true);

        assert!(graph.contains("concat=n=1:v=1:a=0[vcat]"));
        assert!(graph.contains("[vcat]null[vout]"));
        assert!(graph.contains("adelay=200:all=1"));
        assert!(graph.contains("[vc0]anull[aout]"));
        assert!(has_audio);
    }

    #[test]
    fn filter_graph_applies_fade_transitions() {
        let inputs = vec![
            InputKind::Video {
                transition: Transition::FadeIn,
                duration_ms: 3_000,
            },
            InputKind::Video {
                transition: Transition::FadeOut,
                duration_ms: 2_000,
            },
        ];
        let (graph, has_audio) = filter_graph(&inputs, 1080, 1920, 30, false, false);

        assert!(graph.contains("fade=t=in:st=0:d=0.3"));
        assert!(graph.contains("fade=t=out:st=1.700:d=0.3"));
        assert!(graph.contains("concat=n=2:v=1:a=0[vcat]"));
        assert!(!has_audio);
    }

    #[test]
    fn filter_graph_ducks_bgm_under_voice_and_burns_subtitles() {
        let inputs = vec![
            InputKind::Video {
                transition: Transition::Dissolve,
                duration_ms: 3_000,
            },
            InputKind::Voice { start_ms: 0 },
            InputKind::Bgm { volume: 50 },
        ];
        let (graph, has_audio) = filter_graph(&inputs, 1080, 1920, 30, true, true);

        assert!(graph.contains("ass=subtitles.ass[vout]"));
        assert!(graph.contains("volume=0.50[bgm0]"));
        assert!(graph.contains("asplit=2[vocmix][vocsc]"));
        assert!(graph.contains("sidechaincompress"));
        assert!(
            graph.contains("[vocmix][bgmv]amix=inputs=2:normalize=0:dropout_transition=0[aout]")
        );
        assert!(has_audio);
        // dissolve 只记录转场，不加淡变。
        assert!(!graph.contains("fade="));
    }

    #[test]
    fn export_post_pack_writes_every_expected_file() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let project = sample_project(&root);
        let dest = dir.path().join("pack");

        let outcome = export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            None,
        )
        .unwrap();

        for name in [
            TIMELINE_JSON,
            SUBTITLES_SRT,
            SUBTITLES_ASS,
            MATERIALS_CSV,
            RENDER_SH,
            RENDER_BAT,
            MANIFEST_JSON,
            README_TXT,
        ] {
            assert!(dest.join(name).is_file(), "{name} 未生成");
            assert!(
                outcome.files.iter().any(|file| file == name),
                "{name} 未登记"
            );
        }

        assert_eq!(outcome.record.kind, "post");
        assert_eq!(outcome.dir, dest.display().to_string());
        assert!(!outcome.record.path.contains('\\'), "导出路径应统一正斜杠");

        let srt = fs::read_to_string(dest.join(SUBTITLES_SRT)).unwrap();
        assert!(srt.contains("00:00:00,200 --> 00:00:01,100"));

        let materials = fs::read_to_string(dest.join(MATERIALS_CSV)).unwrap();
        assert!(materials.contains("clips/001_01.mp4"));
        assert!(materials.contains("voice/line-1.wav"));

        let sh = fs::read_to_string(dest.join(RENDER_SH)).unwrap();
        assert!(sh.contains("out.mp4"));
        assert!(sh.contains("clips/001_01.mp4"));
        assert!(sh.contains("\"$(dirname \"$0\")\""));

        let bat = fs::read_to_string(dest.join(RENDER_BAT)).unwrap();
        assert!(bat.contains("%ROOT%/clips/001_01.mp4"));
        assert!(bat.contains("\r\n"));

        let timeline: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dest.join(TIMELINE_JSON)).unwrap()).unwrap();
        assert_eq!(timeline["totalMs"], 3_000);
        assert_eq!(timeline["width"], 1080);
        assert_eq!(timeline["height"], 1920);
    }

    #[test]
    fn export_post_pack_refuses_an_empty_timeline() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let mut project = Project::new("空时间线", WorkKind::ShortDrama);
        project.post.timeline.clear();

        let dest = dir.path().join("pack");
        let error = export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            None,
        )
        .unwrap_err();

        assert_eq!(error.code(), "validation");
        assert_eq!(error.args().get("field").map(String::as_str), Some("post"));
        assert!(!dest.exists(), "校验失败时不该留下半成品目录");
    }

    #[test]
    fn export_post_pack_reports_a_clip_file_that_is_gone() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let mut project = sample_project(&root);
        project.post.timeline[0].clip_path = "clips/001_99.mp4".into();

        let error = export_post_pack(
            root.display().to_string(),
            project,
            dir.path().join("pack").display().to_string(),
            None,
        )
        .unwrap_err();
        assert_eq!(error.code(), "not_found");
    }

    #[test]
    fn export_post_pack_records_pending_voice_lines() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let mut project = sample_project(&root);
        project.post.voice_lines.push(VoiceLine {
            id: "voice-2".into(),
            shot_id: "shot-1".into(),
            shot_no: 1,
            text: "还没生成的第二句".into(),
            audio_path: None,
            ..VoiceLine::default()
        });

        let dest = dir.path().join("pack");
        export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            None,
        )
        .unwrap();

        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dest.join(MANIFEST_JSON)).unwrap()).unwrap();
        assert_eq!(manifest["pendingVoiceLines"][0], "还没生成的第二句");
        assert_eq!(manifest["voiceLineCount"], 1);

        // 待生成的句子不进脚本输入。
        let sh = fs::read_to_string(dest.join(RENDER_SH)).unwrap();
        assert!(!sh.contains("还没生成的第二句"));
    }

    #[test]
    fn export_post_pack_references_material_library_paths_absolutely() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let mut project = sample_project(&root);

        // 素材库音频是项目外的绝对路径。
        let music = dir.path().join("music").join("bgm.mp3");
        fs::create_dir_all(music.parent().unwrap()).unwrap();
        fs::write(&music, b"mp3-bytes").unwrap();
        project.post.bgm = Some(BgmTrack {
            material_id: "mat-1".into(),
            name: "热血".into(),
            path: music.display().to_string(),
            volume: 60,
            ducking: true,
            duck_volume: 20,
            looping: true,
        });

        let dest = dir.path().join("pack");
        export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            None,
        )
        .unwrap();

        let sh = fs::read_to_string(dest.join(RENDER_SH)).unwrap();
        let expected = normalize_path(&music);
        assert!(sh.contains(&expected), "{sh}");
        assert!(sh.contains("-stream_loop -1"));
    }

    #[test]
    fn export_post_pack_writes_extra_text_formats() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let project = sample_project(&root);
        let dest = dir.path().join("pack");

        export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            None,
        )
        .unwrap();

        let vtt = fs::read_to_string(dest.join(SUBTITLES_VTT)).unwrap();
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:00.200 --> 00:00:01.100"));

        let lines = fs::read_to_string(dest.join(SCRIPT_LINES)).unwrap();
        assert!(lines.contains("[第 1 镜]"));
        assert!(lines.contains("你好"));

        let edl = fs::read_to_string(dest.join(TIMELINE_EDL)).unwrap();
        assert!(edl.contains("FCM: NON-DROP FRAME"));
        assert!(edl.contains(
            "001  AX       V     C        00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00"
        ));
        assert!(edl.contains("* FROM CLIP NAME: clips/001_01.mp4"));

        // 有音频，分轨脚本应当一并产出。
        assert!(dest.join(RENDER_STEMS_SH).is_file());
        assert!(dest.join(RENDER_STEMS_BAT).is_file());
        let stems_sh = fs::read_to_string(dest.join(RENDER_STEMS_SH)).unwrap();
        assert!(stems_sh.contains(STEM_VOICE));
        assert!(stems_sh.contains("-c:a pcm_s16le"));
    }

    #[test]
    fn export_post_pack_can_skip_optional_outputs() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let project = sample_project(&root);
        let dest = dir.path().join("pack");

        let options = PostPackOptions {
            self_contained: false,
            webvtt: false,
            script_lines: false,
            edl: false,
            stems: false,
        };
        export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            Some(options),
        )
        .unwrap();

        assert!(!dest.join(SUBTITLES_VTT).exists());
        assert!(!dest.join(SCRIPT_LINES).exists());
        assert!(!dest.join(TIMELINE_EDL).exists());
        assert!(!dest.join(RENDER_STEMS_SH).exists());
        assert!(dest.join(RENDER_SH).is_file());
    }

    #[test]
    fn export_post_pack_self_contained_copies_media_and_rewrites_paths() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let project = sample_project(&root);
        let dest = dir.path().join("pack");

        let options = PostPackOptions {
            self_contained: true,
            ..PostPackOptions::default()
        };
        let outcome = export_post_pack(
            root.display().to_string(),
            project,
            dest.display().to_string(),
            Some(options),
        )
        .unwrap();

        let clip = dest.join(MEDIA_DIR).join("clip_001.mp4");
        let voice = dest.join(MEDIA_DIR).join("voice_002.wav");
        assert!(clip.is_file(), "片段未复制进 media/");
        assert!(voice.is_file(), "配音未复制进 media/");
        assert!(outcome
            .files
            .iter()
            .any(|file| file == "media/clip_001.mp4"));

        let sh = fs::read_to_string(dest.join(RENDER_SH)).unwrap();
        assert!(sh.contains("media/clip_001.mp4"));
        assert!(!sh.contains("/clips/001_01.mp4"), "{sh}");

        let materials = fs::read_to_string(dest.join(MATERIALS_CSV)).unwrap();
        assert!(materials.contains("media/clip_001.mp4"));
        assert!(materials.contains("media/voice_002.wav"));

        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dest.join(MANIFEST_JSON)).unwrap()).unwrap();
        assert_eq!(manifest["selfContained"], true);

        let readme = fs::read_to_string(dest.join(README_TXT)).unwrap();
        assert!(readme.contains("已自带媒体"));
        assert!(readme.contains("media/clip_001.mp4"));
    }

    #[test]
    fn stem_graphs_cover_the_expected_roles() {
        let inputs = vec![
            InputKind::Video {
                transition: Transition::Cut,
                duration_ms: 3_000,
            },
            InputKind::Voice { start_ms: 200 },
            InputKind::Bgm { volume: 50 },
            InputKind::Sfx {
                at_ms: 500,
                volume: 80,
            },
        ];
        let stems = stem_graphs(&inputs, true);
        let files: Vec<&str> = stems.iter().map(|stem| stem.file).collect();
        assert_eq!(files, vec![STEM_VOICE, STEM_BGM, STEM_SFX, STEM_NOVOICE]);

        let voice = stems.iter().find(|s| s.role == AudioRole::Voice).unwrap();
        assert!(voice.graph.contains("adelay=200:all=1"));
        assert!(voice.graph.contains("[aout]"));
        assert!(!voice.graph.contains(SIDECHAIN));

        let bgm = stems.iter().find(|s| s.role == AudioRole::Bgm).unwrap();
        assert!(bgm.graph.contains(SIDECHAIN));
        assert!(bgm.graph.contains("[aout]"));

        let sfx = stems.iter().find(|s| s.role == AudioRole::Sfx).unwrap();
        assert!(sfx.graph.contains("adelay=500:all=1"));

        let novoice = stems.iter().find(|s| s.role == AudioRole::NoVoice).unwrap();
        assert!(novoice.graph.contains(SIDECHAIN));
        assert!(novoice.graph.contains("adelay=500:all=1"));

        // 没有 BGM 时不出「无配音」分轨。
        let only_voice = stem_graphs(&[InputKind::Voice { start_ms: 0 }], false);
        assert_eq!(only_voice.len(), 1);
        assert_eq!(only_voice[0].file, STEM_VOICE);
    }

    #[test]
    fn edl_timecode_counts_frames_at_the_project_fps() {
        assert_eq!(edl_time(0, 30), "00:00:00:00");
        assert_eq!(edl_time(1_000, 30), "00:00:01:00");
        assert_eq!(edl_time(3_500, 30), "00:00:03:15");
        assert_eq!(edl_time(1_000, 25), "00:00:01:00");
        assert_eq!(edl_time(1_000, 0), "00:00:01:00");
    }
}

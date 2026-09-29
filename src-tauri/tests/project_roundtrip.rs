//! 集成测试：`project.json` 全字段往返 + 键名/枚举字面量稳定性 + 稀疏 JSON 容错。
//!
//! 这些断言是前端 `src/lib/types.ts` 的契约护栏：只要字段改名或枚举
//! 字面量发生变化，这里会先失败，避免静默破坏已落盘的项目文件。

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use tempfile::tempdir;

use takekit_lib::project::store;
use takekit_lib::project::*;

/// 构造一份"所有字段都不是默认值"的样例项目，用于验证序列化无损。
fn sample_project() -> Project {
    let mut per_provider = BTreeMap::new();
    per_provider.insert(
        "kling".to_string(),
        json!({ "model": "kling-v1", "duration": 5 }),
    );
    per_provider.insert("seedance".to_string(), json!({ "model": "seedance-1" }));

    let meta = Meta {
        title: "总裁的替身新娘".into(),
        kind: WorkKind::ShortVideo,
        genre: "都市逆袭".into(),
        platform: "抖音".into(),
        audience: "18-30 女性".into(),
        aspect_ratio: AspectRatio::Landscape,
        resolution: "1920x1080".into(),
        fps: 24,
        episode_duration_ms: 90_000,
        episode_count: 7,
        language: "zh-CN".into(),
        subtitle_language: "en-US".into(),
        visual_style: "赛博朋克".into(),
        mood: "紧张".into(),
        style_keywords: vec!["霓虹".into(), "雨夜".into()],
        style_ref_images: vec!["assets/style/ref-1.png".into()],
        default_video_model: "seedance".into(),
        default_image_model: "seedream".into(),
        default_llm: "deepseek".into(),
        default_voice: "男声·磁性".into(),
        param_preset: "电影感".into(),
    };

    let shot = Shot {
        id: "shot-1".into(),
        episode_id: "ep-1".into(),
        scene_id: "scene-1".into(),
        no: 3,
        shot_size: ShotSize::CloseUp,
        camera_move: CameraMove::PushIn,
        duration_ms: 4_500,
        visual_desc: "女主推开玻璃门走入雨中".into(),
        characters: vec!["char-1".into()],
        dialogue: Some("我不需要你的怜悯。".into()),
        narration: Some("那一夜，她决定改变。".into()),
        sfx_hint: "雨声 + 远处雷鸣".into(),
        transition: Transition::Dissolve,
        note: "注意眼神光".into(),
        prompt_bundle: Some(PromptBundle {
            unified: UnifiedPrompt {
                subject: "年轻女性".into(),
                environment: "雨夜街头".into(),
                camera: "近景 推镜".into(),
                lighting: "侧逆光".into(),
                style: "赛博朋克".into(),
                quality: "4K 电影质感".into(),
            },
            zh: "雨夜街头，年轻女性近景……".into(),
            en: "Rainy street, close-up of a young woman...".into(),
            params: VideoParams {
                duration_ms: 4_500,
                aspect_ratio: AspectRatio::Landscape,
                resolution: "1920x1080".into(),
                fps: 24,
                motion_strength: 0.75,
                seed: Some(42),
                negative_prompt: "低清, 变形".into(),
                ref_images: vec![RefImage {
                    path: "assets/characters/char-1/portrait.png".into(),
                    weight: 0.85,
                }],
                first_frame: Some("keyframes/shot-1/first.png".into()),
                last_frame: Some("keyframes/shot-1/last.png".into()),
            },
            per_provider,
        }),
        adopted_clip_id: Some("clip-1".into()),
        frames: vec![Frame {
            id: "frame-1".into(),
            role: FrameRole::Last,
            candidates: vec!["keyframes/shot-1/c1.png".into()],
            adopted: Some("keyframes/shot-1/c1.png".into()),
            ref_shot_id: Some("shot-0".into()),
        }],
    };

    let scene = Scene {
        id: "scene-1".into(),
        no: 2,
        location: "写字楼大厅".into(),
        time_of_day: "night".into(),
        interior: false,
        characters: vec!["char-1".into()],
        action_desc: "两人对峙".into(),
        dialogues: vec![Dialogue {
            character_id: "char-1".into(),
            text: "让开。".into(),
            is_narration: true,
        }],
        shots: vec![shot],
    };

    let episode = Episode {
        id: "ep-1".into(),
        no: 5,
        title: "第一集".into(),
        summary: "她回来了".into(),
        beats: vec!["现身".into(), "反转".into()],
        scenes: vec![scene],
    };

    let assets = Assets {
        characters: vec![Character {
            id: "char-1".into(),
            name: "林晚".into(),
            aliases: vec!["小晚".into()],
            age: "24".into(),
            gender: "女".into(),
            appearance: Appearance {
                face_shape: "鹅蛋脸".into(),
                hair: "长直发".into(),
                hair_color: "黑".into(),
                eye_color: "深棕".into(),
                height: "168cm".into(),
                body: "纤细".into(),
            },
            costumes: vec![Costume {
                id: "costume-1".into(),
                name: "晚礼服".into(),
                description: "黑色丝绒".into(),
                ref_image: Some("assets/characters/char-1/costume-1.png".into()),
            }],
            personality: "外冷内热".into(),
            speech_style: "简短克制".into(),
            voice: "女声·清冷".into(),
            ref_images: vec!["assets/characters/char-1/ref.png".into()],
            portrait: Some("assets/characters/char-1/portrait.png".into()),
        }],
        scenes: vec![SceneAsset {
            id: "scene-asset-1".into(),
            name: "写字楼大厅".into(),
            interior: true,
            time_of_day: "night".into(),
            weather: "rain".into(),
            description: "冷色调大理石".into(),
            lighting: "顶灯 + 地面反射".into(),
            ref_images: vec!["assets/scenes/s1.png".into()],
        }],
        props: vec![Prop {
            id: "prop-1".into(),
            name: "婚戒".into(),
            description: "铂金素圈".into(),
            ref_image: Some("assets/props/p1.png".into()),
        }],
        style_lock: StyleLock {
            prompt_template: "电影感, 浅景深".into(),
            ref_images: vec!["assets/style/lock.png".into()],
            seed: Some(7),
        },
    };

    let task = Task {
        id: "task-1".into(),
        kind: TaskKind::Image,
        provider: "jimeng".into(),
        request: json!({ "prompt": "hello" }),
        status: TaskStatus::Succeeded,
        result: Some(json!({ "url": "https://example.com/a.png" })),
        error: None,
        created_at: "2026-09-29T08:00:00Z".into(),
    };

    Project {
        schema_version: SCHEMA_VERSION,
        id: "proj-1".into(),
        name: "样例项目".into(),
        created_at: "2026-09-29T08:00:00Z".into(),
        updated_at: "2026-09-29T09:30:00Z".into(),
        meta,
        episodes: vec![episode],
        assets,
        tasks: vec![task],
        template_refs: vec![TemplateRef {
            id: "tpl-1".into(),
            kind: "hook".into(),
        }],
        exports: vec![ExportRecord {
            id: "export-1".into(),
            kind: "final".into(),
            path: "exports/final.mp4".into(),
            created_at: "2026-09-29T10:00:00Z".into(),
        }],
    }
}

#[test]
fn project_json_roundtrip_preserves_all_fields() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let project = sample_project();

    store::write_project(root, &project).unwrap();
    let loaded = store::read_project(root).unwrap();

    assert_eq!(loaded, project, "roundtrip must be lossless");
}

#[test]
fn project_json_uses_camel_case_keys() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    store::write_project(root, &sample_project()).unwrap();

    let text = fs::read_to_string(store::project_file(root)).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();

    // 顶层 + meta
    assert_eq!(value["schemaVersion"], json!(SCHEMA_VERSION));
    assert!(value.get("createdAt").is_some());
    assert!(value.get("updatedAt").is_some());
    assert!(value.get("templateRefs").is_some());
    for key in [
        "aspectRatio",
        "episodeDurationMs",
        "episodeCount",
        "styleRefImages",
        "defaultVideoModel",
        "paramPreset",
    ] {
        assert!(
            value["meta"].get(key).is_some(),
            "meta.{key} must be camelCase"
        );
    }

    // 分镜 + 出题产物
    let shot = &value["episodes"][0]["scenes"][0]["shots"][0];
    for key in [
        "shotSize",
        "cameraMove",
        "durationMs",
        "visualDesc",
        "sfxHint",
        "promptBundle",
        "adoptedClipId",
        "frames",
    ] {
        assert!(shot.get(key).is_some(), "shot.{key} must be camelCase");
    }
    assert_eq!(shot["promptBundle"]["unified"]["subject"], "年轻女性");
    assert!(shot["promptBundle"]["perProvider"]["kling"].is_object());
    assert_eq!(shot["frames"][0]["refShotId"], "shot-0");

    // 资产
    assert!(value["assets"]["styleLock"].is_object());
    assert_eq!(
        value["assets"]["characters"][0]["appearance"]["faceShape"],
        "鹅蛋脸"
    );
}

#[test]
fn enum_literals_are_stable() {
    let cases: Vec<(Value, &str)> = vec![
        (json!(WorkKind::ShortDrama), "short_drama"),
        (json!(WorkKind::ShortVideo), "short_video"),
        (json!(AspectRatio::Portrait), "9:16"),
        (json!(AspectRatio::Landscape), "16:9"),
        (json!(AspectRatio::Square), "1:1"),
        (json!(ShotSize::ExtremeLong), "extreme_long"),
        (json!(ShotSize::LongShot), "long_shot"),
        (json!(ShotSize::MediumShot), "medium_shot"),
        (json!(ShotSize::CloseUp), "close_up"),
        (json!(ShotSize::ExtremeCloseUp), "extreme_close_up"),
        (json!(CameraMove::StaticShot), "static_shot"),
        (json!(CameraMove::PushIn), "push_in"),
        (json!(CameraMove::Orbit), "orbit"),
        (json!(Transition::Cut), "cut"),
        (json!(Transition::WhipPan), "whip_pan"),
        (json!(FrameRole::First), "first"),
        (json!(FrameRole::Last), "last"),
        (json!(TaskKind::Llm), "llm"),
        (json!(TaskKind::Image), "image"),
        (json!(TaskKind::Video), "video"),
        (json!(TaskStatus::Queued), "queued"),
        (json!(TaskStatus::Canceled), "canceled"),
    ];

    for (actual, expected) in cases {
        assert_eq!(actual, json!(expected), "enum literal drift detected");
    }

    // 每个枚举字面量必须能被反序列化回原值（双向稳定）。
    let roundtrip: AspectRatio = serde_json::from_value(json!("16:9")).unwrap();
    assert_eq!(roundtrip, AspectRatio::Landscape);
    let roundtrip: WorkKind = serde_json::from_value(json!("short_video")).unwrap();
    assert_eq!(roundtrip, WorkKind::ShortVideo);
    assert!(!roundtrip.is_drama());
    assert!(WorkKind::ShortDrama.is_drama());
}

#[test]
fn new_project_has_single_default_episode() {
    for kind in [WorkKind::ShortDrama, WorkKind::ShortVideo] {
        let project = Project::new("测试项目", kind);
        assert_eq!(project.schema_version, SCHEMA_VERSION);
        assert_eq!(
            project.episodes.len(),
            1,
            "both kinds start with one episode"
        );
        assert_eq!(project.episodes[0].no, 1);
        assert_eq!(project.episodes[0].title, "主片");
        assert_eq!(project.meta.kind, kind);
        assert_eq!(project.meta.title, "测试项目");
        assert!(!project.id.is_empty());
        assert_eq!(project.main_episode().unwrap().id, project.episodes[0].id);
    }
}

#[test]
fn sparse_json_falls_back_to_defaults() {
    // 只给最少字段，其余走 `#[serde(default)]`：旧文件仍可加载。
    let sparse = json!({
        "name": "极简项目",
        "meta": { "title": "极简项目" }
    });
    let project: Project = serde_json::from_value(sparse).unwrap();

    assert_eq!(project.name, "极简项目");
    assert_eq!(project.meta.title, "极简项目");
    assert_eq!(project.meta.kind, WorkKind::ShortDrama);
    assert_eq!(project.meta.aspect_ratio, AspectRatio::Portrait);
    assert_eq!(project.meta.fps, 30);
    assert_eq!(project.meta.default_video_model, "kling");
    assert!(project.episodes.is_empty());
    assert!(project.assets.characters.is_empty());
    assert!(project.tasks.is_empty());

    // 空对象（连 name 都没有）也必须能解析。
    let empty: Project = serde_json::from_value(json!({})).unwrap();
    assert_eq!(empty.schema_version, 0);
    assert!(empty.main_episode().is_none());

    // Shot 的时长/景别默认值参与下游参数继承，单独锁定。
    let shot: Shot = serde_json::from_value(json!({})).unwrap();
    assert_eq!(shot.duration_ms, 3_000);
    assert_eq!(shot.shot_size, ShotSize::MediumShot);
    assert_eq!(shot.camera_move, CameraMove::StaticShot);
    assert_eq!(shot.transition, Transition::Cut);
    assert!(shot.prompt_bundle.is_none());
}

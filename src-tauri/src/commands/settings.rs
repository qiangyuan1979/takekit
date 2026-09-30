//! 设置命令：模型接入配置（base_url / model 落 settings.json，api_key 落密钥库）。

use crate::commands::app_data_dir;
use crate::error::AppResult;
use crate::project::store::atomic_write;
use crate::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 设置文件名（位于应用数据目录下，不含任何密钥）。
pub const SETTINGS_FILE: &str = "settings.json";

/// 单个 provider 的接入配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConfig {
    pub base_url: String,
    /// 仅在前端内存与密钥库中存在；落 `settings.json` 前会被清空。
    pub api_key: String,
    pub model: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
        }
    }
}

/// LLM 生成参数（只作用于文本模型，故不塞进通用的 `ProviderConfig`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmOptions {
    pub temperature: f64,
    pub max_tokens: u32,
}

impl Default for LlmOptions {
    fn default() -> Self {
        Self {
            temperature: 0.8,
            max_tokens: 2048,
        }
    }
}

/// 全局设置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub llm: ProviderConfig,
    pub llm_options: LlmOptions,
    pub image: ProviderConfig,
    pub video: ProviderConfig,
    pub language: String,
    pub onboarding_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            llm: ProviderConfig {
                base_url: "https://api.openai.com/v1".into(),
                api_key: String::new(),
                model: "gpt-4o-mini".into(),
            },
            llm_options: LlmOptions::default(),
            image: ProviderConfig::default(),
            video: ProviderConfig::default(),
            language: "zh-CN".into(),
            onboarding_enabled: true,
        }
    }
}

/// 三个 provider 槽位与其密钥键名，避免在多处重复维护同一份名单。
fn slots(settings: &AppSettings) -> [(&ProviderConfig, &'static str); 3] {
    [
        (&settings.llm, "llm"),
        (&settings.image, "image"),
        (&settings.video, "video"),
    ]
}

fn settings_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SETTINGS_FILE)
}

/// 读取设置（不含密钥的磁盘内容 + 密钥库里的 api_key）。
#[tauri::command]
pub fn get_settings(app: AppHandle) -> AppResult<AppSettings> {
    let data = app_data_dir(&app)?;
    let mut settings = read_settings(&data)?;
    let secrets = SecretStore::new(&data);
    for (config, slot) in [
        (&mut settings.llm, "llm"),
        (&mut settings.image, "image"),
        (&mut settings.video, "video"),
    ] {
        config.api_key = secrets.get(&api_key_key(slot))?.unwrap_or_default();
    }
    Ok(settings)
}

/// 保存设置：api_key 拆到密钥库，其余落 `settings.json`。
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> AppResult<AppSettings> {
    let data = app_data_dir(&app)?;
    fs::create_dir_all(&data)?;

    let secrets = SecretStore::new(&data);
    for (config, slot) in slots(&settings) {
        let key = api_key_key(slot);
        if config.api_key.is_empty() {
            secrets.remove(&key)?;
        } else {
            secrets.set(&key, &config.api_key)?;
        }
    }

    let mut persisted = settings.clone();
    persisted.llm.api_key.clear();
    persisted.image.api_key.clear();
    persisted.video.api_key.clear();
    let bytes = serde_json::to_vec_pretty(&persisted)?;
    atomic_write(&settings_file(&data), &bytes)?;

    Ok(settings)
}

/// 密钥库中的键名。
fn api_key_key(slot: &str) -> String {
    format!("{slot}.api_key")
}

/// 取当前 LLM 接入配置（含密钥库里的 api_key），供适配器层建 provider。
///
/// 单独抽出来是为了让密钥只在这一处从密钥库流入内存，命令层不重复拼装。
pub(crate) fn load_llm_config(app: &AppHandle) -> AppResult<(ProviderConfig, LlmOptions)> {
    let data = app_data_dir(app)?;
    let mut settings = read_settings(&data)?;
    let secrets = SecretStore::new(&data);
    settings.llm.api_key = secrets.get(&api_key_key("llm"))?.unwrap_or_default();
    Ok((settings.llm, settings.llm_options))
}

/// 取当前图片接入配置（含密钥库里的 api_key），供图片适配器建 provider。
pub(crate) fn load_image_config(app: &AppHandle) -> AppResult<ProviderConfig> {
    let data = app_data_dir(app)?;
    let mut settings = read_settings(&data)?;
    let secrets = SecretStore::new(&data);
    settings.image.api_key = secrets.get(&api_key_key("image"))?.unwrap_or_default();
    Ok(settings.image)
}

/// 取当前视频接入配置（含密钥库里的 api_key），供视频适配器建 generator。
pub(crate) fn load_video_config(app: &AppHandle) -> AppResult<ProviderConfig> {
    let data = app_data_dir(app)?;
    let mut settings = read_settings(&data)?;
    let secrets = SecretStore::new(&data);
    settings.video.api_key = secrets.get(&api_key_key("video"))?.unwrap_or_default();
    Ok(settings.video)
}

/// 读 `settings.json`；缺失或损坏时回落默认值（不阻塞启动）。
fn read_settings(app_data_dir: &Path) -> AppResult<AppSettings> {
    let path = settings_file(app_data_dir);
    if !path.is_file() {
        return Ok(AppSettings::default());
    }
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice::<AppSettings>(&bytes).unwrap_or_default())
}

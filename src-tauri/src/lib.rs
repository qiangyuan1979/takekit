pub mod adapters;
pub mod commands;
pub mod error;
pub mod project;
pub mod refsheet;
pub mod secrets;
pub mod storyboard;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::generate::CancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::list_recent_projects,
            commands::project::duplicate_project,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::llm::llm_complete,
            commands::llm::llm_stream,
            commands::asset::import_asset_image,
            commands::asset::delete_asset_files,
            commands::asset::delete_asset_dir,
            commands::asset::generate_asset_images,
            commands::export::export_storyboard,
            commands::export::import_storyboard,
            commands::export::export_handover_pack,
            commands::prompt::list_video_providers,
            commands::prompt::translate_video_request,
            commands::generate::list_video_generators,
            commands::generate::generate_clips,
            commands::generate::cancel_clip_tasks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

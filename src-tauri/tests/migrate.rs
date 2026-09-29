//! 集成测试：`schemaVersion` 迁移框架。
//!
//! 规则锁定：缺失/非法版本视作基线并补写当前版本；高于当前版本必须拒绝
//! （避免新版字段被静默丢弃）；非对象根视为校验失败。

use serde_json::{json, Value};

use takekit_lib::error::AppError;
use takekit_lib::project::migrate;
use takekit_lib::project::SCHEMA_VERSION;

#[test]
fn missing_version_is_stamped_to_current() {
    let migrated = migrate::migrate_to_current(json!({ "name": "旧项目" })).unwrap();
    assert_eq!(migrated["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(migrated["name"], "旧项目", "已有字段必须原样保留");
}

#[test]
fn illegal_version_is_treated_as_baseline() {
    for bad in [json!(0), json!("abc"), json!(null), json!(-3)] {
        let value = json!({ "schemaVersion": bad, "name": "x" });
        assert_eq!(
            migrate::peek_version(&value),
            SCHEMA_VERSION,
            "illegal version {bad} must fall back to baseline"
        );
        let migrated = migrate::migrate_to_current(value).unwrap();
        assert_eq!(migrated["schemaVersion"], json!(SCHEMA_VERSION));
    }
}

#[test]
fn future_version_is_rejected() {
    let value = json!({ "schemaVersion": SCHEMA_VERSION + 1 });
    let err = migrate::migrate_to_current(value).unwrap_err();
    assert_eq!(err.code(), "schema_too_new");
    match err {
        AppError::SchemaTooNew { found, supported } => {
            assert_eq!(found, SCHEMA_VERSION + 1);
            assert_eq!(supported, SCHEMA_VERSION);
        }
        other => panic!("expected SchemaTooNew, got {other:?}"),
    }
}

#[test]
fn current_version_passes_through() {
    let value = json!({ "schemaVersion": SCHEMA_VERSION, "name": "新项目" });
    assert!(!migrate::needs_migration(&value));

    let migrated = migrate::migrate_to_current(value).unwrap();
    assert_eq!(migrated["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(migrated["name"], "新项目");
}

#[test]
fn needs_migration_flags_outdated_documents() {
    // 缺失版本 → 视为基线：v1 阶段与当前版本一致，无需迁移。
    assert!(!migrate::needs_migration(&json!({ "name": "x" })));
    assert!(!migrate::needs_migration(
        &json!({ "schemaVersion": SCHEMA_VERSION })
    ));
    assert!(migrate::needs_migration(
        &json!({ "schemaVersion": SCHEMA_VERSION + 3 })
    ));
}

#[test]
fn non_object_root_is_rejected() {
    for bad in [json!([1, 2, 3]), json!("text"), json!(42), Value::Null] {
        let err = migrate::migrate_to_current(bad).unwrap_err();
        assert_eq!(err.code(), "validation", "non-object root must be rejected");
    }
}

use super::*;
use axum::{
    body::{Body, to_bytes},
    http::StatusCode,
};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn app(directory: &tempfile::TempDir) -> Router {
    let mut config: Config = serde_json::from_value(json!({
        "users": { "user_configs": [
            { "name": "admin", "token": "admin", "vault_access": { "type": "allow_access_to_all" } },
            { "name": "mixed", "token": "mixed", "vault_access": { "type": "allow_list", "allowed": [" MyVault "] } },
            { "name": "composed", "token": "composed", "vault_access": { "type": "allow_list", "allowed": ["café"] } },
            { "name": "decomposed", "token": "decomposed", "vault_access": { "type": "allow_list", "allowed": ["cafe\u{301}"] } }
        ] }
    })).unwrap();
    config.database.databases_directory_path = directory.path().join("databases");
    let state = AppState::try_new(config).await.unwrap();
    get_authed_routes(state.clone()).with_state(state)
}

async fn request(app: Router, path: &str, token: &str, body: Option<Value>) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .uri(path)
                .method(if body.is_some() {
                    Method::PUT
                } else {
                    Method::GET
                })
                .header(http::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(http::header::CONTENT_TYPE, "application/json")
                .header("Device-Id", "test")
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn http_rejects_encoded_traversal_and_accepts_normalized_allowlists() {
    let directory = tempfile::tempdir().unwrap();
    let app = app(&directory).await;
    for vault in [
        "..%2Fescaped",
        "%2Fabsolute",
        "a%5Cb",
        "%2E%2E",
        "%20",
        "a%00b",
    ] {
        let (status, _) = request(
            app.clone(),
            &format!("/vaults/{vault}/vault_snapshot"),
            "admin",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "vault: {vault}");
    }
    assert!(!directory.path().join("escaped.sqlite").exists());
    for vault in ["MyVault", "myvault", "%20MYVAULT%20"] {
        let (status, _) = request(
            app.clone(),
            &format!("/vaults/{vault}/file_manifest"),
            "mixed",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "vault: {vault}");
    }
    assert_eq!(
        request(app, "/vaults/other/file_manifest", "mixed", None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn http_keeps_unicode_vaults_separate_across_restart() {
    let directory = tempfile::tempdir().unwrap();
    let router = app(&directory).await;
    let document = uuid::Uuid::new_v4();
    let composed = format!("/vaults/caf%C3%A9/documents/{document}");
    let decomposed = format!("/vaults/cafe%CC%81/documents/{document}");
    let push = json!({
        "requestId": uuid::Uuid::new_v4(), "parentVersionId": null,
        "content": { "type": "Snapshot", "value": "aGVsbG8=" }
    });
    assert_eq!(
        request(router, &composed, "composed", Some(push)).await.0,
        StatusCode::OK
    );

    let reopened = app(&directory).await;
    assert_eq!(
        request(reopened.clone(), &composed, "decomposed", None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(reopened.clone(), &decomposed, "decomposed", None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, version) = request(reopened, &composed, "composed", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(version["contentBase64"], "aGVsbG8=");
}

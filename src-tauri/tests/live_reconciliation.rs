use os_scribe_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_scribe_lib::domain::types::RecordingSourceMode;
use sqlx::sqlite::SqlitePoolOptions;

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

struct SessionFixture {
    repos: Repositories,
    note_id: String,
    session_id: String,
    artifact_id: String,
}

async fn session_fixture() -> SessionFixture {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note");
    let session_id = "live-session".to_string();
    repos
        .create_recording_session(
            &note.id,
            &session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "partial.wav",
            "final.wav",
            None,
        )
        .await
        .expect("session");
    let artifact = repos
        .create_pending_source_artifact(
            &note.id,
            &session_id,
            "microphone",
            "partial.wav",
            "final.wav",
        )
        .await
        .expect("artifact");
    SessionFixture {
        repos,
        note_id: note.id,
        session_id,
        artifact_id: artifact.id,
    }
}

async fn upsert_turn(
    fixture: &SessionFixture,
    source: &str,
    text: &str,
    start_ms: i64,
    end_ms: i64,
    turn_index: i64,
) {
    fixture
        .repos
        .upsert_successful_source_turn_transcript(
            &fixture.note_id,
            &fixture.session_id,
            &fixture.artifact_id,
            RecordingSourceMode::MicrophonePlusSystem,
            source,
            text,
            Some("en".to_string()),
            "test",
            start_ms,
            end_ms,
            turn_index,
        )
        .await
        .expect("upsert turn transcript");
}

#[tokio::test]
async fn prune_removes_provisional_rows_that_match_no_final_turn() {
    let fixture = session_fixture().await;
    // Two provisional live rows (keyed by start time) and one already-final row.
    upsert_turn(&fixture, "microphone", "live one", 1_000, 4_000, 1_000).await;
    upsert_turn(&fixture, "system", "live two", 5_000, 8_000, 5_000).await;
    upsert_turn(&fixture, "microphone", "final zero", 1_000, 4_000, 0).await;

    let pruned = fixture
        .repos
        .prune_source_turn_transcripts(
            &fixture.session_id,
            &[("microphone".to_string(), 0), ("system".to_string(), 1)],
        )
        .await
        .expect("prune");

    assert_eq!(pruned, 2, "both provisional rows are removed");
    let rows = fixture
        .repos
        .successful_source_turn_transcripts_for_session(&fixture.session_id)
        .await
        .expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].text, "final zero");
    assert_eq!(rows[0].turn_index, Some(0));
}

#[tokio::test]
async fn prune_keeps_all_rows_matching_final_turns() {
    let fixture = session_fixture().await;
    upsert_turn(&fixture, "microphone", "turn zero", 0, 2_000, 0).await;
    upsert_turn(&fixture, "system", "turn one", 2_500, 5_000, 1).await;

    let pruned = fixture
        .repos
        .prune_source_turn_transcripts(
            &fixture.session_id,
            &[("microphone".to_string(), 0), ("system".to_string(), 1)],
        )
        .await
        .expect("prune");

    assert_eq!(pruned, 0);
    let rows = fixture
        .repos
        .successful_source_turn_transcripts_for_session(&fixture.session_id)
        .await
        .expect("rows");
    assert_eq!(rows.len(), 2);
}

#[tokio::test]
async fn reconciliation_upsert_replaces_provisional_row_sharing_the_final_key() {
    let fixture = session_fixture().await;
    // A live turn that started at 0ms gets provisional index 0 — the same key
    // a final turn 0 would use. Reconciliation upserts over it in place.
    upsert_turn(&fixture, "microphone", "provisional", 0, 2_000, 0).await;
    upsert_turn(&fixture, "microphone", "reconciled", 0, 2_100, 0).await;

    let rows = fixture
        .repos
        .successful_source_turn_transcripts_for_session(&fixture.session_id)
        .await
        .expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].text, "reconciled");
    assert_eq!(rows[0].end_ms, Some(2_100));
}

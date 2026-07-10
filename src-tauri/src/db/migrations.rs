use sqlx::query::query;
use sqlx_sqlite::SqlitePool;

pub async fn run_migrations(_pool: &SqlitePool) -> Result<(), sqlx::error::Error> {
    for statement in include_str!("../../migrations/001_init.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(
        _pool,
        "recording_sessions",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_sessions", "permission_summary", "TEXT").await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "source",
        "TEXT NOT NULL DEFAULT 'microphone'",
    )
    .await?;
    ensure_column(_pool, "audio_artifacts", "partial_path", "TEXT").await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "status",
        "TEXT NOT NULL DEFAULT 'valid'",
    )
    .await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "expected_duration_ms",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(_pool, "audio_artifacts", "validation_summary", "TEXT").await?;
    ensure_column(_pool, "audio_artifacts", "last_error", "TEXT").await?;
    ensure_column(_pool, "transcripts", "recording_session_id", "TEXT").await?;
    ensure_column(_pool, "transcripts", "source_artifact_id", "TEXT").await?;
    ensure_column(_pool, "transcripts", "source", "TEXT").await?;
    ensure_column(_pool, "transcripts", "start_ms", "INTEGER").await?;
    ensure_column(_pool, "transcripts", "end_ms", "INTEGER").await?;
    ensure_column(_pool, "transcripts", "turn_index", "INTEGER").await?;
    ensure_column(
        _pool,
        "transcripts",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_checkpoints", "source", "TEXT").await?;
    ensure_column(_pool, "recording_checkpoints", "source_artifact_id", "TEXT").await?;
    ensure_column(_pool, "folders", "description", "TEXT").await?;
    // Folder names don't need to be unique — each folder has a stable
    // UUID, and the user may legitimately want two "Inbox"es etc.
    drop_index_if_exists(_pool, "idx_folders_active_name").await?;
    for statement in include_str!("../../migrations/002_source_modes.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/003_generation_blocks.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/004_dictionary.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/005_dictation_history.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    // The dedupe DELETE in this migration scans `transcripts`, so only run it
    // until the unique index exists. Once present, there is nothing left to
    // dedupe and re-running on every startup would be wasted work.
    if !index_exists(_pool, "idx_transcripts_session_source_turn").await? {
        for statement in
            include_str!("../../migrations/006_transcript_turn_uniqueness.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                query(statement).execute(_pool).await?;
            }
        }
    }
    for statement in include_str!("../../migrations/007_agent.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(_pool, "agent_tasks", "hermes_session_id", "TEXT").await?;
    // `external_id` records the Hermes-side identity of hydrated agent
    // messages so concurrent hydrations cannot double-insert the same
    // message. The dedupe DELETE in this migration scans `agent_messages`,
    // so only run it until the unique index exists (matching the pattern
    // used for migration 006 above).
    ensure_column(_pool, "agent_messages", "external_id", "TEXT").await?;
    if !index_exists(_pool, "idx_agent_messages_task_external_id").await? {
        for statement in include_str!("../../migrations/008_agent_message_identity.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                query(statement).execute(_pool).await?;
            }
        }
    }
    for statement in include_str!("../../migrations/009_session_folders.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/010_p3a_counters.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(
        _pool,
        "p3a_counters",
        "reported_value",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(_pool, "p3a_counters", "reported_at", "TEXT").await?;
    for statement in include_str!("../../migrations/011_connectors.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/012_connector_grants.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/013_connector_credited_runs.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    // The first connector schema constrained trigger/grant enums to Google.
    // Rebuild those two small metadata tables once when upgrading to the
    // provider-neutral local connector shape.
    if !table_sql_contains(_pool, "connector_triggers", "linear_assignment").await?
        || !table_sql_contains(_pool, "connector_grants", "'notion'").await?
    {
        // Both tables move together in one transaction. An interrupted app
        // launch must never leave a renamed `_old` table or only half of the
        // provider constraints upgraded.
        let mut tx = _pool.begin().await?;
        for statement in
            include_str!("../../migrations/014_connector_provider_checks.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                query(statement).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
    }
    // Marks when a routine most recently entered approval mode; approval-run
    // crediting only counts runs that finished at or after this instant, so
    // earlier read-only runs never retroactively unlock autonomy.
    ensure_column(_pool, "routine_trust", "approval_since", "TEXT").await?;
    Ok(())
}

async fn table_sql_contains(
    pool: &SqlitePool,
    table: &str,
    needle: &str,
) -> Result<bool, sqlx::error::Error> {
    use sqlx::row::Row;
    let row = query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(table)
        .fetch_optional(pool)
        .await?;
    Ok(row
        .and_then(|row| row.try_get::<String, _>("sql").ok())
        .is_some_and(|sql| sql.contains(needle)))
}

async fn index_exists(pool: &SqlitePool, index: &str) -> Result<bool, sqlx::error::Error> {
    let row = query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .bind(index)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::error::Error> {
    let pragma = format!("PRAGMA table_info({table})");
    let rows = query(&pragma).fetch_all(pool).await?;
    let exists = rows.iter().any(|row| {
        use sqlx::row::Row;
        row.get::<String, _>("name") == column
    });
    if !exists {
        let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        match query(&alter).execute(pool).await {
            Ok(_) => {}
            Err(error) if is_duplicate_column_error(&error, column) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn is_duplicate_column_error(error: &sqlx::error::Error, column: &str) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("duplicate column name") && message.contains(&column.to_lowercase())
}

async fn drop_index_if_exists(pool: &SqlitePool, index: &str) -> Result<(), sqlx::error::Error> {
    let sql = format!("DROP INDEX IF EXISTS {}", quote_sqlite_identifier(index));
    query(&sql).execute(pool).await?;
    Ok(())
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::row::Row;

    #[tokio::test]
    async fn upgrades_legacy_connector_checks_without_losing_rows() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite memory");
        query(
            "CREATE TABLE connector_triggers (
              id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('email_received', 'event_upcoming')),
              account_id TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("legacy triggers");
        query(
            "CREATE TABLE connector_grants (
              job_id TEXT NOT NULL,
              provider TEXT NOT NULL CHECK(provider IN ('gmail','gcal')),
              server_name TEXT NOT NULL, token TEXT NOT NULL,
              tools TEXT NOT NULL DEFAULT '[]', account_id TEXT NOT NULL,
              created_at TEXT NOT NULL, PRIMARY KEY (job_id, provider)
            )",
        )
        .execute(&pool)
        .await
        .expect("legacy grants");
        query(
            "INSERT INTO connector_triggers
             (id, job_id, kind, account_id, config, created_at)
             VALUES ('t1', 'j1', 'email_received', 'user@example.com', '{}', 'now')",
        )
        .execute(&pool)
        .await
        .expect("legacy trigger row");
        query(
            "INSERT INTO connector_grants
             (job_id, provider, server_name, token, tools, account_id, created_at)
             VALUES ('j1', 'gmail', 'june_gmail_auto_j1', 'token', '[]', 'user@example.com', 'now')",
        )
        .execute(&pool)
        .await
        .expect("legacy grant row");

        run_migrations(&pool).await.expect("upgrade migrations");

        query(
            "INSERT INTO connector_triggers
             (id, job_id, kind, account_id, config, created_at)
             VALUES ('t2', 'j2', 'linear_assignment', 'linear:workspace', '{}', 'now')",
        )
        .execute(&pool)
        .await
        .expect("new trigger kind");
        query(
            "INSERT INTO connector_grants
             (job_id, provider, server_name, token, tools, account_id, created_at)
             VALUES ('j2', 'notion', 'june_notion_auto_j2', 'token-2', '[]', 'notion:workspace', 'now')",
        )
        .execute(&pool)
        .await
        .expect("new grant provider");
        let trigger_count = query("SELECT COUNT(*) AS count FROM connector_triggers")
            .fetch_one(&pool)
            .await
            .expect("count triggers")
            .get::<i64, _>("count");
        let grant_count = query("SELECT COUNT(*) AS count FROM connector_grants")
            .fetch_one(&pool)
            .await
            .expect("count grants")
            .get::<i64, _>("count");
        assert_eq!(trigger_count, 2);
        assert_eq!(grant_count, 2);
    }
}

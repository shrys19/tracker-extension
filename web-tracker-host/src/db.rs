use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::messages::SessionPayload;

pub fn open_db() -> Result<Connection> {
    let db_path =
        database_path()?;

    let conn =
        Connection::open(db_path)?;

    // Each native-messaging request is a separate, short-lived process
    // opening the same file. The busy timeout makes a writer wait for
    // the lock instead of failing with SQLITE_BUSY when another browser
    // (e.g. Chrome and Opera on the same machine) flushes at the same
    // time. Rollback journal (the default) is used deliberately: WAL is
    // meant for long-lived connections and, with one-shot processes,
    // defers its checkpoint into the main db so the file looks frozen.
    // Forcing DELETE here also migrates any existing WAL database back,
    // folding its -wal contents into the main file.
    conn.busy_timeout(
        Duration::from_secs(5),
    )?;

    conn.pragma_update(
        None,
        "journal_mode",
        "DELETE",
    )?;

    initialize(&conn)?;

    Ok(conn)
}

fn database_path() -> Result<PathBuf> {
    let dirs =
        ProjectDirs::from(
            "com",
            "WebTracker",
            "WebTracker",
        )
        .ok_or_else(|| {
            anyhow!(
                "unable to locate app directory"
            )
        })?;

    fs::create_dir_all(
        dirs.data_dir(),
    )?;

    Ok(
        dirs
            .data_dir()
            .join("tracker.db")
    )
}

fn initialize(
    conn: &Connection,
) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            site TEXT NOT NULL,

            start_time INTEGER NOT NULL,
            end_time INTEGER NOT NULL,

            duration_ms INTEGER NOT NULL,

            source TEXT NOT NULL,

            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_site
            ON sessions(site);

        CREATE INDEX IF NOT EXISTS idx_start_time
            ON sessions(start_time);
        "#,
    )?;

    ensure_unique_index(conn)?;

    Ok(())
}

// A session starts once at a given millisecond, so (site, start_time)
// uniquely identifies a slice; the unique index rejects race-duplicate
// inserts. But a database written by an older build may already contain
// those duplicates, and SQLite refuses to build a unique index over
// existing duplicate data ("UNIQUE constraint failed"). So if creation
// fails, dedupe (keep the lowest id per group) and retry once. Once the
// index exists this is a no-op, so the dedupe only runs on first heal.
fn ensure_unique_index(
    conn: &Connection,
) -> Result<()> {
    const CREATE: &str = "
        CREATE UNIQUE INDEX IF NOT EXISTS idx_site_start
            ON sessions(site, start_time)
    ";

    if conn.execute(CREATE, []).is_err() {
        conn.execute(
            "
            DELETE FROM sessions
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM sessions
                GROUP BY site, start_time
            )
            ",
            [],
        )?;

        conn.execute(CREATE, [])?;
    }

    Ok(())
}

pub fn insert_session(
    conn: &Connection,
    session: &SessionPayload,
) -> Result<()> {
    let created_at =
        SystemTime::now()
            .duration_since(
                UNIX_EPOCH,
            )?
            .as_millis() as i64;

    conn.execute(
        r#"
        INSERT OR IGNORE INTO sessions (
            site,
            start_time,
            end_time,
            duration_ms,
            source,
            created_at
        )
        VALUES (
            ?, ?, ?, ?, ?, ?
        )
        "#,
        params![
            session.site,
            session.start_time,
            session.end_time,
            session.duration_ms,
            "chrome",
            created_at
        ],
    )?;

    Ok(())
}

use serde::Serialize;

#[derive(Serialize)]
pub struct SiteSummary {
    pub site: String,
    pub duration_ms: i64,
}

#[derive(Serialize)]
pub struct ReportResponse {
    pub status: String,
    pub sites: Vec<SiteSummary>,
}

pub fn generate_report(
    conn: &Connection,
) -> anyhow::Result<ReportResponse>
{
    let mut stmt =
        conn.prepare(
            "
            SELECT
                site,
                SUM(duration_ms)
            FROM sessions
            GROUP BY site
            ORDER BY SUM(duration_ms) DESC
            "
        )?;

    let rows =
        stmt.query_map(
            [],
            |row| {
                Ok(
                    SiteSummary {
                        site:
                            row.get(0)?,
                        duration_ms:
                            row.get(1)?,
                    }
                )
            },
        )?;

    let mut sites =
        Vec::new();

    for row in rows {
        sites.push(row?);
    }

    Ok(
        ReportResponse {
            status:
                "ok".into(),
            sites,
        }
    )
}
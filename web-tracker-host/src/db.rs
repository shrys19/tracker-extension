use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::messages::{
    ExportQuery,
    SessionPayload,
};

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
pub struct SessionRow {
    pub id: i64,
    pub site: String,
    pub start_time: i64,
    pub end_time: i64,
    pub duration_ms: i64,
    pub source: String,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct ReportResponse {
    pub status: String,
    pub sites: Vec<SiteSummary>,
}

#[derive(Serialize)]
pub struct ExportResponse {
    pub status: String,
    pub sites: Vec<SiteSummary>,
    pub sessions: Vec<SessionRow>,
}

// COALESCE(?, start_time) makes a NULL bound a no-op: start_time is
// always >= / <= itself, so an absent bound matches every row.
const RANGE_FILTER: &str = "
    WHERE start_time >= COALESCE(?1, start_time)
      AND start_time <= COALESCE(?2, start_time)
";

fn query_site_summaries(
    conn: &Connection,
    since: Option<i64>,
    until: Option<i64>,
) -> anyhow::Result<Vec<SiteSummary>> {
    let sql = format!(
        "
        SELECT
            site,
            SUM(duration_ms)
        FROM sessions
        {RANGE_FILTER}
        GROUP BY site
        ORDER BY SUM(duration_ms) DESC
        "
    );

    let mut stmt =
        conn.prepare(&sql)?;

    let rows =
        stmt.query_map(
            params![since, until],
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

    Ok(sites)
}

// Lightweight: per-site totals only, all-time. Used by the popup list,
// which refreshes frequently, so it must not haul every raw row over
// the wire.
pub fn generate_report(
    conn: &Connection,
) -> anyhow::Result<ReportResponse>
{
    Ok(
        ReportResponse {
            status:
                "ok".into(),
            sites:
                query_site_summaries(
                    conn,
                    None,
                    None,
                )?,
        }
    )
}

// Full dump: per-site totals plus every raw session row, optionally
// restricted to a [since, until] window (epoch ms, by start_time).
// Used only by the export buttons (on demand).
pub fn generate_export(
    conn: &Connection,
    query: &ExportQuery,
) -> anyhow::Result<ExportResponse>
{
    let since = query.since;
    let until = query.until;

    let sites =
        query_site_summaries(
            conn, since, until,
        )?;

    let sql = format!(
        "
        SELECT
            id,
            site,
            start_time,
            end_time,
            duration_ms,
            source,
            created_at
        FROM sessions
        {RANGE_FILTER}
        ORDER BY start_time
        "
    );

    let mut stmt =
        conn.prepare(&sql)?;

    let session_rows =
        stmt.query_map(
            params![since, until],
            |row| {
                Ok(
                    SessionRow {
                        id:
                            row.get(0)?,
                        site:
                            row.get(1)?,
                        start_time:
                            row.get(2)?,
                        end_time:
                            row.get(3)?,
                        duration_ms:
                            row.get(4)?,
                        source:
                            row.get(5)?,
                        created_at:
                            row.get(6)?,
                    }
                )
            },
        )?;

    let mut sessions =
        Vec::new();

    for row in session_rows {
        sessions.push(row?);
    }

    Ok(
        ExportResponse {
            status:
                "ok".into(),
            sites,
            sessions,
        }
    )
}
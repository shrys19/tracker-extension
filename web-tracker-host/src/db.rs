use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::messages::SessionPayload;

pub fn open_db() -> Result<Connection> {
    let db_path =
        database_path()?;

    let conn =
        Connection::open(db_path)?;

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
        INSERT INTO sessions (
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
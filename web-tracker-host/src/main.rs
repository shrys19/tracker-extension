mod db;
mod messages;
mod native;

use anyhow::Result;

use db::{
    insert_session,
    open_db,
};

use messages::{
    Request,
    Response,
};

use native::{
    read_message,
    write_message,
};

fn main() {
    if let Err(err) = run() {
        let response =
            Response::error(
                err.to_string(),
            );

        let _ =
            write_message(
                &response,
            );
    }
}

fn run() -> Result<()> {
    let raw_message =
        read_message()?;

    let request: Request =
        serde_json::from_slice(
            &raw_message,
        )?;

    let conn =
        open_db()?;

    match request {
    Request::Session(session) => {
        insert_session(
            &conn,
            &session,
        )?;

        write_message(
            &Response::ok(
                "session stored",
            ),
        )?;
    }

    Request::Report => {
        let report =
            db::generate_report(
                &conn,
            )?;

        write_message(
            &report,
        )?;
    }

    Request::Export => {
        let export =
            db::generate_export(
                &conn,
            )?;

        write_message(
            &export,
        )?;
    }
}

    Ok(())
}
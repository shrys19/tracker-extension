use anyhow::Result;
use serde::Serialize;
use std::io::{self, Read, Write};

pub fn read_message() -> Result<Vec<u8>> {
    let mut stdin = io::stdin();

    let mut length_bytes = [0u8; 4];

    stdin.read_exact(&mut length_bytes)?;

    let length =
        u32::from_le_bytes(length_bytes)
            as usize;

    let mut buffer =
        vec![0u8; length];

    stdin.read_exact(&mut buffer)?;

    Ok(buffer)
}

pub fn write_message<T>(
    value: &T,
) -> Result<()>
where
    T: Serialize,
{
    let payload =
        serde_json::to_vec(value)?;

    let length =
        (payload.len() as u32)
            .to_le_bytes();

    let mut stdout =
        io::stdout();

    stdout.write_all(&length)?;
    stdout.write_all(&payload)?;
    stdout.flush()?;

    Ok(())
}
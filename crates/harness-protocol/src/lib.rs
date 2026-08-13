//! Rust representation of Harness protocol v2.
//!
//! The TypeScript contracts remain the wire oracle during the migration. These
//! types deliberately preserve their field names and discriminants so a native
//! client can connect to the existing server before the server itself moves.

mod domain;
mod wire;

pub use domain::*;
pub use wire::*;

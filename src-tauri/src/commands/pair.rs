//! Phone pairing (Auracle iOS spine, M5 — LAN + QR).
//!
//! One command powers the launcher's "Pair a phone" surface: mint a
//! short-lived single-use token from the engine (owner key over
//! loopback), discover this Mac's LAN address, and probe whether the
//! engine actually answers at that address. The engine can't see the
//! host's LAN address from inside Docker, so composing the QR is the
//! launcher's job — and the compose default binds the engine port to
//! 127.0.0.1, so the truthful first-run answer here is usually
//! `reachable: false` until the operator opts in with
//! `AURACLE_LAN_BIND=0.0.0.0` in `.env`. The UI must show that state
//! honestly instead of a QR that can't work.
//!
//! The token is a 5-minute bootstrap secret: never logged, never in an
//! error string, and single-use on the engine side.

use std::net::UdpSocket;
use std::time::Duration;

use super::engine_auth::{fetch_owner_api_key, ENGINE_BASE};

const PAIR_MINT_PATH: &str = "/api/mobile/pair";
const TIMEOUT_SECS: u64 = 8;
const PROBE_TIMEOUT_SECS: u64 = 3;

#[derive(serde::Serialize)]
pub struct PairInfo {
    /// This machine's outbound-facing LAN address, when one exists.
    pub lan_ip: Option<String>,
    /// True when the engine answered /healthz at the LAN address — a
    /// phone on the same network can reach it too (modulo a host
    /// firewall, which we can't see from here).
    pub reachable: bool,
    /// The engine URL the QR carries (None when no LAN address).
    pub url: Option<String>,
    pub token: String,
    pub expires_in: u64,
}

/// The address this host uses to reach the network. A UDP `connect`
/// assigns the local address without sending a single packet, so this
/// is instant and offline-safe; None when the host has no route.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

#[tauri::command]
pub async fn mobile_pair_info() -> Result<PairInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .no_proxy()
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "The engine hasn't shared its owner key yet — finish setup on this \
         machine first."
            .to_string()
    })?;

    // Mint (owner-gated, single-use, 5-minute TTL). Bare /api is
    // CSRF-exempt, so the owner key alone authenticates this loopback hop.
    let resp = client
        .post(format!("{ENGINE_BASE}{PAIR_MINT_PATH}"))
        .header("X-API-Key", &owner_key)
        .header("Cookie", format!("auracle_session={owner_key}"))
        .send()
        .await
        .map_err(|e| format!("engine unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "the engine declined to mint a pairing code (HTTP {})",
            resp.status().as_u16()
        ));
    }

    #[derive(serde::Deserialize)]
    struct Mint {
        token: String,
        expires_in: u64,
    }
    let mint: Mint = resp
        .json()
        .await
        .map_err(|e| format!("bad mint response: {e}"))?;

    // Where a phone would find us — and can anything actually get in?
    let lan = lan_ip();
    let url = lan.as_ref().map(|ip| format!("http://{ip}:1969"));
    let mut reachable = false;
    if let Some(u) = &url {
        let probe = reqwest::Client::builder()
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
            .no_proxy()
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        reachable = matches!(
            probe.get(format!("{u}/healthz")).send().await,
            Ok(r) if r.status().is_success()
        );
    }

    Ok(PairInfo {
        lan_ip: lan,
        reachable,
        url,
        token: mint.token,
        expires_in: mint.expires_in,
    })
}

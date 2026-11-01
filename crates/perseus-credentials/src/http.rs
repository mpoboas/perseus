//! Minimal HTTP transport for OAuth calls. A trait, so the protocol logic can be
//! tested without a network; the real implementation is deliberately restrictive.

use std::time::Duration;

use crate::validate;

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub trait Http: Send + Sync {
    /// POSTs a form and returns the response whatever its status: OAuth servers
    /// report protocol errors (`authorization_pending`, `invalid_grant`) as 4xx
    /// JSON bodies, which the caller must read.
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<HttpResponse, String>;
}

const MAX_BODY_BYTES: u64 = 256 * 1024;

pub struct UreqHttp {
    agent: ureq::Agent,
}

impl UreqHttp {
    pub fn new() -> Self {
        use ureq::tls::{RootCerts, TlsConfig};
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // A token endpoint has no reason to redirect, and following a redirect
            // would re-send client credentials somewhere else.
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(20)))
            // The OS trust store, so self-hosted servers with an internal CA work.
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .user_agent("Perseus")
            .build()
            .into();
        Self { agent }
    }
}

impl Default for UreqHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl Http for UreqHttp {
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<HttpResponse, String> {
        if !validate::endpoint_url(url) {
            return Err("refusing to contact an unsafe URL".into());
        }
        let mut resp = self
            .agent
            .post(url)
            .header("Accept", "application/json")
            .send_form(form.iter().copied())
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok(HttpResponse { status, body })
    }
}

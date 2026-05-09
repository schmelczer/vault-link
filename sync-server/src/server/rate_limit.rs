use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{extract::Request, http::StatusCode, middleware::Next, response::Response};
use axum_extra::{
    TypedHeader,
    headers::{Authorization, authorization::Bearer},
};

/// Per-user token-bucket rate limiter. Each bearer token gets its own bucket
/// that refills to `max_per_second` tokens every second.
#[derive(Clone, Debug)]
pub struct RateLimiter {
    max_per_second: u64,
    buckets: Arc<Mutex<HashMap<String, Arc<TokenBucket>>>>,
}

#[derive(Debug)]
struct TokenBucket {
    state: Mutex<BucketState>,
    max_tokens: u64,
}

#[derive(Debug)]
struct BucketState {
    tokens: u64,
    last_refill: Instant,
}

impl RateLimiter {
    /// Create a new per-user rate limiter.
    pub fn new(max_per_second: u64) -> Self {
        Self {
            max_per_second,
            buckets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn get_or_create_bucket(
        &self,
        token: &str,
    ) -> std::result::Result<Arc<TokenBucket>, StatusCode> {
        let mut buckets = self
            .buckets
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        Ok(buckets
            .entry(token.to_owned())
            .or_insert_with(|| {
                Arc::new(TokenBucket {
                    state: Mutex::new(BucketState {
                        tokens: self.max_per_second,
                        last_refill: Instant::now(),
                    }),
                    max_tokens: self.max_per_second,
                })
            })
            .clone())
    }
}

impl TokenBucket {
    fn try_acquire(&self) -> std::result::Result<bool, StatusCode> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let now = Instant::now();
        if now.duration_since(state.last_refill).as_secs() >= 1 {
            state.tokens = self.max_tokens;
            state.last_refill = now;
        }
        if state.tokens > 0 {
            state.tokens = state.tokens.saturating_sub(1);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

pub async fn rate_limit_middleware(
    axum::extract::State(limiter): axum::extract::State<RateLimiter>,
    auth_header: Option<TypedHeader<Authorization<Bearer>>>,
    req: Request,
    next: Next,
) -> std::result::Result<Response, StatusCode> {
    let Some(TypedHeader(auth)) = auth_header else {
        return Ok(next.run(req).await);
    };

    let bucket = limiter.get_or_create_bucket(auth.token())?;
    if bucket.try_acquire()? {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::TOO_MANY_REQUESTS)
    }
}

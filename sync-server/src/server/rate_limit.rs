use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use axum::{extract::Request, http::StatusCode, middleware::Next, response::Response};

/// Simple token-bucket rate limiter that refills every second.
#[derive(Clone, Debug)]
pub struct RateLimiter {
    inner: Arc<TokenBucket>,
}

#[derive(Debug)]
struct TokenBucket {
    tokens: AtomicU64,
    max_tokens: u64,
}

impl RateLimiter {
    /// Create a new rate limiter. Spawns a background task that refills tokens
    /// every second.
    ///
    /// # Panics
    ///
    /// Panics if `max_per_second` is 0.
    pub fn new(max_per_second: u64) -> Self {
        assert!(
            max_per_second > 0,
            "max_per_second must be > 0 (use 0 in config to disable rate limiting entirely)"
        );

        let bucket = Arc::new(TokenBucket {
            tokens: AtomicU64::new(max_per_second),
            max_tokens: max_per_second,
        });

        let bucket_clone = bucket.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                interval.tick().await;
                bucket_clone
                    .tokens
                    .store(bucket_clone.max_tokens, Ordering::Release);
            }
        });

        Self { inner: bucket }
    }

    fn try_acquire(&self) -> bool {
        self.inner
            .tokens
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                if current > 0 { Some(current - 1) } else { None }
            })
            .is_ok()
    }
}

pub async fn rate_limit_middleware(
    axum::extract::State(limiter): axum::extract::State<RateLimiter>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if limiter.try_acquire() {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::TOO_MANY_REQUESTS)
    }
}

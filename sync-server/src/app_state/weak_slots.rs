use std::{
    collections::HashMap,
    future::Future,
    hash::Hash,
    ops::DerefMut,
    sync::{Arc, Weak},
};

/// Get-or-create an `Arc<T>` for `key` in a weak map behind a mutex
pub async fn get_or_create<K, T, G, L>(lock: L, key: K, create: impl FnOnce() -> Arc<T>) -> Arc<T>
where
    K: Clone + Eq + Hash,
    G: DerefMut<Target = HashMap<K, Weak<T>>>,
    L: Future<Output = G>,
{
    let mut map = lock.await;
    map.retain(|_, value| value.strong_count() > 0);

    if let Some(value) = map.get(&key).and_then(Weak::upgrade) {
        value
    } else {
        let value = create();
        map.insert(key, Arc::downgrade(&value));
        value
    }
}

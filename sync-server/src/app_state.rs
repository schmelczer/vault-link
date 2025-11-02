pub mod cursors;
pub mod database;
pub mod websocket;

use anyhow::Result;
use cursors::Cursors;
use database::Database;
use websocket::broadcasts::Broadcasts;

use crate::config::Config;

#[derive(Clone, Debug)]
pub struct AppState {
    pub config: Config,
    pub database: Database,
    pub cursors: Cursors,
    pub broadcasts: Broadcasts,
}

impl AppState {
    pub async fn try_new(config: Config) -> Result<Self> {
        let broadcasts = Broadcasts::new(&config.server);
        let database = Database::try_new(&config.database, &broadcasts).await?;
        let cursors: Cursors = Cursors::new(&config.database, &broadcasts);

        Cursors::start_background_task(cursors.clone());

        Ok(Self {
            config,
            database,
            cursors,
            broadcasts,
        })
    }
}

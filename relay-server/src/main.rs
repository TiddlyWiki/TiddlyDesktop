use axum::{
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, Json, Path, Query, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{delete, get, post},
    Router,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::broadcast;
use tracing::{info, warn};

// ── Limits ──────────────────────────────────────────────────────────

/// Room code constraints
const MIN_ROOM_CODE_LEN: usize = 6;
const MAX_ROOM_CODE_LEN: usize = 64;

/// Max members per room
const MAX_MEMBERS_PER_ROOM: usize = 10;

/// Max concurrent WebSocket connections per IP
const MAX_CONNECTIONS_PER_IP: usize = 20;

/// Max binary message size (2 MB)
const MAX_MESSAGE_SIZE: usize = 2 * 1024 * 1024;

/// Liveness deadline: drop a connection (and its room membership) if no frame of
/// ANY kind has arrived for this long. Clients auto-respond to our pings with
/// pongs, which count as activity, so a LIVE peer always refreshes well within this
/// window — only a dead/half-open socket reaches it. Kept short so a member from a
/// session that ended uncleanly is reaped (and a MemberLeft broadcast) in ~1 minute
/// rather than lingering as a "ghost" that every new joiner inherits.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Interval between server-sent ping frames. Must be comfortably shorter than
/// IDLE_TIMEOUT so a live peer gets several pongs in before the deadline (here ~3).
const PING_INTERVAL: Duration = Duration::from_secs(20);

/// Broadcast channel capacity per room. A subscriber that falls more than this many messages
/// behind gets `RecvError::Lagged` and PERMANENTLY misses those frames (the client only recovers
/// them via its periodic manifest). Each subscriber drains into an unbounded per-connection queue
/// (see `broadcast_task`), so lag only happens under a genuine burst the forwarder can't keep up
/// with — kept generous so a manifest/asset storm can't silently drop sync frames.
const ROOM_CHANNEL_CAPACITY: usize = 8192;

/// Grace period: keep token-protected (sync) rooms alive after last member leaves
const SYNC_ROOM_GRACE_PERIOD: Duration = Duration::from_secs(300);

/// Max total rooms
const MAX_TOTAL_ROOMS: usize = 10_000;

/// Max total connections
const MAX_TOTAL_CONNECTIONS: usize = 50_000;

/// Per-connection rate limit: bucket capacity (burst size)
const RATE_LIMIT_BUCKET_BYTES: u64 = 10 * 1024 * 1024; // 10 MB burst

/// Per-connection rate limit: refill rate
const RATE_LIMIT_REFILL_PER_SEC: u64 = 512 * 1024; // 512 KB/s sustained

/// Auth token validation cache TTL
const AUTH_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes

/// Stale user threshold: clean up users not seen for this long (30 days)
const STALE_USER_THRESHOLD: Duration = Duration::from_secs(30 * 86400);

/// TTL for pending auth results (server-side OAuth callback flow)
const PENDING_AUTH_RESULT_TTL: Duration = Duration::from_secs(300); // 5 minutes

/// Lifetime of a membership certificate issued to a joining client. The relay
/// re-issues one on every (re)connect, so this only needs to outlast a session.
const MEMBERSHIP_CERT_TTL_SECS: i64 = 12 * 3600; // 12 hours

// ── Types ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct AuthUser {
    user_id: String,  // "github:12345", "gitlab:67890", "oidc:sub-claim"
    username: String,
    provider: String, // "github", "gitlab", "oidc"
}

#[derive(Clone, Debug, PartialEq)]
enum AuthProvider {
    GitHub,
    GitLab,
    Oidc,
}

impl AuthProvider {
    fn from_header(headers: &HeaderMap) -> Self {
        match headers
            .get("x-auth-provider")
            .and_then(|v| v.to_str().ok())
        {
            Some("gitlab") => AuthProvider::GitLab,
            Some("oidc") => AuthProvider::Oidc,
            _ => AuthProvider::GitHub,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            AuthProvider::GitHub => "github",
            AuthProvider::GitLab => "gitlab",
            AuthProvider::Oidc => "oidc",
        }
    }
}

#[derive(Clone)]
struct OidcConfig {
    issuer: String,
    token_endpoint: String,
    jwks: jsonwebtoken::jwk::JwkSet,
    fetched_at: Instant,
}

#[derive(Deserialize)]
struct OidcDiscovery {
    issuer: String,
    token_endpoint: String,
    jwks_uri: String,
}

/// Result of a server-side OAuth code exchange, stored temporarily for deep-link retrieval.
#[derive(Clone, Debug)]
struct PendingAuthResult {
    access_token: String,
    user_id: String,
    username: String,
    provider: String,
}

/// Query params for the OAuth callback GET endpoints.
#[derive(Deserialize)]
struct AuthCallbackQuery {
    code: String,
    state: String,
}

/// Query params for the auth result retrieval endpoint.
#[derive(Deserialize)]
struct AuthResultQuery {
    state: String,
}

#[derive(Clone)]
struct AppState {
    /// Active in-memory rooms (room_hash → Room)
    rooms: Arc<DashMap<String, Room>>,
    ip_connections: Arc<DashMap<std::net::IpAddr, AtomicU64>>,
    total_connections: Arc<AtomicU64>,
    /// Persistent storage for rooms/members
    db: Arc<tokio::sync::Mutex<rusqlite::Connection>>,
    /// Auth token validation cache: "provider:SHA256(token)" → (AuthUser, cached_at)
    auth_cache: Arc<DashMap<String, (AuthUser, Instant)>>,
    /// GitHub OAuth App credentials
    github_client_id: String,
    github_client_secret: String,
    /// GitLab OAuth credentials
    gitlab_client_id: String,
    gitlab_client_secret: String,
    gitlab_url: String,
    /// OIDC credentials
    oidc_client_id: String,
    oidc_client_secret: String,
    oidc_discovery_url: String,
    oidc_provider_name: String,
    oidc_username_claim: String,
    /// Cached OIDC config (discovery doc + JWKS)
    oidc_config: Arc<tokio::sync::RwLock<Option<OidcConfig>>>,
    /// HTTP client for API calls
    http_client: reqwest::Client,
    /// For forced disconnection: room_hash → Vec<(user_id, kill_sender)>
    kill_channels: Arc<DashMap<String, Vec<(String, tokio::sync::oneshot::Sender<()>)>>>,
    /// Admin API token (from ADMIN_TOKEN env var)
    admin_token: String,
    /// Pending auth results from server-side OAuth callbacks (state_token → (result, created_at))
    pending_auth_results: Arc<DashMap<String, (PendingAuthResult, Instant)>>,
    /// ECDSA P-256 key used to sign membership certificates. The relay vouches,
    /// per connection, that a given deviceId belongs to an OAuth-authenticated
    /// user; peers verify the signature so they accept collaboration traffic only
    /// from users the relay has authenticated.
    signing_key: Arc<SigningKey>,
    /// Public half of `signing_key`, as a JWK, handed to clients so they can verify.
    relay_jwk: Arc<serde_json::Value>,
    /// Key id (kid) of `relay_jwk`.
    relay_kid: Arc<String>,
}

struct Room {
    tx: broadcast::Sender<RoomMessage>,
    members: DashMap<String, MemberInfo>,
    created_at: Instant,
    emptied_at: Option<Instant>,
    /// Room token set by first authenticated joiner (kept for E2E verification).
    room_token: Option<String>,
}

#[derive(Clone)]
struct MemberInfo {
    device_id: String,
}

#[derive(Clone)]
struct RoomMessage {
    from_device_id: String,
    data: Vec<u8>,
    is_text: bool,
}

/// Join message from client
#[derive(Deserialize)]
struct JoinMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "roomToken")]
    room_token: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "members")]
    Members { members: Vec<String> },
    #[serde(rename = "member_joined")]
    MemberJoined {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    #[serde(rename = "member_left")]
    MemberLeft {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    #[serde(rename = "removed")]
    Removed { message: String },
    #[serde(rename = "error")]
    Error { message: String },
    /// Relay-signed proof that this connection belongs to an OAuth-authenticated
    /// user. `cert` is a compact JWS (ES256) binding the user's identity to the
    /// client's deviceId and room; `jwk` is the relay's public verification key.
    #[serde(rename = "identity")]
    Identity {
        cert: String,
        jwk: serde_json::Value,
    },
}

// ── REST API types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct AuthExchangeRequest {
    code: String,
    redirect_uri: String,
}

#[derive(Deserialize)]
struct CreateRoomRequest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    room_code: Option<String>,
    /// Encrypted room credentials (room_code + password), encrypted with
    /// the owner's device key. Opaque to the server — only the owner's
    /// device can decrypt this.
    #[serde(default)]
    encrypted_credentials: Option<String>,
}

#[derive(Serialize)]
struct CreateRoomResponse {
    room_code: String,
    name: String,
}

#[derive(Serialize)]
struct ListRoomEntry {
    room_code: String,
    name: String,
    owner_username: String,
    owner_provider: String,
    role: String, // "owner" or "member"
    member_count: i64,
    /// Encrypted credentials blob (only returned for rooms the user owns)
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_credentials: Option<String>,
}

#[derive(Deserialize)]
struct AddMemberRequest {
    username: String,
    #[serde(default = "default_github_provider")]
    provider: String,
    #[serde(default)]
    user_id: Option<String>,
}

fn default_github_provider() -> String {
    "github".to_string()
}

#[derive(Serialize)]
struct RoomMemberEntry {
    user_id: String,
    username: String,
    provider: String,
    role: String,
    added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked: Option<bool>,
}

// ── Main ────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tiddlydesktop_relay=info".into()),
        )
        .init();

    // Load GitHub OAuth credentials
    let github_client_id = std::env::var("GITHUB_CLIENT_ID").unwrap_or_default();
    let github_client_secret = std::env::var("GITHUB_CLIENT_SECRET").unwrap_or_default();

    // Load GitLab OAuth credentials
    let gitlab_client_id = std::env::var("GITLAB_CLIENT_ID").unwrap_or_default();
    let gitlab_client_secret = std::env::var("GITLAB_CLIENT_SECRET").unwrap_or_default();
    let gitlab_url = std::env::var("GITLAB_URL").unwrap_or_else(|_| "https://gitlab.com".to_string());

    // Load OIDC credentials
    let oidc_client_id = std::env::var("OIDC_CLIENT_ID").unwrap_or_default();
    let oidc_client_secret = std::env::var("OIDC_CLIENT_SECRET").unwrap_or_default();
    let oidc_discovery_url = std::env::var("OIDC_DISCOVERY_URL").unwrap_or_default();
    let oidc_provider_name = std::env::var("OIDC_PROVIDER_NAME").unwrap_or_default();
    let oidc_username_claim =
        std::env::var("OIDC_USERNAME_CLAIM").unwrap_or_else(|_| "preferred_username".to_string());

    // Log enabled providers
    let github_enabled =
        !github_client_id.is_empty() && !github_client_secret.is_empty();
    let gitlab_enabled =
        !gitlab_client_id.is_empty() && !gitlab_client_secret.is_empty();
    let oidc_enabled = !oidc_client_id.is_empty()
        && !oidc_client_secret.is_empty()
        && !oidc_discovery_url.is_empty();

    if github_enabled {
        info!("Auth provider enabled: GitHub");
    } else {
        warn!("GITHUB_CLIENT_ID and/or GITHUB_CLIENT_SECRET not set — GitHub OAuth disabled");
    }
    if gitlab_enabled {
        info!("Auth provider enabled: GitLab ({})", gitlab_url);
    }
    if oidc_enabled {
        let name = if oidc_provider_name.is_empty() {
            "oidc"
        } else {
            &oidc_provider_name
        };
        info!("Auth provider enabled: OIDC ({}, discovery={})", name, oidc_discovery_url);
    }
    if !github_enabled && !gitlab_enabled && !oidc_enabled {
        warn!("No auth providers configured — all authentication will fail");
    }

    let admin_token = std::env::var("ADMIN_TOKEN").unwrap_or_default();
    if admin_token.is_empty() {
        warn!("ADMIN_TOKEN not set — admin API will be disabled");
    }

    // Initialize SQLite database
    let db_path = if let Ok(state_dir) = std::env::var("STATE_DIRECTORY") {
        format!("{}/relay.db", state_dir)
    } else {
        "relay.db".to_string()
    };
    let db =
        rusqlite::Connection::open(&db_path).expect("Failed to open SQLite database");
    init_db(&db);
    info!("SQLite database opened at {}", db_path);

    // Load (or generate) the membership-certificate signing key.
    let (signing_key, relay_jwk, relay_kid) = load_or_create_signing_key(&db);
    info!("Membership-certificate signing key ready (kid={})", relay_kid);

    let http_client = reqwest::Client::builder()
        .user_agent("TiddlyDesktop-Relay")
        .timeout(Duration::from_secs(10))
        .build()
        .expect("Failed to create HTTP client");

    let state = AppState {
        rooms: Arc::new(DashMap::new()),
        ip_connections: Arc::new(DashMap::new()),
        total_connections: Arc::new(AtomicU64::new(0)),
        db: Arc::new(tokio::sync::Mutex::new(db)),
        auth_cache: Arc::new(DashMap::new()),
        github_client_id,
        github_client_secret,
        gitlab_client_id,
        gitlab_client_secret,
        gitlab_url,
        oidc_client_id,
        oidc_client_secret,
        oidc_discovery_url,
        oidc_provider_name,
        oidc_username_claim,
        oidc_config: Arc::new(tokio::sync::RwLock::new(None)),
        http_client,
        kill_channels: Arc::new(DashMap::new()),
        admin_token,
        pending_auth_results: Arc::new(DashMap::new()),
        signing_key: Arc::new(signing_key),
        relay_jwk: Arc::new(relay_jwk),
        relay_kid: Arc::new(relay_kid),
    };

    // Background task: reap stale in-memory rooms
    let reaper_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            reap_stale_rooms(&reaper_state);
        }
    });

    // Background task: clean up stale users (once on startup, then daily)
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        cleanup_stale_users(&cleanup_state).await;
        let mut interval = tokio::time::interval(Duration::from_secs(86400));
        loop {
            interval.tick().await;
            cleanup_stale_users(&cleanup_state).await;
        }
    });

    // Background task: refresh OIDC JWKS hourly (if OIDC configured)
    if oidc_enabled {
        let oidc_state = state.clone();
        tokio::spawn(async move {
            // Initial fetch
            if let Err(e) = ensure_oidc_config(&oidc_state).await {
                warn!("Initial OIDC config fetch failed: {:?}", e);
            }
            let mut interval = tokio::time::interval(Duration::from_secs(3600));
            loop {
                interval.tick().await;
                // Force refresh by clearing cached config
                {
                    let mut config = oidc_state.oidc_config.write().await;
                    *config = None;
                }
                if let Err(e) = ensure_oidc_config(&oidc_state).await {
                    warn!("OIDC JWKS refresh failed: {:?}", e);
                }
            }
        });
    }

    let app = Router::new()
        // WebSocket endpoint
        .route("/room/:room_code", get(ws_handler))
        // Health + stats
        .route("/health", get(health))
        .route("/stats", get(stats_handler))
        // Auth: exchange endpoints (per-provider + legacy alias)
        .route("/api/auth/exchange", post(auth_exchange_github))
        .route("/api/auth/exchange/github", post(auth_exchange_github))
        .route("/api/auth/exchange/gitlab", post(auth_exchange_gitlab))
        .route("/api/auth/exchange/oidc", post(auth_exchange_oidc))
        .route("/api/auth/providers", get(auth_providers))
        .route("/api/auth/user", get(auth_user))
        // Auth: server-side OAuth callbacks (for deep-link flow on Android)
        .route("/api/auth/callback/github", get(auth_callback_github))
        .route("/api/auth/callback/gitlab", get(auth_callback_gitlab))
        .route("/api/auth/callback/oidc", get(auth_callback_oidc))
        .route("/api/auth/result", get(auth_result))
        // Room management
        .route("/api/rooms", post(create_room))
        .route("/api/rooms", get(list_rooms))
        .route("/api/rooms/:code", delete(delete_room))
        // Member management
        .route("/api/rooms/:code/members", get(list_members))
        .route("/api/rooms/:code/members", post(add_member))
        .route("/api/rooms/:code/members/:user_id", delete(remove_member))
        // Admin API (protected by ADMIN_TOKEN)
        .route("/api/admin/ban", post(admin_ban_user))
        .route("/api/admin/ban", get(admin_list_banned))
        .route("/api/admin/ban/:user_id", delete(admin_unban_user))
        .route("/api/admin/stale-users", get(admin_list_stale_users))
        .with_state(state.clone());

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8443);
    let bind_addr: [u8; 4] = if std::env::var("BIND_PUBLIC").is_ok() {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
    let addr = SocketAddr::from((bind_addr, port));

    info!(
        "Relay server starting on {} (max {} connections, {} rooms)",
        addr, MAX_TOTAL_CONNECTIONS, MAX_TOTAL_ROOMS
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap();
}

// ── SQLite ──────────────────────────────────────────────────────────

fn init_db(db: &rusqlite::Connection) {
    db.execute_batch("PRAGMA journal_mode=WAL;").ok();
    db.execute_batch("PRAGMA foreign_keys=ON;").ok();

    // Schema versioning
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL
        );"
    )
    .expect("Failed to create schema_version table");

    let version: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if version < 2 {
        // Check if old-schema tables exist (v1 with github_id columns)
        let has_old_schema: bool = db
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('rooms') WHERE name='owner_github_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if has_old_schema {
            migrate_v1_to_v2(db);
        } else {
            create_v2_tables(db);
        }

        db.execute(
            "INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 2)",
            [],
        )
        .expect("Failed to set schema version");
    }

    if version < 3 {
        // Add encrypted_credentials column to rooms table (for re-join support)
        let has_col: bool = db
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('rooms') WHERE name='encrypted_credentials'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_col {
            db.execute_batch("ALTER TABLE rooms ADD COLUMN encrypted_credentials TEXT;")
                .expect("Failed to add encrypted_credentials column");
            info!("Schema v3: added encrypted_credentials column to rooms table");
        }
        db.execute(
            "INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 3)",
            [],
        )
        .expect("Failed to set schema version");
    }

    if version < 4 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS blocked_members (
                room_code TEXT NOT NULL,
                user_id TEXT NOT NULL,
                username TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'github',
                blocked_at INTEGER NOT NULL,
                PRIMARY KEY (room_code, user_id),
                FOREIGN KEY (room_code) REFERENCES rooms(room_code) ON DELETE CASCADE
            );"
        )
        .expect("Failed to create blocked_members table");
        info!("Schema v4: created blocked_members table");
        db.execute(
            "INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 4)",
            [],
        )
        .expect("Failed to set schema version");
    }

    if version < 5 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS room_tokens (
                room_code TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );"
        )
        .expect("Failed to create room_tokens table");
        info!("Schema v5: created room_tokens table");
        db.execute(
            "INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 5)",
            [],
        )
        .expect("Failed to set schema version");
    }
}

fn create_v2_tables(db: &rusqlite::Connection) {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS rooms (
            room_code TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            owner_user_id TEXT NOT NULL,
            owner_username TEXT NOT NULL,
            owner_provider TEXT NOT NULL DEFAULT 'github',
            created_at INTEGER NOT NULL,
            encrypted_credentials TEXT
        );
        CREATE TABLE IF NOT EXISTS room_members (
            room_code TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            added_at INTEGER NOT NULL,
            PRIMARY KEY (room_code, user_id),
            FOREIGN KEY (room_code) REFERENCES rooms(room_code) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS banned_users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            reason TEXT NOT NULL DEFAULT '',
            banned_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blocked_members (
            room_code TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            blocked_at INTEGER NOT NULL,
            PRIMARY KEY (room_code, user_id),
            FOREIGN KEY (room_code) REFERENCES rooms(room_code) ON DELETE CASCADE
        );"
    )
    .expect("Failed to create v2 tables");
}

fn migrate_v1_to_v2(db: &rusqlite::Connection) {
    info!("Migrating database schema from v1 to v2 (GitHub-only → multi-provider)");

    // Disable foreign keys for migration (can't change inside a transaction)
    db.execute_batch("PRAGMA foreign_keys=OFF;").ok();

    let result = db.execute_batch(
        "BEGIN TRANSACTION;

        CREATE TABLE rooms_v2 (
            room_code TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            owner_user_id TEXT NOT NULL,
            owner_username TEXT NOT NULL,
            owner_provider TEXT NOT NULL DEFAULT 'github',
            created_at INTEGER NOT NULL
        );
        INSERT INTO rooms_v2 (room_code, name, owner_user_id, owner_username, owner_provider, created_at)
            SELECT room_code, name, 'github:' || owner_github_id, owner_github_login, 'github', created_at FROM rooms;
        DROP TABLE rooms;
        ALTER TABLE rooms_v2 RENAME TO rooms;

        CREATE TABLE room_members_v2 (
            room_code TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            added_at INTEGER NOT NULL,
            PRIMARY KEY (room_code, user_id),
            FOREIGN KEY (room_code) REFERENCES rooms(room_code) ON DELETE CASCADE
        );
        INSERT INTO room_members_v2 (room_code, user_id, username, provider, added_at)
            SELECT room_code, 'github:' || github_id, github_login, 'github', added_at FROM room_members;
        DROP TABLE room_members;
        ALTER TABLE room_members_v2 RENAME TO room_members;

        CREATE TABLE banned_users_v2 (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            reason TEXT NOT NULL DEFAULT '',
            banned_at INTEGER NOT NULL
        );
        INSERT INTO banned_users_v2 (user_id, username, provider, reason, banned_at)
            SELECT 'github:' || github_id, github_login, 'github', reason, banned_at FROM banned_users;
        DROP TABLE banned_users;
        ALTER TABLE banned_users_v2 RENAME TO banned_users;

        CREATE TABLE users_v2 (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'github',
            last_seen_at INTEGER NOT NULL
        );
        INSERT INTO users_v2 (user_id, username, provider, last_seen_at)
            SELECT 'github:' || github_id, github_login, 'github', last_seen_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_v2 RENAME TO users;

        COMMIT;"
    );

    if let Err(e) = result {
        warn!("Migration failed, rolling back: {}", e);
        db.execute_batch("ROLLBACK;").ok();
        panic!("Database migration v1→v2 failed: {}", e);
    }

    db.execute_batch("PRAGMA foreign_keys=ON;").ok();
    info!("Database migration to v2 complete");
}

// ── Token Validation ────────────────────────────────────────────────

/// Hash a token with SHA-256 for use as a cache key (don't store raw tokens)
fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Load the relay's membership-certificate signing key from the DB, generating
/// and persisting a fresh ECDSA P-256 key on first run. Returns the key together
/// with its public JWK and key id, ready to drop into AppState.
fn load_or_create_signing_key(
    db: &rusqlite::Connection,
) -> (SigningKey, serde_json::Value, String) {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS relay_signing_key (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            secret_b64 TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
    .expect("Failed to create relay_signing_key table");

    let stored: Option<String> = db
        .query_row(
            "SELECT secret_b64 FROM relay_signing_key WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok();

    let key = stored
        .and_then(|b64| B64URL.decode(b64).ok())
        .filter(|bytes| bytes.len() == 32)
        .and_then(|bytes| SigningKey::from_bytes(p256::FieldBytes::from_slice(&bytes)).ok());

    let key = match key {
        Some(k) => k,
        None => {
            let k = SigningKey::random(&mut rand_core::OsRng);
            let secret_b64 = B64URL.encode(k.to_bytes());
            db.execute(
                "INSERT OR REPLACE INTO relay_signing_key (id, secret_b64, created_at) VALUES (1, ?1, ?2)",
                rusqlite::params![secret_b64, unix_secs()],
            )
            .expect("Failed to persist relay signing key");
            info!("Generated new relay membership-signing key (ECDSA P-256)");
            k
        }
    };

    let (jwk, kid) = relay_public_jwk(&key);
    (key, jwk, kid)
}

/// Build the public JWK (and its kid) for a signing key.
fn relay_public_jwk(key: &SigningKey) -> (serde_json::Value, String) {
    let point = key.verifying_key().to_encoded_point(false);
    let x = point.x().expect("P-256 point has x");
    let y = point.y().expect("P-256 point has y");
    let mut hasher = Sha256::new();
    hasher.update(x);
    hasher.update(y);
    let kid = format!("{:x}", hasher.finalize())[..16].to_string();
    let jwk = serde_json::json!({
        "kty": "EC",
        "crv": "P-256",
        "x": B64URL.encode(x),
        "y": B64URL.encode(y),
        "use": "sig",
        "alg": "ES256",
        "kid": kid,
    });
    (jwk, kid)
}

/// Mint a compact JWS (header.payload.signature, all base64url) attesting that
/// `auth_user` — verified via OAuth at the WS upgrade — is present in `room_code`
/// under `device_id`. Signed with the relay's P-256 key (ES256). Peers verify
/// this before accepting collaboration traffic from the device.
fn mint_membership_cert(
    state: &AppState,
    room_code: &str,
    auth_user: &AuthUser,
    device_id: &str,
) -> String {
    let header = serde_json::json!({
        "alg": "ES256",
        "typ": "TDCERT",
        "kid": state.relay_kid.as_str(),
    });
    let now = unix_secs();
    let payload = serde_json::json!({
        "room": room_code,
        "sub": auth_user.user_id,
        "name": auth_user.username,
        "prov": auth_user.provider,
        "did": device_id,
        "iat": now,
        "exp": now + MEMBERSHIP_CERT_TTL_SECS,
    });
    let signing_input = format!(
        "{}.{}",
        B64URL.encode(serde_json::to_vec(&header).unwrap()),
        B64URL.encode(serde_json::to_vec(&payload).unwrap()),
    );
    // ES256: ECDSA over SHA-256, signature as raw r||s (64 bytes).
    let sig: Signature = state.signing_key.sign(signing_input.as_bytes());
    format!("{}.{}", signing_input, B64URL.encode(sig.to_bytes()))
}

/// Validate an auth token, dispatching to the appropriate provider.
/// Uses a 5-minute cache to avoid hitting external APIs on every request.
async fn validate_token(
    state: &AppState,
    token: &str,
    provider: &AuthProvider,
) -> Result<AuthUser, StatusCode> {
    let cache_key = format!("{}:{}", provider.as_str(), hash_token(token));

    // Check cache
    if let Some(entry) = state.auth_cache.get(&cache_key) {
        let (user, cached_at) = entry.value();
        if cached_at.elapsed() < AUTH_CACHE_TTL {
            return Ok(user.clone());
        }
    }
    state.auth_cache.remove(&cache_key);

    // Validate with the appropriate provider
    let user = match provider {
        AuthProvider::GitHub => validate_github_token(state, token).await?,
        AuthProvider::GitLab => validate_gitlab_token(state, token).await?,
        AuthProvider::Oidc => validate_oidc_token(state, token).await?,
    };

    state
        .auth_cache
        .insert(cache_key, (user.clone(), Instant::now()));
    Ok(user)
}

/// Validate a GitHub OAuth token by calling the GitHub user API.
async fn validate_github_token(
    state: &AppState,
    token: &str,
) -> Result<AuthUser, StatusCode> {
    let resp = state
        .http_client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| {
            warn!("GitHub API request failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if !resp.status().is_success() {
        warn!("GitHub API returned {}", resp.status());
        return Err(StatusCode::BAD_GATEWAY);
    }

    let body: serde_json::Value =
        resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let id = body["id"].as_i64().ok_or(StatusCode::BAD_GATEWAY)?;
    let login = body["login"]
        .as_str()
        .ok_or(StatusCode::BAD_GATEWAY)?
        .to_string();

    Ok(AuthUser {
        user_id: format!("github:{}", id),
        username: login,
        provider: "github".to_string(),
    })
}

/// Validate a GitLab OAuth token by calling the GitLab user API.
async fn validate_gitlab_token(
    state: &AppState,
    token: &str,
) -> Result<AuthUser, StatusCode> {
    if state.gitlab_client_id.is_empty() || state.gitlab_client_secret.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let url = format!("{}/api/v4/user", state.gitlab_url);
    let resp = state
        .http_client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| {
            warn!("GitLab API request failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if !resp.status().is_success() {
        warn!("GitLab API returned {}", resp.status());
        return Err(StatusCode::BAD_GATEWAY);
    }

    let body: serde_json::Value =
        resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let id = body["id"].as_i64().ok_or(StatusCode::BAD_GATEWAY)?;
    let username = body["username"]
        .as_str()
        .ok_or(StatusCode::BAD_GATEWAY)?
        .to_string();

    Ok(AuthUser {
        user_id: format!("gitlab:{}", id),
        username,
        provider: "gitlab".to_string(),
    })
}

/// Validate an OIDC ID token (JWT) against the provider's JWKS.
async fn validate_oidc_token(
    state: &AppState,
    token: &str,
) -> Result<AuthUser, StatusCode> {
    let config = ensure_oidc_config(state).await?;

    // Decode JWT header to get kid and algorithm
    let header = jsonwebtoken::decode_header(token).map_err(|e| {
        warn!("OIDC token header decode failed: {}", e);
        StatusCode::UNAUTHORIZED
    })?;

    let kid = header.kid.ok_or_else(|| {
        warn!("OIDC token missing kid claim");
        StatusCode::UNAUTHORIZED
    })?;

    // Find matching JWK
    let jwk = config
        .jwks
        .find(&kid)
        .ok_or_else(|| {
            warn!("OIDC JWK not found for kid={}", kid);
            StatusCode::UNAUTHORIZED
        })?;

    let decoding_key =
        jsonwebtoken::DecodingKey::from_jwk(jwk).map_err(|e| {
            warn!("OIDC DecodingKey creation failed: {}", e);
            StatusCode::UNAUTHORIZED
        })?;

    let mut validation = jsonwebtoken::Validation::new(header.alg);
    validation.set_issuer(&[&config.issuer]);
    validation.set_audience(&[&state.oidc_client_id]);
    validation.leeway = 60; // 1 minute clock skew tolerance

    let token_data = jsonwebtoken::decode::<serde_json::Value>(
        token,
        &decoding_key,
        &validation,
    )
    .map_err(|e| {
        warn!("OIDC token validation failed: {}", e);
        StatusCode::UNAUTHORIZED
    })?;

    let claims = token_data.claims;
    let sub = claims["sub"]
        .as_str()
        .ok_or_else(|| {
            warn!("OIDC token missing sub claim");
            StatusCode::UNAUTHORIZED
        })?;

    // Extract username from configured claim, falling back to name → email → sub
    let username = claims[&state.oidc_username_claim]
        .as_str()
        .or_else(|| claims["name"].as_str())
        .or_else(|| claims["email"].as_str())
        .unwrap_or(sub)
        .to_string();

    Ok(AuthUser {
        user_id: format!("oidc:{}", sub),
        username,
        provider: "oidc".to_string(),
    })
}

/// Fetch and cache the OIDC discovery document + JWKS.
async fn ensure_oidc_config(state: &AppState) -> Result<OidcConfig, StatusCode> {
    if state.oidc_discovery_url.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    // Check cache
    {
        let config = state.oidc_config.read().await;
        if let Some(ref c) = *config {
            if c.fetched_at.elapsed() < Duration::from_secs(3600) {
                return Ok(c.clone());
            }
        }
    }

    // Fetch discovery document
    let discovery: OidcDiscovery = state
        .http_client
        .get(&state.oidc_discovery_url)
        .send()
        .await
        .map_err(|e| {
            warn!("OIDC discovery fetch failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?
        .json()
        .await
        .map_err(|e| {
            warn!("OIDC discovery parse failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    // Fetch JWKS
    let jwks: jsonwebtoken::jwk::JwkSet = state
        .http_client
        .get(&discovery.jwks_uri)
        .send()
        .await
        .map_err(|e| {
            warn!("OIDC JWKS fetch failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?
        .json()
        .await
        .map_err(|e| {
            warn!("OIDC JWKS parse failed: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    let config = OidcConfig {
        issuer: discovery.issuer,
        token_endpoint: discovery.token_endpoint,
        jwks,
        fetched_at: Instant::now(),
    };

    // Cache
    {
        let mut cached = state.oidc_config.write().await;
        *cached = Some(config.clone());
    }

    Ok(config)
}

// ── Auth Helpers ────────────────────────────────────────────────────

/// Extract Bearer token from Authorization header
fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

/// Authenticate a request: extract Bearer token, validate with provider, check ban list.
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthUser, StatusCode> {
    let token = extract_bearer(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let provider = AuthProvider::from_header(headers);
    let user = validate_token(state, token, &provider).await?;

    // Check if user is banned
    let db = state.db.lock().await;
    let banned: bool = db
        .query_row(
            "SELECT COUNT(*) FROM banned_users WHERE user_id = ?1",
            rusqlite::params![user.user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    drop(db);

    if banned {
        warn!(
            "Banned user {} ({}) attempted access",
            user.username, user.user_id
        );
        return Err(StatusCode::FORBIDDEN);
    }

    // Track last-seen time for stale user cleanup
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let db = state.db.lock().await;
    db.execute(
        "INSERT INTO users (user_id, username, provider, last_seen_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id) DO UPDATE SET username=?2, last_seen_at=?4",
        rusqlite::params![user.user_id, user.username, user.provider, now_unix],
    )
    .ok();
    drop(db);

    Ok(user)
}

// ── REST API: Auth ──────────────────────────────────────────────────

/// Helper: exchange a GitHub authorization code for a token and validate it.
async fn exchange_github_code(
    state: &AppState,
    code: &str,
    redirect_uri: &str,
) -> Result<PendingAuthResult, (StatusCode, String)> {
    if state.github_client_id.is_empty() || state.github_client_secret.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "GitHub OAuth not configured".to_string()));
    }

    let resp = state
        .http_client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": state.github_client_id,
            "client_secret": state.github_client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .map_err(|e| {
            warn!("GitHub token exchange failed: {}", e);
            (StatusCode::BAD_GATEWAY, "GitHub API unreachable".to_string())
        })?;

    let body: serde_json::Value = resp.json().await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid GitHub response".to_string()))?;

    if let Some(err) = body.get("error") {
        return Err((StatusCode::BAD_REQUEST, format!("{}", err)));
    }

    let access_token = body["access_token"].as_str()
        .ok_or_else(|| (StatusCode::BAD_GATEWAY, "No access_token in response".to_string()))?
        .to_string();

    let user = validate_github_token(state, &access_token).await
        .map_err(|status| (status, "Token validation failed".to_string()))?;

    let cache_key = format!("github:{}", hash_token(&access_token));
    state.auth_cache.insert(cache_key, (user.clone(), Instant::now()));

    Ok(PendingAuthResult {
        access_token,
        user_id: user.user_id,
        username: user.username,
        provider: user.provider,
    })
}

/// Helper: exchange a GitLab authorization code for a token and validate it.
async fn exchange_gitlab_code(
    state: &AppState,
    code: &str,
    redirect_uri: &str,
) -> Result<PendingAuthResult, (StatusCode, String)> {
    if state.gitlab_client_id.is_empty() || state.gitlab_client_secret.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "GitLab OAuth not configured".to_string()));
    }

    let token_url = format!("{}/oauth/token", state.gitlab_url);
    let resp = state
        .http_client
        .post(&token_url)
        .json(&serde_json::json!({
            "client_id": state.gitlab_client_id,
            "client_secret": state.gitlab_client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }))
        .send()
        .await
        .map_err(|e| {
            warn!("GitLab token exchange failed: {}", e);
            (StatusCode::BAD_GATEWAY, "GitLab API unreachable".to_string())
        })?;

    let body: serde_json::Value = resp.json().await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid GitLab response".to_string()))?;

    if let Some(err) = body.get("error") {
        return Err((StatusCode::BAD_REQUEST, format!("{}", err)));
    }

    let access_token = body["access_token"].as_str()
        .ok_or_else(|| (StatusCode::BAD_GATEWAY, "No access_token in response".to_string()))?
        .to_string();

    let user = validate_gitlab_token(state, &access_token).await
        .map_err(|status| (status, "Token validation failed".to_string()))?;

    let cache_key = format!("gitlab:{}", hash_token(&access_token));
    state.auth_cache.insert(cache_key, (user.clone(), Instant::now()));

    Ok(PendingAuthResult {
        access_token,
        user_id: user.user_id,
        username: user.username,
        provider: user.provider,
    })
}

/// Helper: exchange an OIDC authorization code for an ID token and validate it.
async fn exchange_oidc_code(
    state: &AppState,
    code: &str,
    redirect_uri: &str,
) -> Result<PendingAuthResult, (StatusCode, String)> {
    if state.oidc_client_id.is_empty()
        || state.oidc_client_secret.is_empty()
        || state.oidc_discovery_url.is_empty()
    {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "OIDC not configured".to_string()));
    }

    let config = ensure_oidc_config(state).await
        .map_err(|status| (status, "OIDC configuration unavailable".to_string()))?;

    let resp = state
        .http_client
        .post(&config.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", state.oidc_client_id.as_str()),
            ("client_secret", state.oidc_client_secret.as_str()),
        ])
        .send()
        .await
        .map_err(|e| {
            warn!("OIDC token exchange failed: {}", e);
            (StatusCode::BAD_GATEWAY, "OIDC provider unreachable".to_string())
        })?;

    let body: serde_json::Value = resp.json().await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid OIDC response".to_string()))?;

    if let Some(err) = body.get("error") {
        return Err((StatusCode::BAD_REQUEST, format!("{}", err)));
    }

    let id_token = body["id_token"].as_str()
        .ok_or_else(|| (StatusCode::BAD_GATEWAY, "No id_token in response".to_string()))?
        .to_string();

    let user = validate_oidc_token(state, &id_token).await
        .map_err(|status| (status, "ID token validation failed".to_string()))?;

    let cache_key = format!("oidc:{}", hash_token(&id_token));
    state.auth_cache.insert(cache_key, (user.clone(), Instant::now()));

    Ok(PendingAuthResult {
        access_token: id_token,
        user_id: user.user_id,
        username: user.username,
        provider: user.provider,
    })
}

/// Helper: return an error JSON response from a helper error tuple.
fn auth_error_response(err: (StatusCode, String)) -> axum::response::Response {
    (err.0, Json(serde_json::json!({"error": err.1}))).into_response()
}

/// Exchange a GitHub authorization code for an access token.
/// Also serves as the backward-compatible `/api/auth/exchange` endpoint.
async fn auth_exchange_github(
    State(state): State<AppState>,
    Json(req): Json<AuthExchangeRequest>,
) -> impl IntoResponse {
    let result = match exchange_github_code(&state, &req.code, &req.redirect_uri).await {
        Ok(r) => r,
        Err(e) => return auth_error_response(e),
    };

    // Extract numeric GitHub ID from user_id for legacy field
    let github_id: i64 = result
        .user_id
        .strip_prefix("github:")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Include both generic and legacy fields for backward compat
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "access_token": result.access_token,
            "user_id": result.user_id,
            "username": result.username,
            "provider": result.provider,
            "github_login": result.username,
            "github_id": github_id,
        })),
    )
        .into_response()
}

/// Exchange a GitLab authorization code for an access token.
async fn auth_exchange_gitlab(
    State(state): State<AppState>,
    Json(req): Json<AuthExchangeRequest>,
) -> impl IntoResponse {
    let result = match exchange_gitlab_code(&state, &req.code, &req.redirect_uri).await {
        Ok(r) => r,
        Err(e) => return auth_error_response(e),
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "access_token": result.access_token,
            "user_id": result.user_id,
            "username": result.username,
            "provider": result.provider,
        })),
    )
        .into_response()
}

/// Exchange an OIDC authorization code for an ID token.
async fn auth_exchange_oidc(
    State(state): State<AppState>,
    Json(req): Json<AuthExchangeRequest>,
) -> impl IntoResponse {
    let result = match exchange_oidc_code(&state, &req.code, &req.redirect_uri).await {
        Ok(r) => r,
        Err(e) => return auth_error_response(e),
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "access_token": result.access_token,
            "user_id": result.user_id,
            "username": result.username,
            "provider": result.provider,
        })),
    )
        .into_response()
}

// ── Server-side OAuth Callbacks (for deep-link flow) ────────────────

/// HTML page that redirects to the app's deep link.
fn auth_redirect_html(state_token: &str) -> String {
    // The desktop app finalises sign-in by polling /api/auth/result, so this page's only job is
    // to (best-effort) bring the app to the front and reassure the user. We nudge the custom
    // scheme via a HIDDEN IFRAME rather than navigating the page, so a machine without the
    // tiddlydesktop:// handler registered silently does nothing instead of replacing this page
    // with a browser "can't open" error. A manual button is the explicit fallback.
    r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in &mdash; TiddlyDesktop</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; display: flex;
         align-items: center; justify-content: center; background: #f6f7f9; color: #222; }
  .card { max-width: 460px; padding: 40px 28px; text-align: center; }
  .check { width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 50%; background: #e6f4ea;
           color: #1e8e3e; font-size: 30px; line-height: 56px; }
  h1 { font-size: 1.35rem; margin: 0 0 .5em; }
  p { line-height: 1.55; color: #444; margin: .4em 0; }
  a.btn { display: inline-block; margin-top: 16px; padding: 9px 18px; border-radius: 6px;
          background: #0066cc; color: #fff; text-decoration: none; font-weight: 600; }
  a.btn:hover { background: #0055ad; }
  .muted { color: #888; font-size: .85rem; margin-top: 20px; }
  @media (prefers-color-scheme: dark) {
    body { background: #1b1b1d; color: #eee; }
    .card p { color: #bbb; }
    .check { background: #15351f; color: #5bd17e; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="check">&#10003;</div>
  <h1>You&rsquo;re signed in</h1>
  <p>You can close this tab and return to <strong>TiddlyDesktop</strong> &mdash; it finishes signing you in automatically.</p>
  <p><a class="btn" href="tiddlydesktop://auth?state=__STATE__">Open TiddlyDesktop</a></p>
  <p class="muted">If the window didn&rsquo;t come to the front, switch to it manually.</p>
</div>
<script>
try {
  var f = document.createElement("iframe");
  f.style.display = "none";
  f.src = "tiddlydesktop://auth?state=__STATE__";
  document.body.appendChild(f);
} catch (e) {}
</script>
</body>
</html>"#
        .replace("__STATE__", state_token)
}

/// HTML page for auth callback errors.
fn auth_callback_error_html(error: &str) -> String {
    // HTML-escape the error message (it may contain provider-supplied text).
    let safe = error.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in failed &mdash; TiddlyDesktop</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; display: flex;
         align-items: center; justify-content: center; background: #f6f7f9; color: #222; }
  .card { max-width: 460px; padding: 40px 28px; text-align: center; }
  .cross { width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 50%; background: #fce8e6;
           color: #c5221f; font-size: 30px; line-height: 56px; }
  h1 { font-size: 1.35rem; margin: 0 0 .5em; }
  p { line-height: 1.55; color: #444; margin: .4em 0; }
  .err { color: #c5221f; }
  @media (prefers-color-scheme: dark) {
    body { background: #1b1b1d; color: #eee; }
    .card p { color: #bbb; }
    .cross { background: #3a1715; color: #f08079; }
    .err { color: #f08079; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="cross">&times;</div>
  <h1>Sign-in failed</h1>
  <p class="err">__ERROR__</p>
  <p>Please close this tab and try again from TiddlyDesktop.</p>
</div>
</body>
</html>"#
        .replace("__ERROR__", &safe)
}

/// Server-side OAuth callback for GitHub.
/// GitHub redirects here with ?code=...&state=... after user authorizes.
async fn auth_callback_github(
    State(state): State<AppState>,
    Query(params): Query<AuthCallbackQuery>,
) -> impl IntoResponse {
    // The redirect_uri must match what was sent to GitHub — it's this callback URL itself
    let redirect_uri = "/api/auth/callback/github";
    // Reconstruct full redirect_uri from the request (GitHub needs the full URL)
    // We use the relay server's own HTTPS URL
    let full_redirect_uri = format!(
        "https://relay.tiddlydesktop-rs.com:8443{}",
        redirect_uri
    );

    match exchange_github_code(&state, &params.code, &full_redirect_uri).await {
        Ok(result) => {
            info!("[AuthCallback] GitHub auth success for @{}, state={}", result.username, params.state);
            state.pending_auth_results.insert(
                params.state.clone(),
                (result, Instant::now()),
            );
            Html(auth_redirect_html(&params.state)).into_response()
        }
        Err((_status, msg)) => {
            warn!("[AuthCallback] GitHub auth failed: {}", msg);
            Html(auth_callback_error_html(&msg)).into_response()
        }
    }
}

/// Server-side OAuth callback for GitLab.
async fn auth_callback_gitlab(
    State(state): State<AppState>,
    Query(params): Query<AuthCallbackQuery>,
) -> impl IntoResponse {
    let full_redirect_uri = format!(
        "https://relay.tiddlydesktop-rs.com:8443/api/auth/callback/gitlab"
    );

    match exchange_gitlab_code(&state, &params.code, &full_redirect_uri).await {
        Ok(result) => {
            info!("[AuthCallback] GitLab auth success for @{}, state={}", result.username, params.state);
            state.pending_auth_results.insert(
                params.state.clone(),
                (result, Instant::now()),
            );
            Html(auth_redirect_html(&params.state)).into_response()
        }
        Err((_status, msg)) => {
            warn!("[AuthCallback] GitLab auth failed: {}", msg);
            Html(auth_callback_error_html(&msg)).into_response()
        }
    }
}

/// Server-side OAuth callback for OIDC.
async fn auth_callback_oidc(
    State(state): State<AppState>,
    Query(params): Query<AuthCallbackQuery>,
) -> impl IntoResponse {
    let full_redirect_uri = format!(
        "https://relay.tiddlydesktop-rs.com:8443/api/auth/callback/oidc"
    );

    match exchange_oidc_code(&state, &params.code, &full_redirect_uri).await {
        Ok(result) => {
            info!("[AuthCallback] OIDC auth success for @{}, state={}", result.username, params.state);
            state.pending_auth_results.insert(
                params.state.clone(),
                (result, Instant::now()),
            );
            Html(auth_redirect_html(&params.state)).into_response()
        }
        Err((_status, msg)) => {
            warn!("[AuthCallback] OIDC auth failed: {}", msg);
            Html(auth_callback_error_html(&msg)).into_response()
        }
    }
}

/// Retrieve a pending auth result by state token (single-use).
async fn auth_result(
    State(state): State<AppState>,
    Query(params): Query<AuthResultQuery>,
) -> impl IntoResponse {
    match state.pending_auth_results.remove(&params.state) {
        Some((_key, (result, created_at))) => {
            if created_at.elapsed() > PENDING_AUTH_RESULT_TTL {
                info!("[AuthResult] Expired result for state={}", params.state);
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "Auth result expired"})),
                )
                    .into_response();
            }
            info!("[AuthResult] Returning result for @{}, state={}", result.username, params.state);
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "access_token": result.access_token,
                    "user_id": result.user_id,
                    "username": result.username,
                    "provider": result.provider,
                })),
            )
                .into_response()
        }
        None => {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "No pending auth result for this state token"})),
            )
                .into_response()
        }
    }
}

/// List enabled auth providers with their client IDs.
async fn auth_providers(State(state): State<AppState>) -> impl IntoResponse {
    let mut providers = Vec::new();

    if !state.github_client_id.is_empty() && !state.github_client_secret.is_empty() {
        providers.push(serde_json::json!({
            "name": "github",
            "client_id": state.github_client_id,
        }));
    }

    if !state.gitlab_client_id.is_empty() && !state.gitlab_client_secret.is_empty() {
        providers.push(serde_json::json!({
            "name": "gitlab",
            "client_id": state.gitlab_client_id,
            "url": state.gitlab_url,
        }));
    }

    if !state.oidc_client_id.is_empty()
        && !state.oidc_client_secret.is_empty()
        && !state.oidc_discovery_url.is_empty()
    {
        let mut oidc = serde_json::json!({
            "name": "oidc",
            "client_id": state.oidc_client_id,
            "discovery_url": state.oidc_discovery_url,
        });
        if !state.oidc_provider_name.is_empty() {
            oidc["display_name"] = serde_json::json!(state.oidc_provider_name);
        }
        providers.push(oidc);
    }

    Json(serde_json::json!({
        "providers": providers,
        // Public verification key for relay-issued membership certificates.
        "relay_key": (*state.relay_jwk).clone(),
    }))
}

/// Get current authenticated user info.
async fn auth_user(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    match authenticate(&state, &headers).await {
        Ok(user) => {
            let mut resp = serde_json::json!({
                "user_id": user.user_id,
                "username": user.username,
                "provider": user.provider,
            });
            // Include legacy fields for GitHub users (backward compat)
            if user.provider == "github" {
                let github_id: i64 = user
                    .user_id
                    .strip_prefix("github:")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                resp["github_login"] = serde_json::json!(user.username);
                resp["github_id"] = serde_json::json!(github_id);
            }
            (StatusCode::OK, Json(resp)).into_response()
        }
        Err(status) => (
            status,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response(),
    }
}

// ── REST API: Room Management ───────────────────────────────────────

/// Generate a random 12-character room code
fn generate_room_code() -> String {
    let chars: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng_bytes = [0u8; 12];
    let _ = getrandom(&mut rng_bytes);
    rng_bytes
        .iter()
        .map(|b| chars[(*b as usize) % chars.len()] as char)
        .collect()
}

fn getrandom(buf: &mut [u8]) -> Result<(), ()> {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        f.read_exact(buf).map_err(|_| ())?;
        Ok(())
    } else {
        // Fallback: use timestamp-based entropy (not cryptographically secure, but good enough for room codes)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let seed = now.as_nanos();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((seed >> (i % 16)) ^ (seed >> ((i + 7) % 16))) as u8;
        }
        Ok(())
    }
}

async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateRoomRequest>,
) -> impl IntoResponse {
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({"error": "Unauthorized"})),
            )
                .into_response()
        }
    };

    // Use client-provided room_code if given (for registering existing LAN rooms),
    // otherwise generate one server-side
    let room_code = if let Some(ref code) = req.room_code {
        if code.is_empty()
            || code.len() > 32
            || !code.chars().all(|c| c.is_alphanumeric())
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid room_code format"})),
            )
                .into_response();
        }
        code.clone()
    } else {
        generate_room_code()
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let db = state.db.lock().await;
    match db.execute(
        "INSERT INTO rooms (room_code, name, owner_user_id, owner_username, owner_provider, created_at, encrypted_credentials) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![room_code, req.name, user.user_id, user.username, user.provider, now, req.encrypted_credentials],
    ) {
        Ok(_) => {
            info!("Room {} created by {} ({})", room_code, user.username, user.provider);
            (StatusCode::CREATED, Json(serde_json::json!(CreateRoomResponse {
                room_code,
                name: req.name,
            }))).into_response()
        }
        Err(e) => {
            if e.to_string().contains("UNIQUE constraint") {
                (StatusCode::CONFLICT, Json(serde_json::json!({"error": "Room code already exists"}))).into_response()
            } else {
                warn!("Failed to create room: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to create room"}))).into_response()
            }
        }
    }
}

async fn list_rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({"error": "Unauthorized"})),
            )
                .into_response()
        }
    };

    let db = state.db.lock().await;
    let mut entries = Vec::new();

    // Rooms I own (includes encrypted_credentials for re-join support)
    if let Ok(mut stmt) = db.prepare(
        "SELECT r.room_code, r.name, r.owner_username, r.owner_provider,
                (SELECT COUNT(*) FROM room_members WHERE room_code = r.room_code) as member_count,
                r.encrypted_credentials
         FROM rooms r WHERE r.owner_user_id = ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![user.user_id], |row| {
            Ok(ListRoomEntry {
                room_code: row.get(0)?,
                name: row.get(1)?,
                owner_username: row.get(2)?,
                owner_provider: row.get(3)?,
                role: "owner".to_string(),
                member_count: row.get(4)?,
                encrypted_credentials: row.get(5)?,
            })
        }) {
            for entry in rows.flatten() {
                entries.push(entry);
            }
        }
    }

    // Rooms I'm a member of (not owner)
    if let Ok(mut stmt) = db.prepare(
        "SELECT r.room_code, r.name, r.owner_username, r.owner_provider,
                (SELECT COUNT(*) FROM room_members WHERE room_code = r.room_code) as member_count
         FROM rooms r
         JOIN room_members rm ON r.room_code = rm.room_code
         WHERE rm.user_id = ?1 AND r.owner_user_id != ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![user.user_id], |row| {
            Ok(ListRoomEntry {
                room_code: row.get(0)?,
                name: row.get(1)?,
                owner_username: row.get(2)?,
                owner_provider: row.get(3)?,
                role: "member".to_string(),
                member_count: row.get(4)?,
                encrypted_credentials: None,
            })
        }) {
            for entry in rows.flatten() {
                entries.push(entry);
            }
        }
    }

    (StatusCode::OK, Json(serde_json::json!(entries))).into_response()
}

async fn delete_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> impl IntoResponse {
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({"error": "Unauthorized"})),
            )
                .into_response()
        }
    };

    let db = state.db.lock().await;

    // Check ownership
    let is_owner: bool = db
        .query_row(
            "SELECT COUNT(*) FROM rooms WHERE room_code = ?1 AND owner_user_id = ?2",
            rusqlite::params![code, user.user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !is_owner {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not room owner"})),
        )
            .into_response();
    }

    // Delete room (cascades to members)
    if let Err(e) = db.execute(
        "DELETE FROM rooms WHERE room_code = ?1",
        rusqlite::params![code],
    ) {
        warn!("Failed to delete room {}: {}", code, e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to delete room"})),
        )
            .into_response();
    }

    info!("Room {} deleted by {}", code, user.username);
    (StatusCode::NO_CONTENT, Json(serde_json::json!({}))).into_response()
}

// ── REST API: Member Management ─────────────────────────────────────

async fn list_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> impl IntoResponse {
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({"error": "Unauthorized"})),
            )
                .into_response()
        }
    };

    let db = state.db.lock().await;

    // Check if user is owner or member
    let is_owner: bool = db
        .query_row(
            "SELECT COUNT(*) FROM rooms WHERE room_code = ?1 AND owner_user_id = ?2",
            rusqlite::params![code, user.user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    let is_member: bool = db
        .query_row(
            "SELECT COUNT(*) FROM room_members WHERE room_code = ?1 AND user_id = ?2",
            rusqlite::params![code, user.user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !is_owner && !is_member {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a room member"})),
        )
            .into_response();
    }

    let mut entries = Vec::new();

    // Add owner first
    if let Ok(row) = db.query_row(
        "SELECT owner_user_id, owner_username, owner_provider, created_at FROM rooms WHERE room_code = ?1",
        rusqlite::params![code],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    ) {
        entries.push(RoomMemberEntry {
            user_id: row.0,
            username: row.1,
            provider: row.2,
            role: "owner".to_string(),
            added_at: row.3,
            blocked: None,
        });
    }

    // Add members
    if let Ok(mut stmt) = db.prepare(
        "SELECT user_id, username, provider, added_at FROM room_members WHERE room_code = ?1 ORDER BY added_at",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![code], |row| {
            Ok(RoomMemberEntry {
                user_id: row.get(0)?,
                username: row.get(1)?,
                provider: row.get(2)?,
                role: "member".to_string(),
                added_at: row.get(3)?,
                blocked: None,
            })
        }) {
            for entry in rows.flatten() {
                entries.push(entry);
            }
        }
    }

    // Add blocked members (only visible to room owner)
    if is_owner {
        if let Ok(mut stmt) = db.prepare(
            "SELECT user_id, username, provider, blocked_at FROM blocked_members WHERE room_code = ?1 ORDER BY blocked_at",
        ) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![code], |row| {
                Ok(RoomMemberEntry {
                    user_id: row.get(0)?,
                    username: row.get(1)?,
                    provider: row.get(2)?,
                    role: "blocked".to_string(),
                    added_at: row.get(3)?,
                    blocked: Some(true),
                })
            }) {
                for entry in rows.flatten() {
                    entries.push(entry);
                }
            }
        }
    }

    (StatusCode::OK, Json(serde_json::json!(entries))).into_response()
}

async fn add_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Json(req): Json<AddMemberRequest>,
) -> impl IntoResponse {
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({"error": "Unauthorized"})),
            )
                .into_response()
        }
    };

    let db = state.db.lock().await;

    // Check ownership
    let is_owner: bool = db
        .query_row(
            "SELECT COUNT(*) FROM rooms WHERE room_code = ?1 AND owner_user_id = ?2",
            rusqlite::params![code, user.user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !is_owner {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not room owner"})),
        )
            .into_response();
    }

    // If user_id is provided directly (e.g., unblocking), look up from local DB instead of external API
    if let Some(ref direct_user_id) = req.user_id {
        // Look up username/provider from blocked_members or users table
        let member_info: Option<(String, String, String)> = db
            .query_row(
                "SELECT user_id, username, provider FROM blocked_members WHERE room_code = ?1 AND user_id = ?2",
                rusqlite::params![code, direct_user_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .ok()
            .or_else(|| {
                db.query_row(
                    "SELECT user_id, username, provider FROM users WHERE user_id = ?1",
                    rusqlite::params![direct_user_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
                )
                .ok()
            });

        match member_info {
            Some((member_user_id, member_username, member_provider)) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                match db.execute(
                    "INSERT OR IGNORE INTO room_members (room_code, user_id, username, provider, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![code, member_user_id, member_username, member_provider, now],
                ) {
                    Ok(_) => {
                        db.execute(
                            "DELETE FROM blocked_members WHERE room_code = ?1 AND user_id = ?2",
                            rusqlite::params![code, member_user_id],
                        ).ok();
                        info!(
                            "{} added/unblocked {} ({}) in room {}",
                            user.username, member_username, member_provider, code
                        );
                        return (
                            StatusCode::CREATED,
                            Json(serde_json::json!({
                                "user_id": member_user_id,
                                "username": member_username,
                                "provider": member_provider,
                            })),
                        )
                            .into_response();
                    }
                    Err(e) => {
                        warn!("Failed to add member: {}", e);
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({"error": "Failed to add member"})),
                        )
                            .into_response();
                    }
                }
            }
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": format!("User '{}' not found", direct_user_id)})),
                )
                    .into_response();
            }
        }
    }

    // Look up the user based on provider
    drop(db); // Release lock before HTTP calls

    let (member_user_id, member_username, member_provider) = match req.provider.as_str()
    {
        "github" => {
            // Look up GitHub user by login
            let gh_resp = state
                .http_client
                .get(format!(
                    "https://api.github.com/users/{}",
                    req.username
                ))
                .header(
                    "Authorization",
                    format!(
                        "Bearer {}",
                        extract_bearer(&headers).unwrap_or("")
                    ),
                )
                .send()
                .await;

            match gh_resp {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(body) => {
                            let id = body["id"].as_i64().unwrap_or(0);
                            let login = body["login"]
                                .as_str()
                                .unwrap_or(&req.username)
                                .to_string();
                            if id == 0 {
                                return (
                                    StatusCode::NOT_FOUND,
                                    Json(serde_json::json!({"error": "GitHub user not found"})),
                                )
                                    .into_response();
                            }
                            (format!("github:{}", id), login, "github".to_string())
                        }
                        Err(_) => {
                            return (
                                StatusCode::BAD_GATEWAY,
                                Json(serde_json::json!({"error": "Invalid GitHub response"})),
                            )
                                .into_response()
                        }
                    }
                }
                Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({"error": format!("GitHub user '{}' not found", req.username)})),
                    )
                        .into_response();
                }
                _ => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": "Failed to look up GitHub user"})),
                    )
                        .into_response();
                }
            }
        }
        "gitlab" => {
            if state.gitlab_client_id.is_empty() {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({"error": "GitLab not configured"})),
                )
                    .into_response();
            }

            // Look up GitLab user by username
            let gl_resp = state
                .http_client
                .get(format!(
                    "{}/api/v4/users?username={}",
                    state.gitlab_url, req.username
                ))
                .header(
                    "Authorization",
                    format!(
                        "Bearer {}",
                        extract_bearer(&headers).unwrap_or("")
                    ),
                )
                .send()
                .await;

            match gl_resp {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(body) => {
                            let users = body.as_array();
                            match users.and_then(|arr| arr.first()) {
                                Some(u) => {
                                    let id = u["id"].as_i64().unwrap_or(0);
                                    let username = u["username"]
                                        .as_str()
                                        .unwrap_or(&req.username)
                                        .to_string();
                                    if id == 0 {
                                        return (
                                            StatusCode::NOT_FOUND,
                                            Json(serde_json::json!({"error": "GitLab user not found"})),
                                        )
                                            .into_response();
                                    }
                                    (
                                        format!("gitlab:{}", id),
                                        username,
                                        "gitlab".to_string(),
                                    )
                                }
                                None => {
                                    return (
                                        StatusCode::NOT_FOUND,
                                        Json(serde_json::json!({"error": format!("GitLab user '{}' not found", req.username)})),
                                    )
                                        .into_response();
                                }
                            }
                        }
                        Err(_) => {
                            return (
                                StatusCode::BAD_GATEWAY,
                                Json(serde_json::json!({"error": "Invalid GitLab response"})),
                            )
                                .into_response()
                        }
                    }
                }
                _ => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": "Failed to look up GitLab user"})),
                    )
                        .into_response();
                }
            }
        }
        "oidc" => {
            // OIDC: look up in local users table (user must have logged in at least once)
            let db = state.db.lock().await;
            match db.query_row(
                "SELECT user_id, username, provider FROM users WHERE username = ?1 AND provider = 'oidc'",
                rusqlite::params![req.username],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            ) {
                Ok(row) => (row.0, row.1, row.2),
                Err(_) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({"error": format!("OIDC user '{}' not found (user must have logged in at least once)", req.username)})),
                    )
                        .into_response();
                }
            }
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("Unknown provider: {}", req.provider)})),
            )
                .into_response();
        }
    };

    let db = state.db.lock().await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    match db.execute(
        "INSERT OR IGNORE INTO room_members (room_code, user_id, username, provider, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![code, member_user_id, member_username, member_provider, now],
    ) {
        Ok(_) => {
            // Unblock the member if they were previously blocked
            db.execute(
                "DELETE FROM blocked_members WHERE room_code = ?1 AND user_id = ?2",
                rusqlite::params![code, member_user_id],
            ).ok();
            info!(
                "{} added {} ({}) to room {}",
                user.username, member_username, member_provider, code
            );
            (
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "user_id": member_user_id,
                    "username": member_username,
                    "provider": member_provider,
                })),
            )
                .into_response()
        }
        Err(e) => {
            warn!("Failed to add member: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to add member"})),
            )
                .into_response()
        }
    }
}

async fn remove_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((code, member_user_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({"error": "Unauthorized"})),
            )
                .into_response()
        }
    };

    let db = state.db.lock().await;

    // Check ownership
    let is_owner: bool = db
        .query_row(
            "SELECT COUNT(*) FROM rooms WHERE room_code = ?1 AND owner_user_id = ?2",
            rusqlite::params![code, user.user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !is_owner {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not room owner"})),
        )
            .into_response();
    }

    // Fetch member info before removing (for blocked_members record)
    let member_info: Option<(String, String)> = db
        .query_row(
            "SELECT username, provider FROM room_members WHERE room_code = ?1 AND user_id = ?2",
            rusqlite::params![code, member_user_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    // Remove from SQLite
    let removed = db
        .execute(
            "DELETE FROM room_members WHERE room_code = ?1 AND user_id = ?2",
            rusqlite::params![code, member_user_id],
        )
        .unwrap_or(0);

    if removed == 0 {
        drop(db);
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Member not found"})),
        )
            .into_response();
    }

    // Block the removed member so they can't auto-rejoin
    if let Some((username, provider)) = member_info {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        db.execute(
            "INSERT OR REPLACE INTO blocked_members (room_code, user_id, username, provider, blocked_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![code, member_user_id, username, provider, now],
        ).ok();
        info!("Blocked {} from room {}", member_user_id, code);
    }

    drop(db); // Release lock before kill channel operations

    // Force disconnect the removed member from all active WebSocket connections in this room
    let mut killed = 0;
    let mut to_remove = Vec::new();
    state.kill_channels.iter_mut().for_each(|mut entry| {
        let room_hash = entry.key().clone();
        let channels = entry.value_mut();
        let mut remaining = Vec::new();
        for (uid, sender) in channels.drain(..) {
            if uid == member_user_id {
                let _ = sender.send(());
                killed += 1;
            } else {
                remaining.push((uid, sender));
            }
        }
        if remaining.is_empty() {
            to_remove.push(room_hash);
        } else {
            *channels = remaining;
        }
    });
    for key in to_remove {
        state.kill_channels.remove(&key);
    }
    if killed > 0 {
        info!(
            "Force-disconnected {} connection(s) for {} from room {}",
            killed, member_user_id, code
        );
    }

    info!("{} removed {} from room {}", user.username, member_user_id, code);
    (StatusCode::NO_CONTENT, Json(serde_json::json!({}))).into_response()
}

// ── Admin API ───────────────────────────────────────────────────────

/// Verify admin token from Authorization header
fn authenticate_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), StatusCode> {
    if state.admin_token.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let token = extract_bearer(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    if token != state.admin_token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

#[derive(Deserialize)]
struct BanRequest {
    username: String,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default = "default_github_provider")]
    provider: String,
    #[serde(default)]
    reason: Option<String>,
}

/// Ban a user. If user_id is not provided, look it up via provider API.
async fn admin_ban_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BanRequest>,
) -> impl IntoResponse {
    if let Err(status) = authenticate_admin(&state, &headers) {
        return (
            status,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }

    // Resolve user_id if not provided
    let (ban_user_id, ban_provider) = if let Some(ref uid) = req.user_id {
        (uid.clone(), req.provider.clone())
    } else {
        match req.provider.as_str() {
            "github" => {
                // Look up via GitHub API
                let resp = state
                    .http_client
                    .get(format!(
                        "https://api.github.com/users/{}",
                        req.username
                    ))
                    .send()
                    .await;
                match resp {
                    Ok(r) if r.status().is_success() => {
                        let body: serde_json::Value =
                            r.json().await.unwrap_or_default();
                        match body["id"].as_i64() {
                            Some(id) => {
                                (format!("github:{}", id), "github".to_string())
                            }
                            None => {
                                return (
                                    StatusCode::BAD_GATEWAY,
                                    Json(serde_json::json!({"error": "Could not resolve GitHub user ID"})),
                                )
                                    .into_response()
                            }
                        }
                    }
                    _ => {
                        return (
                            StatusCode::BAD_GATEWAY,
                            Json(serde_json::json!({"error": "GitHub API lookup failed"})),
                        )
                            .into_response()
                    }
                }
            }
            "gitlab" => {
                if state.gitlab_client_id.is_empty() {
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({"error": "GitLab not configured"})),
                    )
                        .into_response();
                }
                let resp = state
                    .http_client
                    .get(format!(
                        "{}/api/v4/users?username={}",
                        state.gitlab_url, req.username
                    ))
                    .send()
                    .await;
                match resp {
                    Ok(r) if r.status().is_success() => {
                        let body: serde_json::Value =
                            r.json().await.unwrap_or_default();
                        match body
                            .as_array()
                            .and_then(|arr| arr.first())
                            .and_then(|u| u["id"].as_i64())
                        {
                            Some(id) => {
                                (format!("gitlab:{}", id), "gitlab".to_string())
                            }
                            None => {
                                return (
                                    StatusCode::NOT_FOUND,
                                    Json(serde_json::json!({"error": "GitLab user not found"})),
                                )
                                    .into_response()
                            }
                        }
                    }
                    _ => {
                        return (
                            StatusCode::BAD_GATEWAY,
                            Json(serde_json::json!({"error": "GitLab API lookup failed"})),
                        )
                            .into_response()
                    }
                }
            }
            "oidc" => {
                // Look up in local users table
                let db = state.db.lock().await;
                match db.query_row(
                    "SELECT user_id FROM users WHERE username = ?1 AND provider = 'oidc'",
                    rusqlite::params![req.username],
                    |row| row.get::<_, String>(0),
                ) {
                    Ok(uid) => (uid, "oidc".to_string()),
                    Err(_) => {
                        return (
                            StatusCode::NOT_FOUND,
                            Json(serde_json::json!({"error": "OIDC user not found in local database"})),
                        )
                            .into_response()
                    }
                }
            }
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": format!("Unknown provider: {}", req.provider)})),
                )
                    .into_response()
            }
        }
    };

    let reason = req.reason.unwrap_or_default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let db = state.db.lock().await;
    match db.execute(
        "INSERT OR REPLACE INTO banned_users (user_id, username, provider, reason, banned_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![ban_user_id, req.username, ban_provider, reason, now],
    ) {
        Ok(_) => {
            drop(db);
            // Invalidate cached tokens for this user
            state
                .auth_cache
                .retain(|_, (u, _)| u.user_id != ban_user_id);

            // Force disconnect all active connections by this user
            let mut killed = 0;
            let mut to_remove = Vec::new();
            state.kill_channels.iter_mut().for_each(|mut entry| {
                let room_hash = entry.key().clone();
                let channels = entry.value_mut();
                let mut remaining = Vec::new();
                for (uid, sender) in channels.drain(..) {
                    if uid == ban_user_id {
                        let _ = sender.send(());
                        killed += 1;
                    } else {
                        remaining.push((uid, sender));
                    }
                }
                if remaining.is_empty() {
                    to_remove.push(room_hash);
                } else {
                    *channels = remaining;
                }
            });
            for key in to_remove {
                state.kill_channels.remove(&key);
            }

            warn!(
                "ADMIN: Banned {} (user_id={}, provider={}, reason={:?}), disconnected {} session(s)",
                req.username, ban_user_id, ban_provider, reason, killed
            );
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "banned": true,
                    "username": req.username,
                    "user_id": ban_user_id,
                    "provider": ban_provider,
                    "disconnected": killed,
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Database error: {}", e)})),
        )
            .into_response(),
    }
}

/// Unban a user by user_id
async fn admin_unban_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(target_user_id): Path<String>,
) -> impl IntoResponse {
    if let Err(status) = authenticate_admin(&state, &headers) {
        return (
            status,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }

    let db = state.db.lock().await;
    let removed = db
        .execute(
            "DELETE FROM banned_users WHERE user_id = ?1",
            rusqlite::params![target_user_id],
        )
        .unwrap_or(0);

    if removed > 0 {
        info!("ADMIN: Unbanned {}", target_user_id);
        (
            StatusCode::OK,
            Json(serde_json::json!({"unbanned": true, "user_id": target_user_id})),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "User not found in ban list"})),
        )
            .into_response()
    }
}

/// List all banned users
async fn admin_list_banned(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(status) = authenticate_admin(&state, &headers) {
        return (
            status,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }

    let db = state.db.lock().await;
    let mut stmt = db
        .prepare(
            "SELECT user_id, username, provider, reason, banned_at FROM banned_users ORDER BY banned_at DESC",
        )
        .unwrap();
    let banned: Vec<serde_json::Value> = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "user_id": row.get::<_, String>(0)?,
                "username": row.get::<_, String>(1)?,
                "provider": row.get::<_, String>(2)?,
                "reason": row.get::<_, String>(3)?,
                "banned_at": row.get::<_, i64>(4)?,
            }))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    (StatusCode::OK, Json(serde_json::json!(banned))).into_response()
}

/// List users who haven't been seen within STALE_USER_THRESHOLD (candidates for cleanup)
async fn admin_list_stale_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(status) = authenticate_admin(&state, &headers) {
        return (
            status,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }

    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        - STALE_USER_THRESHOLD.as_secs() as i64;

    let db = state.db.lock().await;
    let mut stmt = db
        .prepare(
            "SELECT user_id, username, provider, last_seen_at FROM users WHERE last_seen_at < ?1 ORDER BY last_seen_at ASC",
        )
        .unwrap();
    let stale: Vec<serde_json::Value> = stmt
        .query_map(rusqlite::params![cutoff], |row| {
            Ok(serde_json::json!({
                "user_id": row.get::<_, String>(0)?,
                "username": row.get::<_, String>(1)?,
                "provider": row.get::<_, String>(2)?,
                "last_seen_at": row.get::<_, i64>(3)?,
            }))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "threshold_days": STALE_USER_THRESHOLD.as_secs() / 86400,
            "cutoff_unix": cutoff,
            "count": stale.len(),
            "users": stale,
        })),
    )
        .into_response()
}

// ── Health + Stats ──────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

async fn stats_handler(State(state): State<AppState>) -> impl IntoResponse {
    let rooms = state.rooms.len();
    let connections = state.total_connections.load(Ordering::Relaxed);
    let members: usize = state.rooms.iter().map(|r| r.members.len()).sum();
    let token_protected: usize = state
        .rooms
        .iter()
        .filter(|r| r.room_token.is_some())
        .count();
    let db_rooms: i64 = {
        let db = state.db.lock().await;
        db.query_row("SELECT COUNT(*) FROM rooms", [], |row| row.get(0))
            .unwrap_or(0)
    };
    axum::Json(serde_json::json!({
        "rooms": rooms,
        "token_protected_rooms": token_protected,
        "connections": connections,
        "members": members,
        "registered_rooms": db_rooms,
    }))
}

// ── Stale Room Reaper ───────────────────────────────────────────────

/// Remove users who haven't authenticated in STALE_USER_THRESHOLD, along with
/// their owned rooms (cascading to room_members) and any remaining memberships.
async fn cleanup_stale_users(state: &AppState) {
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        - STALE_USER_THRESHOLD.as_secs() as i64;

    let db = state.db.lock().await;

    // Find stale users
    let mut stmt = match db.prepare(
        "SELECT user_id, username, last_seen_at FROM users WHERE last_seen_at < ?1",
    ) {
        Ok(s) => s,
        Err(e) => {
            warn!("cleanup_stale_users: failed to prepare query: {}", e);
            return;
        }
    };

    let stale_users: Vec<(String, String, i64)> = stmt
        .query_map(rusqlite::params![cutoff], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap_or_else(|_| panic!("query_map failed"))
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    if stale_users.is_empty() {
        return;
    }

    info!(
        "Cleaning up {} stale user(s) (not seen since unix {})",
        stale_users.len(),
        cutoff
    );

    for (user_id, username, last_seen) in &stale_users {
        // Delete rooms owned by this user (CASCADE deletes room_members)
        let rooms_deleted = db
            .execute(
                "DELETE FROM rooms WHERE owner_user_id = ?1",
                rusqlite::params![user_id],
            )
            .unwrap_or(0);

        // Remove from any rooms they were a member of (but didn't own)
        let memberships_deleted = db
            .execute(
                "DELETE FROM room_members WHERE user_id = ?1",
                rusqlite::params![user_id],
            )
            .unwrap_or(0);

        // Delete the user record
        db.execute(
            "DELETE FROM users WHERE user_id = ?1",
            rusqlite::params![user_id],
        )
        .ok();

        info!(
            "Cleaned up stale user {} (user_id={}, last_seen={}, rooms_deleted={}, memberships_removed={})",
            username, user_id, last_seen, rooms_deleted, memberships_deleted
        );
    }

    drop(db);

    // Force-disconnect any stale users who are somehow still connected
    for (user_id, _, _) in &stale_users {
        state.kill_channels.iter_mut().for_each(|mut entry| {
            let channels = entry.value_mut();
            let mut remaining = Vec::new();
            for (uid, sender) in channels.drain(..) {
                if uid == *user_id {
                    let _ = sender.send(());
                } else {
                    remaining.push((uid, sender));
                }
            }
            *channels = remaining;
        });
        // Clean up empty entries
        state.kill_channels.retain(|_, v| !v.is_empty());

        // Invalidate cached tokens for this user
        state
            .auth_cache
            .retain(|_, (u, _)| u.user_id != *user_id);
    }
}

fn reap_stale_rooms(state: &AppState) {
    let now = Instant::now();
    let mut reaped = 0;

    state.rooms.retain(|code, room| {
        if room.members.is_empty() {
            if let Some(emptied_at) = room.emptied_at {
                let threshold = if room.room_token.is_some() {
                    SYNC_ROOM_GRACE_PERIOD
                } else {
                    Duration::from_secs(60)
                };
                if now.duration_since(emptied_at) > threshold {
                    reaped += 1;
                    info!(
                        "Reaping stale room {} (empty for {}s)",
                        code,
                        now.duration_since(emptied_at).as_secs()
                    );
                    return false;
                }
            } else {
                if now.duration_since(room.created_at) > Duration::from_secs(600) {
                    reaped += 1;
                    info!("Reaping abandoned room {} (never joined)", code);
                    return false;
                }
            }
        }
        true
    });

    state
        .ip_connections
        .retain(|_, count| count.load(Ordering::Relaxed) > 0);

    // Prune expired auth token cache entries
    state
        .auth_cache
        .retain(|_, (_, cached_at)| cached_at.elapsed() < AUTH_CACHE_TTL * 2);

    // Prune expired pending auth results (server-side OAuth callback flow)
    state
        .pending_auth_results
        .retain(|_, (_, created_at)| created_at.elapsed() < PENDING_AUTH_RESULT_TTL);

    if reaped > 0 {
        info!("Reaped {} stale rooms", reaped);
    }
}

// ── WebSocket Handler ───────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(room_code): Path<String>,
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // ── Auth: require Bearer token ───────────────────────────────────
    let token = match extract_bearer(&headers) {
        Some(t) => t.to_string(),
        None => {
            warn!(
                "Rejected WS from {} — no Bearer token",
                peer_addr.ip()
            );
            return (StatusCode::UNAUTHORIZED, "Authorization required")
                .into_response();
        }
    };

    // Determine auth provider from header (defaults to GitHub)
    let provider = AuthProvider::from_header(&headers);

    // Validate token (cached)
    let auth_user = match validate_token(&state, &token, &provider).await {
        Ok(u) => u,
        Err(_) => {
            warn!(
                "Rejected WS from {} — invalid {} token",
                peer_addr.ip(),
                provider.as_str()
            );
            return (StatusCode::UNAUTHORIZED, "Invalid auth token")
                .into_response();
        }
    };

    // ── Check global ban ───────────────────────────────────────────────
    {
        let db = state.db.lock().await;
        let banned: bool = db
            .query_row(
                "SELECT COUNT(*) FROM banned_users WHERE user_id = ?1",
                rusqlite::params![auth_user.user_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        if banned {
            warn!(
                "Rejected WS from banned user {} ({})",
                auth_user.username, auth_user.user_id
            );
            return (StatusCode::FORBIDDEN, "Banned").into_response();
        }
    }

    // ── Room token validation (optional shared secret per room) ───────
    // If X-Room-Token is present, validate it against the stored hash.
    // First connection to a room sets the token; subsequent ones must match.
    let provided_token = headers
        .get("x-room-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !provided_token.is_empty() {
        let token_hash = hash_token(&provided_token);
        let db = state.db.lock().await;
        let existing: Option<String> = db
            .query_row(
                "SELECT token_hash FROM room_tokens WHERE room_code = ?1",
                rusqlite::params![room_code],
                |row| row.get(0),
            )
            .ok();
        match existing {
            None => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                db.execute(
                    "INSERT INTO room_tokens (room_code, token_hash, created_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![room_code, token_hash, now],
                )
                .ok();
                info!(
                    "Room token set for room {} by {}",
                    room_code, auth_user.username
                );
            }
            Some(stored_hash) => {
                if stored_hash != token_hash {
                    warn!(
                        "Rejected WS from {} — wrong room token for room {}",
                        auth_user.username, room_code
                    );
                    return (StatusCode::FORBIDDEN, "Wrong room token").into_response();
                }
            }
        }
    }

    // ── Validate room code format ────────────────────────────────────
    if room_code.len() < MIN_ROOM_CODE_LEN
        || room_code.len() > MAX_ROOM_CODE_LEN
    {
        return (StatusCode::BAD_REQUEST, "Invalid room code").into_response();
    }
    if !room_code
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return (StatusCode::BAD_REQUEST, "Invalid room code characters")
            .into_response();
    }

    // ── Global connection limit ─────────────────────────────────────
    if state.total_connections.load(Ordering::Relaxed)
        >= MAX_TOTAL_CONNECTIONS as u64
    {
        warn!("Global connection limit reached");
        return (StatusCode::SERVICE_UNAVAILABLE, "Server at capacity")
            .into_response();
    }

    // ── Per-IP connection limit ─────────────────────────────────────
    let ip = peer_addr.ip();
    {
        let ip_count = state
            .ip_connections
            .entry(ip)
            .or_insert_with(|| AtomicU64::new(0));
        if ip_count.load(Ordering::Relaxed) >= MAX_CONNECTIONS_PER_IP as u64 {
            warn!("Per-IP limit reached for {}", ip);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many connections from this IP",
            )
                .into_response();
        }
    }

    // ── Room member limit ───────────────────────────────────────────
    if let Some(room) = state.rooms.get(&room_code) {
        if room.members.len() >= MAX_MEMBERS_PER_ROOM {
            return (StatusCode::CONFLICT, "Room is full").into_response();
        }
    }

    // ── Total room limit ────────────────────────────────────────────
    if !state.rooms.contains_key(&room_code)
        && state.rooms.len() >= MAX_TOTAL_ROOMS
    {
        warn!("Total room limit reached");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Too many active rooms",
        )
            .into_response();
    }

    ws.max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| {
            handle_socket(socket, room_code, peer_addr, state, auth_user)
        })
        .into_response()
}

async fn handle_socket(
    socket: WebSocket,
    room_code: String,
    peer_addr: SocketAddr,
    state: AppState,
    auth_user: AuthUser,
) {
    let ip = peer_addr.ip();

    state.total_connections.fetch_add(1, Ordering::Relaxed);
    state
        .ip_connections
        .entry(ip)
        .or_insert_with(|| AtomicU64::new(0))
        .fetch_add(1, Ordering::Relaxed);

    let result =
        handle_socket_inner(socket, &room_code, &state, &auth_user).await;

    state.total_connections.fetch_sub(1, Ordering::Relaxed);
    if let Some(counter) = state.ip_connections.get(&ip) {
        counter.fetch_sub(1, Ordering::Relaxed);
    }

    if let Err(device_id) = result {
        if !device_id.is_empty() {
            info!(
                "Device {}.. left room {}",
                &device_id[..8.min(device_id.len())],
                room_code
            );
        }
    }
}

async fn handle_socket_inner(
    socket: WebSocket,
    room_code: &str,
    state: &AppState,
    auth_user: &AuthUser,
) -> Result<(), String> {
    let user_id = &auth_user.user_id;
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Step 1: Wait for join message with optional room token
    let (device_id, client_token) = match wait_for_join(&mut ws_rx).await {
        Some(join) => join,
        None => return Ok(()),
    };

    if device_id.len() > 128 || device_id.is_empty() {
        return Ok(());
    }

    info!(
        "Device {}.. joining room {}{}",
        &device_id[..8.min(device_id.len())],
        room_code,
        if client_token.is_some() {
            " (with token)"
        } else {
            " (open)"
        }
    );

    // Step 2: Get or create room, enforcing token auth
    let room = state
        .rooms
        .entry(room_code.to_string())
        .or_insert_with(|| Room {
            tx: broadcast::channel(ROOM_CHANNEL_CAPACITY).0,
            members: DashMap::new(),
            created_at: Instant::now(),
            emptied_at: None,
            room_token: None,
        });

    // ── Room token enforcement (E2E key verification) ────────────────
    match (&room.room_token, &client_token) {
        (Some(room_tok), Some(client_tok)) => {
            if room_tok != client_tok {
                warn!(
                    "Device {}.. rejected from room {} — token mismatch",
                    &device_id[..8.min(device_id.len())],
                    room_code
                );
                drop(room);
                let err_msg = serde_json::to_string(&ServerMessage::Error {
                    message: "Room token mismatch".to_string(),
                })
                .unwrap();
                let _ = ws_tx.send(Message::Text(err_msg.into())).await;
                return Ok(());
            }
        }
        (Some(_), None) => {
            warn!(
                "Device {}.. rejected from room {} — token required",
                &device_id[..8.min(device_id.len())],
                room_code
            );
            drop(room);
            let err_msg = serde_json::to_string(&ServerMessage::Error {
                message: "Room token required".to_string(),
            })
            .unwrap();
            let _ = ws_tx.send(Message::Text(err_msg.into())).await;
            return Ok(());
        }
        (None, Some(_)) => {
            // First joiner sets the token
        }
        (None, None) => {}
    }

    drop(room);

    // ── Auto-add to room_members if token-protected and not blocked ──
    if client_token.is_some() {
        let db = state.db.lock().await;

        // Check if user is blocked from this room
        let is_blocked: bool = db
            .query_row(
                "SELECT COUNT(*) FROM blocked_members WHERE room_code = ?1 AND user_id = ?2",
                rusqlite::params![room_code, user_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if is_blocked {
            warn!(
                "Device {}.. rejected from room {} — user {} is blocked",
                &device_id[..8.min(device_id.len())],
                room_code,
                user_id
            );
            drop(db);
            let err_msg = serde_json::to_string(&ServerMessage::Error {
                message: "You have been blocked from this room".to_string(),
            })
            .unwrap();
            let _ = ws_tx.send(Message::Text(err_msg.into())).await;
            return Ok(());
        }

        // Check if room exists in DB (only auto-add for registered rooms)
        let room_exists: bool = db
            .query_row(
                "SELECT COUNT(*) FROM rooms WHERE room_code = ?1",
                rusqlite::params![room_code],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        // Check if user is the room owner (don't auto-add owners to room_members)
        let is_owner: bool = db
            .query_row(
                "SELECT COUNT(*) FROM rooms WHERE room_code = ?1 AND owner_user_id = ?2",
                rusqlite::params![room_code, user_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if room_exists && !is_owner {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            if db.execute(
                "INSERT OR IGNORE INTO room_members (room_code, user_id, username, provider, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![room_code, user_id, auth_user.username, auth_user.provider, now],
            ).is_ok() {
                info!(
                    "Auto-added {} ({}) to room {}",
                    auth_user.username, auth_user.provider, room_code
                );
            }
        }
        drop(db);
    }

    // Re-acquire the room for member operations
    let room = match state.rooms.get(room_code) {
        Some(r) => r,
        None => return Ok(()),
    };

    if room.members.len() >= MAX_MEMBERS_PER_ROOM {
        drop(room);
        return Ok(());
    }

    let mut rx = room.tx.subscribe();
    let tx = room.tx.clone();

    let existing_members: Vec<String> = room
        .members
        .iter()
        .map(|entry| entry.value().device_id.clone())
        .collect();

    room.members.insert(
        device_id.clone(),
        MemberInfo {
            device_id: device_id.clone(),
        },
    );

    drop(room);

    if let Some(mut room) = state.rooms.get_mut(room_code) {
        room.emptied_at = None;
        if let Some(ref tok) = client_token {
            if room.room_token.is_none() {
                room.room_token = Some(tok.clone());
                info!(
                    "Room {} token set by {}.. ",
                    room_code,
                    &device_id[..8.min(device_id.len())]
                );
            }
        }
    }

    // Register kill channel for forced disconnection
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut entry = state
            .kill_channels
            .entry(room_code.to_string())
            .or_default();
        entry.push((user_id.to_string(), kill_tx));
    }

    // Send this connection's relay-signed membership certificate first, so the
    // client has its proof of authentication before it broadcasts member-info to
    // peers. Carries the relay's public JWK so peers can verify each other.
    let identity_msg = serde_json::to_string(&ServerMessage::Identity {
        cert: mint_membership_cert(state, room_code, auth_user, &device_id),
        jwk: (*state.relay_jwk).clone(),
    })
    .unwrap();
    if ws_tx
        .send(Message::Text(identity_msg.into()))
        .await
        .is_err()
    {
        cleanup(state, room_code, &device_id).await;
        return Err(device_id);
    }

    // Send member list to joiner
    let members_msg = serde_json::to_string(&ServerMessage::Members {
        members: existing_members,
    })
    .unwrap();
    if ws_tx
        .send(Message::Text(members_msg.into()))
        .await
        .is_err()
    {
        cleanup(state, room_code, &device_id).await;
        return Err(device_id);
    }

    // Notify existing members
    let join_notification = serde_json::to_string(&ServerMessage::MemberJoined {
        device_id: device_id.clone(),
    })
    .unwrap();
    let _ = tx.send(RoomMessage {
        from_device_id: String::new(),
        data: join_notification.into_bytes(),
        is_text: true,
    });

    let device_id_clone = device_id.clone();

    // Shared channel for outbound WebSocket messages
    let (out_tx, mut out_rx) =
        tokio::sync::mpsc::unbounded_channel::<Message>();
    let out_tx_for_broadcast = out_tx.clone();
    let out_tx_for_ping = out_tx.clone();

    // Task 1: Forward broadcast channel → outbound queue
    let mut broadcast_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if msg.from_device_id == device_id_clone {
                        continue;
                    }
                    let ws_msg = if msg.is_text {
                        Message::Text(
                            String::from_utf8_lossy(&msg.data)
                                .into_owned()
                                .into(),
                        )
                    } else {
                        Message::Binary(msg.data.into())
                    };
                    if out_tx_for_broadcast.send(ws_msg).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // The buffer overran this subscriber: `n` frames are gone for it and cannot be
                    // recovered server-side. The client reconciles via its periodic manifest, but
                    // this is a (now rare) reliability hole — surface it loudly for monitoring.
                    warn!("Subscriber lagged by {} messages — frames dropped for this connection", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Task 2: Drain outbound queue → WebSocket write half
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Task 3: WebSocket read half → broadcast channel
    let tx_for_recv = tx.clone();
    let device_id_for_recv = device_id.clone();
    let last_activity = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let epoch = Instant::now();
    let last_activity_for_recv = last_activity.clone();

    let mut recv_task = tokio::spawn(async move {
        let mut rate_budget: u64 = RATE_LIMIT_BUCKET_BYTES;
        let mut last_refill = Instant::now();

        loop {
            match ws_rx.next().await {
                Some(Ok(msg)) => {
                    last_activity_for_recv.store(
                        epoch.elapsed().as_secs(),
                        Ordering::Relaxed,
                    );

                    let elapsed = last_refill.elapsed();
                    last_refill = Instant::now();
                    rate_budget = rate_budget
                        .saturating_add(
                            (elapsed.as_secs_f64()
                                * RATE_LIMIT_REFILL_PER_SEC as f64)
                                as u64,
                        )
                        .min(RATE_LIMIT_BUCKET_BYTES);

                    match msg {
                        Message::Binary(data) => {
                            if data.len() > MAX_MESSAGE_SIZE {
                                warn!(
                                    "Oversized message from {}.. ({} bytes)",
                                    &device_id_for_recv
                                        [..8.min(device_id_for_recv.len())],
                                    data.len()
                                );
                                break;
                            }
                            let msg_len = data.len() as u64;
                            // Over budget → THROTTLE, never disconnect. A hard break here used to
                            // tear down the whole socket on any legitimate burst (a manifest storm,
                            // or a chunked asset transfer exceeding the sustained rate), losing
                            // in-flight frames and triggering a reconnect loop. Instead we wait for
                            // the bucket to refill just enough and then deliver the frame: a sender
                            // is still bounded to RATE_LIMIT_REFILL_PER_SEC sustained, but no data is
                            // ever dropped. (The single-frame cap is MAX_MESSAGE_SIZE < bucket, so the
                            // wait is always finite — at most a few seconds.)
                            if msg_len > rate_budget {
                                let deficit = msg_len - rate_budget;
                                let wait = Duration::from_secs_f64(
                                    deficit as f64 / RATE_LIMIT_REFILL_PER_SEC as f64,
                                );
                                tokio::time::sleep(wait).await;
                                rate_budget = msg_len;
                                last_refill = Instant::now();
                            }
                            rate_budget -= msg_len;
                            let _ = tx_for_recv.send(RoomMessage {
                                from_device_id: device_id_for_recv.clone(),
                                data: data.to_vec(),
                                is_text: false,
                            });
                        }
                        Message::Text(text) => {
                            if text.len() > MAX_MESSAGE_SIZE {
                                break;
                            }
                            let msg_len = text.len() as u64;
                            // Throttle instead of disconnecting (see the Binary arm above).
                            if msg_len > rate_budget {
                                let deficit = msg_len - rate_budget;
                                let wait = Duration::from_secs_f64(
                                    deficit as f64 / RATE_LIMIT_REFILL_PER_SEC as f64,
                                );
                                tokio::time::sleep(wait).await;
                                rate_budget = msg_len;
                                last_refill = Instant::now();
                            }
                            rate_budget -= msg_len;
                            let _ = tx_for_recv.send(RoomMessage {
                                from_device_id: device_id_for_recv.clone(),
                                data: text.into_bytes(),
                                is_text: true,
                            });
                        }
                        Message::Close(_) => break,
                        Message::Ping(_) | Message::Pong(_) => {}
                    }
                }
                Some(Err(_)) => break,
                None => break,
            }
        }
    });

    // Task 4: Periodic ping + idle timeout
    let device_id_for_ping = device_id.clone();
    let ping_epoch = epoch;
    let mut ping_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(PING_INTERVAL);
        loop {
            interval.tick().await;
            let now_secs = ping_epoch.elapsed().as_secs();
            let last = last_activity.load(Ordering::Relaxed);
            if now_secs.saturating_sub(last) >= IDLE_TIMEOUT.as_secs() {
                info!(
                    "Idle timeout for device {}.. (no activity for {}s)",
                    &device_id_for_ping
                        [..8.min(device_id_for_ping.len())],
                    now_secs.saturating_sub(last)
                );
                break;
            }
            if out_tx_for_ping
                .send(Message::Ping(vec![].into()))
                .is_err()
            {
                break;
            }
        }
    });

    // Task 5: Kill channel — forced disconnection when removed from room
    let out_tx_for_kill = out_tx.clone();
    let mut kill_task = tokio::spawn(async move {
        if kill_rx.await.is_ok() {
            // Send removal notification before disconnect
            let removed_msg =
                serde_json::to_string(&ServerMessage::Removed {
                    message: "You have been removed from this room"
                        .to_string(),
                })
                .unwrap();
            let _ = out_tx_for_kill
                .send(Message::Text(removed_msg.into()));
            // Small delay to allow the message to be sent
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    tokio::select! {
        _ = &mut broadcast_task => { send_task.abort(); recv_task.abort(); ping_task.abort(); kill_task.abort(); },
        _ = &mut send_task => { broadcast_task.abort(); recv_task.abort(); ping_task.abort(); kill_task.abort(); },
        _ = &mut recv_task => { broadcast_task.abort(); send_task.abort(); ping_task.abort(); kill_task.abort(); },
        _ = &mut ping_task => { broadcast_task.abort(); send_task.abort(); recv_task.abort(); kill_task.abort(); },
        _ = &mut kill_task => { broadcast_task.abort(); send_task.abort(); recv_task.abort(); ping_task.abort(); },
    }

    cleanup(state, room_code, &device_id).await;
    info!(
        "Device {}.. left room {}",
        &device_id[..8.min(device_id.len())],
        room_code
    );
    Err(device_id)
}

/// Returns (device_id, optional_room_token)
async fn wait_for_join(
    ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Option<(String, Option<String>)> {
    let timeout =
        tokio::time::timeout(Duration::from_secs(10), ws_rx.next()).await;
    match timeout {
        Ok(Some(Ok(Message::Text(text)))) => {
            if text.len() > 1024 {
                return None;
            }
            let join: JoinMessage = serde_json::from_str(&text).ok()?;
            if join.msg_type != "join" || join.device_id.is_empty() {
                return None;
            }
            if let Some(ref tok) = join.room_token {
                if tok.len() > 128 || tok.is_empty() {
                    return None;
                }
            }
            Some((join.device_id, join.room_token))
        }
        _ => None,
    }
}

async fn cleanup(state: &AppState, room_code: &str, device_id: &str) {
    // Clean up kill channel entries for this connection
    if let Some(mut entry) = state.kill_channels.get_mut(room_code) {
        entry.retain(|(_, sender)| !sender.is_closed());
    }

    if let Some(room) = state.rooms.get(room_code) {
        room.members.remove(device_id);

        let leave_msg = serde_json::to_string(&ServerMessage::MemberLeft {
            device_id: device_id.to_string(),
        })
        .unwrap();
        let _ = room.tx.send(RoomMessage {
            from_device_id: String::new(),
            data: leave_msg.into_bytes(),
            is_text: true,
        });

        let is_empty = room.members.is_empty();
        let is_token_protected = room.room_token.is_some();
        drop(room);

        if is_empty {
            if is_token_protected {
                if let Some(mut room) = state.rooms.get_mut(room_code) {
                    room.emptied_at = Some(Instant::now());
                }
                info!(
                    "Room {} is empty, grace period started ({}s)",
                    room_code,
                    SYNC_ROOM_GRACE_PERIOD.as_secs()
                );
            } else {
                state.rooms.remove(room_code);
                info!("Room {} removed (empty)", room_code);
            }
        }
    }
}

-- ============================================================
-- CORRECTED NSE MCP RESEARCH DATABASE SCHEMA (SQLite v3)
-- DESIGN ONLY: No files created in project, no persistent execution
-- ============================================================

-- ============================================================
-- 1. Pre-Market Snapshots (8:00–9:15 IST)
--    Data captured before market open
-- ============================================================
CREATE TABLE IF NOT EXISTS research_pre_market_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date    TEXT    NOT NULL,        -- YYYY-MM-DD, NSE trading date (NOT NULL for dedup)
    symbol          TEXT    NOT NULL,        -- e.g., "NIFTY", "BANKNIFTY"
    expiry          TEXT,                     -- YYYY-MM-DD or NULL for index options
    source          TEXT    NOT NULL,        -- 'NSE_MCP' | 'MOAPI' | 'BREEZE'
    spot_price      REAL,                     -- underlying spot price (may be NULL)
    change_pct      REAL,                     -- % change from previous close (may be NULL)
    volume          INTEGER,                  -- total volume (may be NULL)
    oi              INTEGER,                  -- open interest (may be NULL, index options)
    iv              REAL,                     -- implied volatility (calculated internal — NOT stored as mandatory field)
    timestamp_ist   TEXT    NOT NULL,        -- ISO 8601 in IST when data was captured
    collection_ts   TEXT    NOT NULL,        -- ISO 8601 UTC when snapshot was collected into DB
    freshness       TEXT    NOT NULL DEFAULT 'UNKNOWN',  -- FRESH/DELAYED/STALE/CLOSED/INVALID/FUTURE
    gate_verified   INTEGER NOT NULL DEFAULT 0,  -- 1 if both gates passed at collection time
    -- Dedup: partial unique index because expiry CAN be NULL
    UNIQUE(trading_date, symbol, source, timestamp_ist)
);

-- Partial unique index: enforce (trading_date, symbol, expiry, source, timestamp_ist)
-- only when expiry IS NOT NULL. Prevents the "multiple NULLs in UNIQUE" SQLite issue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_expiry ON research_pre_market_snapshots(trading_date, symbol, expiry, source, timestamp_ist) WHERE expiry IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pm_trading ON research_pre_market_snapshots(trading_date, symbol);
CREATE INDEX IF NOT EXISTS idx_pm_source_fresh ON research_pre_market_snapshots(source, freshness);
CREATE INDEX IF NOT EXISTS idx_pm_gate ON research_pre_market_snapshots(gate_verified);

/* ============================================================
   2. Intraday Reference Snapshots (mid-day: 11:30, 13:30 IST)
   ============================================================ */
CREATE TABLE IF NOT EXISTS research_intraday_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date    TEXT    NOT NULL,
    symbol          TEXT    NOT NULL,
    expiry          TEXT,                     -- NULL for spot/equity
    source          TEXT    NOT NULL,
    spot_price      REAL,                     -- may be NULL
    vwap            REAL,                       -- volume-weighted average price
    change_pct      REAL,                       -- may be NULL
    volume          INTEGER,                    -- may be NULL
    oi              INTEGER,                    -- may be NULL
    timestamp_ist   TEXT    NOT NULL,         -- e.g. "2026-11-15T11:30:00+05:30"
    collection_ts   TEXT    NOT NULL,         -- ISO 8601 UTC when recorded
    freshness       TEXT    NOT NULL DEFAULT 'UNKNOWN',
    gate_verified   INTEGER NOT NULL DEFAULT 0,
    -- Dedup: full key with partial index for expiry NULL safety
    UNIQUE(trading_date, symbol, source, timestamp_ist)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_id_expiry ON research_intraday_snapshots(trading_date, symbol, expiry, source, timestamp_ist) WHERE expiry IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_id_trading ON research_intraday_snapshots(trading_date, symbol, source);

/* ============================================================
   3a. Underlying EOD OHLCV (NIFTY, BANKNIFTY, SENSEX, equity spot)
   ============================================================ */
CREATE TABLE IF NOT EXISTS research_eod_ohlcv_underlying (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date    TEXT    NOT NULL,        -- YYYY-MM-DD NSE trading date
    symbol          TEXT    NOT NULL,        -- "NIFTY", "BANKNIFTY", "RELIANCE", etc.
    expiry          TEXT,                     -- NULL for equity/spot (never mixed with options)
    source          TEXT    NOT NULL,        -- 'NSE_MCP' | 'MOAPI' | 'BREEZE'
    open            REAL    NOT NULL,
    high              REAL    NOT NULL,
    low               REAL    NOT NULL,
    close           REAL    NOT NULL,
    volume          INTEGER NOT NULL,
    oi              INTEGER,                  -- total OI (index/equity), may be NULL
    vwap            REAL,                       -- calculated: sum(price*volume)/sum(volume)
    timestamp_ist   TEXT    NOT NULL,        -- "2026-11-15T15:30:00+05:30" (close of regular session, IST)
    collection_ts   TEXT    NOT NULL,        -- ISO 8601 UTC when recorded
    freshness       TEXT    NOT NULL DEFAULT 'UNKNOWN',
    gate_verified   INTEGER NOT NULL DEFAULT 0,
    -- Dedup: expiry may be NULL for spot, so use partial unique index
    UNIQUE(trading_date, symbol, source, timestamp_ist)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eod_underlying ON research_eod_ohlcv_underlying(trading_date, symbol, expiry, source, timestamp_ist) WHERE expiry IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eod_underlying ON research_eod_ohlcv_underlying(trading_date, symbol, expiry);

/* ============================================================
   3b. Option-contract EOD OHLCV (CE/PE per strike)
   ============================================================ */
-- CRITICAL: 'source' column ADDED — was missing in prior version
CREATE TABLE IF NOT EXISTS research_eod_ohlcv_options (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date    TEXT    NOT NULL,
    symbol          TEXT    NOT NULL,        -- e.g., "NIFTY", "RELIANCE"
    expiry          TEXT    NOT NULL,        -- YYYY-MM-DD, mandatory for options
    strike          REAL    NOT NULL,        -- strike price, mandatory for options (NOT NULL enables simple UNIQUE)
    option_type     TEXT    NOT NULL,        -- 'CE' or 'PE', mandatory for options
    open            REAL    NOT NULL,
    high              REAL    NOT NULL,
    low               REAL    NOT NULL,
    close           REAL    NOT NULL,
    volume          INTEGER NOT NULL,
    oi              INTEGER NOT NULL,        -- contract-specific open interest
    vwap            REAL,                       -- calculated
    timestamp_ist   TEXT    NOT NULL,        -- IST when market close
    collection_ts   TEXT    NOT NULL,        -- ISO 8601 UTC when recorded
    freshness       TEXT    NOT NULL DEFAULT 'UNKNOWN',
    gate_verified   INTEGER NOT NULL DEFAULT 0,
    -- Dedup: all 7 components NOT NULL enables simple UNIQUE (no partial index needed)
    -- 'source' column now included in the unique key
    UNIQUE(trading_date, symbol, expiry, strike, option_type, source, timestamp_ist)
);

CREATE INDEX IF NOT EXISTS idx_eod_options ON research_eod_ohlcv_options(trading_date, symbol, expiry, strike, option_type);

/* ============================================================
   4. EOD F&O Bhavcopy (strike-level granularity per trading day)
   ============================================================ */
-- Bhavcopy stores full option chain data released by NSE end of day.
-- Each row represents one strike+CE/PE combination.
CREATE TABLE IF NOT EXISTS research_eod_bhavcopy (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date    TEXT    NOT NULL,        -- YYYY-MM-DD
    symbol          TEXT    NOT NULL,        -- "RELIANCE", "INFY", "NIFTY"
    expiry          TEXT    NOT NULL,        -- YYYY-MM-DD (last Tuesday for monthly; mandatory for options)
    strike          REAL    NOT NULL,        -- strike price, mandatory for options (NO NULL strikes in bhavcopy)
    option_type     TEXT    NOT NULL,        -- 'CE' or 'PE', mandatory for options
    spot_price      REAL    NOT NULL,        -- underlying spot at EOD
    open_interest   INTEGER NOT NULL,        -- total OI for this symbol+expiry+strike+option_type
    total_traded_qty INTEGER,                  -- may be NULL for index options
    marked_price    REAL,                     -- may be NULL
    close_price     REAL,                     -- may be NULL (different from spot_price if corporate action)
    change_pct      REAL,                     -- may be NULL
    -- PCR (put-call ratio) REMOVED from mandatory fields — unverified by NSE MCP tools
    -- underlying_spot kept for clarity; may duplicate spot_price
    timestamp_ist   TEXT    NOT NULL,        -- "2026-11-15T15:40:00+05:30" (typical bhavcopy release time, IST)
    collection_ts   TEXT    NOT NULL,        -- ISO 8601 UTC when recorded
    source          TEXT    NOT NULL DEFAULT 'NSE_MCP',
    freshness       TEXT    NOT NULL DEFAULT 'UNKNOWN',
    gate_verified   INTEGER NOT NULL DEFAULT 0,
    -- Dedup: one row per full contract identity + trading day
    -- All key columns NOT NULL enables simple UNIQUE without partial index
    UNIQUE(trading_date, symbol, expiry, strike, option_type)
);

CREATE INDEX IF NOT EXISTS idx_bhav_trading ON research_eod_bhavcopy(trading_date, symbol, expiry, strike, option_type);
CREATE INDEX IF NOT EXISTS idx_bhav_source ON research_eod_bhavcopy(source, trading_date);

/* ============================================================
   5. Historical OpenI (strike-level time series)
   ============================================================ */
-- Historical OI tracks strike-level OI over time.
-- 'call_oi' and 'put_oi' REMOVED from mandatory — unverified as independently collected fields.
-- 'change_in_oi' calculated only when two valid records exist for same contract identity.
CREATE TABLE IF NOT EXISTS research_historical_oi (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT    NOT NULL,        -- underlying: "NIFTY", "BANKNIFTY", "RELIANCE"
    expiry          TEXT,                     -- YYYY-MM-DD; NULL only for index-wide aggregates (rare design edge)
    strike          REAL,                     -- NULL only in extreme edge case of index-wide OI not per-strike;
                                -- otherwise mandatory for per-strike tracking
    option_type     TEXT,                     -- 'CE'/'PE'; NULL for index-level OI (rare; design assumes per-strike)
    trading_date    TEXT    NOT NULL,        -- YYYY-MM-DD: the contract's trading date
    record_date     TEXT    NOT NULL,        -- YYYY-MM-DD: when this OI snapshot was recorded (collection date)
    -- 'call_oi' and 'put_oi' REMOVED — unsupported unless independently verified source available
    -- 'total_oi' REMOVED — derived from call_oi+put_oi when those are present
    change_in_oi    INTEGER,                  -- change from previous record_date for same contract identity;
                                -- NULL if first/only record for this contract — NEVER invent
    source          TEXT    NOT NULL DEFAULT 'NSE_MCP',
    timestamp_ist   TEXT    NOT NULL,        -- when this OI was fetched (ISO 8601 IST)
    collection_ts   TEXT    NOT NULL,        -- when recorded into DB (ISO 8601 UTC)
    freshness       TEXT    NOT NULL DEFAULT 'UNKNOWN',
    gate_verified   INTEGER NOT NULL DEFAULT 0,
    -- Dedup: one row per full contract identity + trading_date + record_date
    -- Partial unique index for expiry/option_type NULL safety
    UNIQUE(symbol, expiry, strike, option_type, trading_date, record_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hoi_expiry ON research_historical_oi(symbol, expiry, strike, option_type, trading_date, record_date) WHERE expiry IS NOT NULL AND option_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hoi_symbol ON research_historical_oi(symbol, expiry, strike, option_type);
CREATE INDEX IF NOT EXISTS idx_hoi_trading ON research_historical_oi(trading_date, record_date);
-- freshness index removed — field now calculated/internal only

/* ============================================================
   6. Provider comparisons
   ============================================================ */
CREATE TABLE IF NOT EXISTS research_provider_comparison (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date    TEXT    NOT NULL,
    symbol          TEXT    NOT NULL,
    expiry          TEXT,                     -- NULL for spot/equity comparisons
    data_type       TEXT    NOT NULL,        -- 'SPOT_PRICE' | 'VOLUME' | 'VWAP' | 'OI_CHANGE'
    moapi_value     REAL,                     -- value from MOAPI (NULL if unavailable / unsupported for type)
    breeze_value    REAL,                     -- value from ICICI Breeze (NULL if unsupported)
    nse_mcp_value   REAL,                     -- value from NSE MCP
    moapi_timestamp TEXT,                     -- ISO 8601 UTC when MOAPI was queried (NULL if unsupported)
    breeze_timestamp TEXT,                    -- ISO 8601 UTC when Breeze was queried (NULL if unsupported)
    nse_mcp_timestamp TEXT,                    -- ISO 8601 UTC when MCP was fetched
    price_mcp_mo    REAL,                     -- % diff: (MOAPI - MCP) / MCP * 100; NULL if MCP=0 or unavailable
    price_mcp_bz    REAL,                     -- % diff: (Breeze - MCP) / MCP * 100; NULL if Breeze/MCP unavailable
    price_mo_bz     REAL,                     -- % diff: (Breeze - MOAPI) / MOAPI * 100; NULL if MOAPI unavailable
    source_rank     TEXT,                     -- 'BEST' | 'MOAPI' | 'BREEZE' | 'NSE_MCP' | 'MIXED'
    discrepancy_flag TEXT,                     -- 'NONE' | 'SMALL' | 'LARGE' | 'MISSING';
                                -- 'SMALL' if ≤2pts or ≤1%; 'LARGE' if ≥1.5pts or ≥2%
    gate_verified   INTEGER NOT NULL DEFAULT 0,
    -- Dedup: one row per date+symbol+type+source_rank
    UNIQUE(trading_date, symbol, expiry, data_type, source_rank)
);

CREATE INDEX IF NOT EXISTS idx_pc_trading ON research_provider_comparison(trading_date, symbol, data_type);
CREATE INDEX IF NOT EXISTS idx_pc_source ON research_provider_comparison(source_rank, discrepancy_flag);
CREATE INDEX IF NOT EXISTS idx_pc_mcp ON research_provider_comparison(nse_mcp_value, moapi_value);

/* ============================================================
   7. Collection health & data-quality history
   ============================================================ */
CREATE TABLE IF NOT EXISTS research_collection_health (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_run_id TEXT   NOT NULL,        -- unique per run: e.g. "2026-11-15T09:00:00-UTC"
    started_at      TEXT   NOT NULL,        -- ISO 8601 UTC timestamp, e.g. "2026-11-15T03:00:00Z"
    completed_at    TEXT,                     -- ISO 8601 UTC (NULL if still running)
    status          TEXT   NOT NULL DEFAULT 'PENDING',  -- PENDING | SUCCESS | FAILED | PARTIAL
    source_failed   TEXT,                     -- 'NSE_MCP' | 'MOAPI' | 'BREEZE' | 'ALL'; NULL if status=SUCCESS
    error_type      TEXT,                     -- 'HTTP_ERROR' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'GATE_BLOCKED'; NULL if SUCCESS
    error_message   TEXT,                     -- human-readable; NULL if status=SUCCESS
    records_fetched INTEGER NOT NULL DEFAULT 0,
    records_stored  INTEGER NOT NULL DEFAULT 0,   -- successfully inserted (after dedup)
    records_skipped INTEGER NOT NULL DEFAULT 0,   -- dedup: already existed
    records_invalid INTEGER NOT NULL DEFAULT 0,   -- freshness=INVALID; rejected by gate/validation
    avg_latency_ms  REAL    NOT NULL DEFAULT 0,
    max_latency_ms  REAL    NOT NULL DEFAULT 0,
    gate_research   INTEGER NOT NULL DEFAULT 0,   -- 1 if mcpResearchGate was enabled at start
    gate_auth       INTEGER NOT NULL DEFAULT 0,   -- 1 if nseAuthorizationGate was authorized at start
    gate_result     TEXT,                     -- 'BOTH' | 'RESEARCH_ONLY' | 'AUTH_ONLY' | 'NONE'
    provenance      TEXT,                     -- JSON: collector version, script hash, environment
    notes           TEXT,                     -- free-form; e.g. "first run after gateway approval"
    UNIQUE(collection_run_id)
);

CREATE INDEX IF NOT EXISTS idx_health_started ON research_collection_health(started_at);
CREATE INDEX IF NOT EXISTS idx_health_status ON research_collection_health(status, started_at);
CREATE INDEX IF NOT EXISTS idx_health_gate ON research_collection_health(gate_research, gate_auth);

/* ============================================================
   8. Authorization audit history (dual-gate state transitions)
   ============================================================ */
CREATE TABLE IF NOT EXISTS research_authorization_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_timestamp TEXT   NOT NULL,        -- ISO 8601 IST, e.g. "2026-11-15T09:15:00+05:30"
    event_type      TEXT   NOT NULL,        -- 'GATE_ENABLE_RESEARCH' | 'GATE_ENABLE_AUTH' | 'GATE_DISABLE' | 'GATE_REVOKED' | 'APPROVAL_GRANTED' | 'APPROVAL_REVOKED'
    gate            TEXT   NOT NULL,        -- 'RESEARCH' | 'AUTHORIZATION'
    previous_state  INTEGER NOT NULL,       -- 0=disabled, 1=enabled
    new_state       INTEGER NOT NULL,       -- 0=disabled, 1=enabled
    effective_ts    TEXT,                     -- ISO 8601 UTC when new_state takes effect
    expiry_ts       TEXT,                     -- ISO 8601 UTC when gate auto-revokes (NULL = permanent/manual)
    scope           TEXT,                     -- 'daily' | 'weekly' | 'one-time' | 'permanent'
    approval_id     TEXT,                     -- external reference: env var, workflow token, admin ID
    approval_evidence TEXT,                    -- e.g. "env:BREEZE_API_KEY_set", "workflow:20261115-approval-001"
    revocation_reason TEXT,                    -- NULL if still active; else: "manual_admin", "expired", "policy_violation"
    session_context TEXT,                     -- e.g. "trading_day:2026-11-15", "pre_market_scan"
    notes           TEXT,                     -- free-form
    UNIQUE(audit_timestamp, event_type, gate)
);

CREATE INDEX IF NOT EXISTS idx_auth_timestamp ON research_authorization_audit(audit_timestamp);
CREATE INDEX IF NOT EXISTS idx_auth_gate ON research_authorization_audit(gate, event_type);

/* ============================================================
   9. Research gate state (exactly one row, id=1)
   ============================================================ */
-- Enforce exactly one row via PRIMARY KEY (id) and CHECK(id = 1).
-- INSERT OR IGNORE ensures idempotency: if row exists, IGNORE keeps existing; if not, inserts id=1.
CREATE TABLE IF NOT EXISTS research_gate_state (
    id              INTEGER NOT NULL,
    updated_at      TEXT    NOT NULL,         -- ISO 8601 IST when last checked/updated
    mcp_research_gate INTEGER NOT NULL DEFAULT 0,  -- 1=explicitly enabled, 0=disabled (DEFAULT: disabled)
    nse_authorization_gate INTEGER NOT NULL DEFAULT 0,  -- 1=explicitly authorized, 0=NOT authorized (DEFAULT: not authorized)
    last_checked_at TEXT    NOT NULL,         -- ISO 8601 IST when last checked/updated
    approval_source TEXT,                     -- 'manual' | 'env' | 'workflow' | 'none'
    approval_note   TEXT,                       -- free-form: "2026-11-15 admin approval", etc.
    -- Constraint: id must be 1 (enforced by PRIMARY KEY + CHECK)
    PRIMARY KEY (id),
    CONSTRAINT chk_gate_state_id CHECK (id = 1),
    -- Runtime CHECK: both gates are boolean (0 or 1)
    CONSTRAINT chk_gate_values CHECK (mcp_research_gate IN (0,1) AND nse_authorization_gate IN (0,1))
);

-- Initialize with both gates closed (safe default — no auto-enablement).
-- INSERT OR IGNORE ensures idempotency: if row exists, IGNORE keeps existing; if not, inserts id=1.
INSERT OR IGNORE INTO research_gate_state (id, updated_at, mcp_research_gate, nse_authorization_gate, last_checked_at, approval_source, approval_note)
VALUES (1, datetime('now'), 0, 0, datetime('now'), 'initialization', 'Both gates default DISABLED — research collection blocked by fail-closed gates. Explicit approval required to enable.');

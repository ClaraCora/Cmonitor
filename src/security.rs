//! Authentication policy is read and changed under the database lock. OAuth
//! network requests carry a configuration stamp and recheck it before login.

use anyhow::{ensure, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::auth::{random_token, sha256};
use crate::db::Db;

pub struct AuthConfig {
    pub password_enabled: bool,
    pub password_hash: Option<String>,
    pub github_id: String,
    pub github_secret: String,
    pub github_users: Vec<String>,
    pub stamp: String,
    pub verified: bool,
}

impl AuthConfig {
    pub fn github_ready(&self) -> bool {
        !self.github_id.is_empty() && !self.github_secret.is_empty() && !self.github_users.is_empty()
    }
}

fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM setting WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT INTO setting(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
    Ok(())
}

fn config(conn: &Connection, site: &str) -> Result<AuthConfig> {
    let github_id = get(conn, "github_client_id")?.unwrap_or_default().trim().to_owned();
    let github_secret = get(conn, "github_client_secret")?.unwrap_or_default().trim().to_owned();
    let mut github_users: Vec<String> = get(conn, "github_allowed_users")?.unwrap_or_default()
        .split(',').map(|v| v.trim().to_ascii_lowercase()).filter(|v| !v.is_empty()).collect();
    github_users.sort();
    github_users.dedup();
    let revision = get(conn, "github_revision")?.unwrap_or_default();
    let stamp = sha256(&serde_json::to_string(&(&github_id, &github_secret, &github_users, revision, site))?);
    let verified = get(conn, "github_verified")?.as_deref() == Some(stamp.as_str());
    Ok(AuthConfig {
        password_enabled: get(conn, "password_login")?.as_deref() != Some("off"),
        password_hash: get(conn, "admin_password_hash")?,
        github_id, github_secret, github_users, stamp, verified,
    })
}

fn insert_session(conn: &Connection, hash: &str, expires: i64, kind: &str, identity: &str) -> Result<()> {
    conn.execute("INSERT INTO session(token_hash,expires_at,kind,identity) VALUES(?1,?2,?3,?4)", params![hash,expires,kind,identity])?;
    Ok(())
}

impl Db {
    pub fn auth_config(&self, site: &str) -> Result<AuthConfig> {
        config(&self.conn(), site)
    }

    pub fn password_session(&self, hash: &str, expires: i64, checked_password: &str) -> Result<()> {
        let conn = self.conn();
        let auth = config(&conn, "")?;
        ensure!(auth.password_enabled && auth.password_hash.as_deref() == Some(checked_password), "密码登录已关闭或密码已修改，请重新登录");
        insert_session(&conn, hash, expires, "password", "")
    }

    pub fn github_session(&self, hash: &str, expires: i64, user: &str, stamp: &str, site: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let auth = config(&tx, site)?;
        ensure!(auth.github_ready() && auth.stamp == stamp && auth.github_users.contains(&user.to_ascii_lowercase()), "GitHub 配置已变更，请重新发起登录");
        set(&tx, "github_verified", stamp)?;
        insert_session(&tx, hash, expires, "github", &user.to_ascii_lowercase())?;
        tx.commit()?;
        Ok(())
    }

    /// The patch, login policy, session revocation and replacement cookie are
    /// one transaction. A rejected patch changes nothing, even on racing writes.
    pub fn save_settings_atomic(
        &self, patch: &Map<String, Value>, password_hash: Option<&str>, site: &str,
        actor: Option<&str>, replacement: Option<(&str, i64)>,
    ) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let identity: (String, String) = if let Some(actor) = actor {
            tx.query_row("SELECT kind,identity FROM session WHERE token_hash=?1 AND expires_at>?2", params![actor,Utc::now().timestamp()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(|| anyhow::anyhow!("登录已失效，请重新登录"))?
        } else { ("legacy".into(), String::new()) };
        let before = config(&tx, site)?;
        for (key, value) in patch {
            if key != "admin_password" {
                set(&tx, key, value.as_str().unwrap_or_default())?;
            }
        }
        if let Some(hash) = password_hash {
            set(&tx, "admin_password_hash", hash)?;
        }
        let after = config(&tx, site)?;
        let github_changed = before.github_id != after.github_id || before.github_secret != after.github_secret || before.github_users != after.github_users;
        if github_changed {
            ensure!(before.password_enabled, "请先开启应急密码，再修改 GitHub 登录配置");
            set(&tx, "github_revision", &random_token())?;
            set(&tx, "github_verified", "")?;
            tx.execute("DELETE FROM session WHERE kind='github'", [])?;
        }
        ensure!(after.password_enabled || (!github_changed && after.github_ready() && after.verified), "请先完整配置 GitHub 并成功登录验证，再关闭应急密码");
        if patch.get("password_login").and_then(Value::as_str) == Some("on") {
            ensure!(after.password_hash.as_ref().is_some_and(|h| !h.is_empty()), "请先设置应急密码");
        }
        if let Some((hash, expires)) = replacement {
            tx.execute("DELETE FROM session", [])?;
            let (kind, user) = if github_changed { ("password", "") } else { (identity.0.as_str(), identity.1.as_str()) };
            insert_session(&tx, hash, expires, kind, user)?;
        }
        if !after.password_enabled {
            tx.execute("DELETE FROM session WHERE kind!='github'", [])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn recover_password(&self, hash: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        set(&tx, "admin_password_hash", hash)?;
        set(&tx, "password_login", "on")?;
        tx.execute("DELETE FROM session", [])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(db: &Db, value: Value) -> Result<()> {
        db.save_settings_atomic(value.as_object().unwrap(), None, "https://hub.test", None, None)
    }

    #[test]
    fn only_a_verified_current_github_configuration_can_disable_passwords() {
        let db = Db::open(":memory:").unwrap();
        db.set("admin_password_hash", "hash").unwrap();
        assert!(save(&db, serde_json::json!({"password_login":"off"})).is_err());
        save(&db, serde_json::json!({"github_client_id":"id", "github_client_secret":"secret", "github_allowed_users":"Owner"})).unwrap();
        let old = db.auth_config("https://hub.test").unwrap().stamp;
        assert!(save(&db, serde_json::json!({"password_login":"off"})).is_err());
        db.github_session("github", i64::MAX, "owner", &old, "https://hub.test").unwrap();
        db.password_session("password", i64::MAX, "hash").unwrap();
        db.create_session("legacy", i64::MAX).unwrap();
        save(&db, serde_json::json!({"password_login":"off"})).unwrap();
        assert!(!db.session_valid("password"));
        assert!(!db.session_valid("legacy"));
        assert!(db.session_valid("github"));
        assert!(db.password_session("late", i64::MAX, "hash").is_err());
        assert!(save(&db, serde_json::json!({"site_name":"must rollback", "github_client_secret":"changed"})).is_err());
        assert!(db.get("site_name").is_none());
        assert_eq!(db.get("github_client_secret").as_deref(), Some("secret"));
        save(&db, serde_json::json!({"password_login":"on"})).unwrap();
        save(&db, serde_json::json!({"github_client_secret":"changed"})).unwrap();
        assert!(!db.session_valid("github"));
        assert!(db.github_session("stale-callback", i64::MAX, "owner", &old, "https://hub.test").is_err());
        assert!(save(&db, serde_json::json!({"password_login":"off"})).is_err());
    }

    #[test]
    fn recovery_enables_password_and_revokes_sessions_atomically() {
        let db = Db::open(":memory:").unwrap();
        db.set("password_login", "off").unwrap();
        db.create_session("old", i64::MAX).unwrap();
        db.recover_password("replacement").unwrap();
        assert!(db.auth_config("").unwrap().password_enabled);
        assert!(!db.session_valid("old"));
        assert!(db.password_session("new", i64::MAX, "replacement").is_ok());
    }
}

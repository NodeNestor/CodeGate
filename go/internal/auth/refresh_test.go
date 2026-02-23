package auth

import (
	"database/sql"
	"testing"
	"time"

	"codegate-proxy/internal/db"
)

func TestNeedsRefresh_NonOAuth(t *testing.T) {
	account := db.Account{
		AuthType: "api_key",
	}
	if NeedsRefresh(account) {
		t.Error("non-OAuth accounts should not need refresh")
	}
}

func TestNeedsRefresh_NoExpiry(t *testing.T) {
	account := db.Account{
		AuthType:       "oauth",
		TokenExpiresAt: sql.NullInt64{Valid: false},
	}
	if NeedsRefresh(account) {
		t.Error("accounts without expiry should not need refresh")
	}
}

func TestNeedsRefresh_FarFuture(t *testing.T) {
	account := db.Account{
		AuthType:       "oauth",
		TokenExpiresAt: sql.NullInt64{Valid: true, Int64: time.Now().Add(1 * time.Hour).UnixMilli()},
	}
	if NeedsRefresh(account) {
		t.Error("token expiring in 1 hour should not need refresh")
	}
}

func TestNeedsRefresh_NearExpiry(t *testing.T) {
	account := db.Account{
		AuthType:       "oauth",
		TokenExpiresAt: sql.NullInt64{Valid: true, Int64: time.Now().Add(2 * time.Minute).UnixMilli()},
	}
	if !NeedsRefresh(account) {
		t.Error("token expiring in 2 minutes should need refresh (within 5 min margin)")
	}
}

func TestNeedsRefresh_Expired(t *testing.T) {
	account := db.Account{
		AuthType:       "oauth",
		TokenExpiresAt: sql.NullInt64{Valid: true, Int64: time.Now().Add(-10 * time.Minute).UnixMilli()},
	}
	if !NeedsRefresh(account) {
		t.Error("expired token should need refresh")
	}
}

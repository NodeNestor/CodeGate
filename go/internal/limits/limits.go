package limits

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

// ModelLimits holds per-model capability overrides.
type ModelLimits struct {
	MaxOutputTokens     *int
	SupportsToolCalling *bool
	SupportsReasoning   *bool
}

var (
	cache   = make(map[string]ModelLimits)
	cacheMu sync.RWMutex
)

func dbPath() string {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	return filepath.Join(dataDir, "codegate.db")
}

// InitModelLimitsTable creates the model_limits table if needed and loads cache.
func InitModelLimitsTable() {
	wConn, err := sql.Open("sqlite3", dbPath()+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		log.Printf("[limits] Failed to open DB for init: %v", err)
		return
	}
	defer wConn.Close()

	_, err = wConn.Exec(`CREATE TABLE IF NOT EXISTS model_limits (
		model_id TEXT PRIMARY KEY,
		max_output_tokens INTEGER,
		supports_tool_calling INTEGER,
		supports_reasoning INTEGER
	)`)
	if err != nil {
		log.Printf("[limits] Failed to create table: %v", err)
	}

	reloadCache()
	log.Println("[limits] Model limits initialized")
}

func reloadCache() {
	conn, err := sql.Open("sqlite3", dbPath()+"?_journal_mode=WAL&_foreign_keys=on&mode=ro")
	if err != nil {
		return
	}
	defer conn.Close()

	rows, err := conn.Query("SELECT model_id, max_output_tokens, supports_tool_calling, supports_reasoning FROM model_limits")
	if err != nil {
		return
	}
	defer rows.Close()

	newCache := make(map[string]ModelLimits)
	for rows.Next() {
		var modelID string
		var maxOut sql.NullInt64
		var toolCalling, reasoning sql.NullInt64

		if err := rows.Scan(&modelID, &maxOut, &toolCalling, &reasoning); err != nil {
			continue
		}

		ml := ModelLimits{}
		if maxOut.Valid {
			v := int(maxOut.Int64)
			ml.MaxOutputTokens = &v
		}
		if toolCalling.Valid {
			v := toolCalling.Int64 == 1
			ml.SupportsToolCalling = &v
		}
		if reasoning.Valid {
			v := reasoning.Int64 == 1
			ml.SupportsReasoning = &v
		}
		newCache[modelID] = ml
	}

	cacheMu.Lock()
	cache = newCache
	cacheMu.Unlock()
}

// GetModelLimits returns limits for a model using prefix matching.
func GetModelLimits(modelID string) *ModelLimits {
	cacheMu.RLock()
	defer cacheMu.RUnlock()

	if ml, ok := cache[modelID]; ok {
		return &ml
	}

	for key, ml := range cache {
		if strings.HasPrefix(modelID, key) || strings.HasPrefix(key, modelID) {
			mlCopy := ml
			return &mlCopy
		}
	}

	return nil
}

// ClampMaxTokens clamps a max_tokens value to the model's configured limit.
func ClampMaxTokens(value *int, modelID string) *int {
	if value == nil {
		return nil
	}
	ml := GetModelLimits(modelID)
	if ml == nil || ml.MaxOutputTokens == nil {
		return value
	}
	if *value > *ml.MaxOutputTokens {
		clamped := *ml.MaxOutputTokens
		return &clamped
	}
	return value
}

// GetAllModelLimits returns all configured model limits.
func GetAllModelLimits() map[string]ModelLimits {
	cacheMu.RLock()
	defer cacheMu.RUnlock()
	result := make(map[string]ModelLimits, len(cache))
	for k, v := range cache {
		result[k] = v
	}
	return result
}

// SetModelLimit sets limits for a model.
func SetModelLimit(modelID string, maxOut *int, toolCalling *bool, reasoning *bool) {
	wConn, err := sql.Open("sqlite3", dbPath()+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return
	}
	defer wConn.Close()

	var maxOutVal, tcVal, rVal any
	if maxOut != nil {
		maxOutVal = *maxOut
	}
	if toolCalling != nil {
		if *toolCalling {
			tcVal = 1
		} else {
			tcVal = 0
		}
	}
	if reasoning != nil {
		if *reasoning {
			rVal = 1
		} else {
			rVal = 0
		}
	}

	wConn.Exec(`INSERT INTO model_limits (model_id, max_output_tokens, supports_tool_calling, supports_reasoning)
		VALUES (?, ?, ?, ?) ON CONFLICT(model_id) DO UPDATE SET
		max_output_tokens = excluded.max_output_tokens,
		supports_tool_calling = excluded.supports_tool_calling,
		supports_reasoning = excluded.supports_reasoning`, modelID, maxOutVal, tcVal, rVal)

	reloadCache()
}

// DeleteModelLimit removes limits for a model.
func DeleteModelLimit(modelID string) bool {
	wConn, err := sql.Open("sqlite3", dbPath()+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return false
	}
	defer wConn.Close()

	result, err := wConn.Exec("DELETE FROM model_limits WHERE model_id = ?", modelID)
	if err != nil {
		return false
	}
	n, _ := result.RowsAffected()
	reloadCache()
	return n > 0
}

package service

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

func setupIsolatedSchemaDB(t *testing.T) *gorm.DB {
	t.Helper()

	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping integration test")
	}

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("invalid TEST_DATABASE_URL: %v", err)
	}
	dbName := strings.ToLower(strings.TrimPrefix(parsed.Path, "/"))
	if os.Getenv("UPWORK_BUDDY_ALLOW_TEST_DSN") != "1" &&
		!strings.Contains(dbName, "test") &&
		!strings.Contains(dbName, "verify") {
		t.Fatalf("refusing to run integration tests against non-test database %q (name must contain 'test' or 'verify')", dbName)
	}

	adminDB, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("failed to open test admin db: %v", err)
	}
	if err := adminDB.Ping(); err != nil {
		_ = adminDB.Close()
		t.Fatalf("failed to ping test database: %v", err)
	}

	schemaName := fmt.Sprintf("test_dbsvc_%d_%d", os.Getpid(), time.Now().UnixNano())
	if _, err := adminDB.Exec(fmt.Sprintf(`CREATE SCHEMA "%s"`, schemaName)); err != nil {
		_ = adminDB.Close()
		t.Fatalf("failed to create isolated test schema %q: %v", schemaName, err)
	}

	q := parsed.Query()
	q.Set("search_path", schemaName)
	parsed.RawQuery = q.Encode()

	sqlDB, err := sql.Open("pgx", parsed.String())
	if err != nil {
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to open scoped test db: %v", err)
	}

	gormDB, err := gorm.Open(postgres.New(postgres.Config{
		Conn: sqlDB,
	}), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to open gorm test db: %v", err)
	}

	if err := gormDB.AutoMigrate(AllModels()...); err != nil {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to AutoMigrate AllModels(): %v", err)
	}

	t.Cleanup(func() {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
	})

	return gormDB
}

func TestAllModels_DependencyOrder(t *testing.T) {
	models := AllModels()
	indexOf := make(map[reflect.Type]int, len(models))
	for i, m := range models {
		indexOf[reflect.TypeOf(m)] = i
	}

	assertBefore := func(first, second any) {
		t.Helper()
		t1 := reflect.TypeOf(first)
		t2 := reflect.TypeOf(second)
		i1, ok1 := indexOf[t1]
		i2, ok2 := indexOf[t2]
		if !ok1 || !ok2 {
			t.Fatalf("missing model in AllModels(): %v (%v), %v (%v)", t1, ok1, t2, ok2)
		}
		if i1 >= i2 {
			t.Fatalf("expected %v (idx %d) before %v (idx %d) in AllModels()", t1, i1, t2, i2)
		}
	}

	assertBefore(&SearchRun{}, &Job{})
	assertBefore(&SearchRun{}, &SearchRunJob{})
	assertBefore(&Job{}, &SearchRunJob{})
	assertBefore(&EnrichmentBatch{}, &EnrichmentBatchItem{})
	assertBefore(&Job{}, &EnrichmentBatchItem{})
}

func TestAllModels_AutoMigrateAndJobDefaults(t *testing.T) {
	db := setupIsolatedSchemaDB(t)

	job := Job{Title: "Minimal"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create minimal job: %v", err)
	}

	var got Job
	if err := db.First(&got, job.ID).Error; err != nil {
		t.Fatalf("load job: %v", err)
	}

	if got.AIEnrichmentStatus != "none" {
		t.Fatalf("AIEnrichmentStatus = %q, want 'none'", got.AIEnrichmentStatus)
	}
	if got.AIEnrichedAt != nil {
		t.Fatalf("AIEnrichedAt = %v, want nil", got.AIEnrichedAt)
	}
	if got.AIEnrichmentError != "" || got.AIModel != "" || got.AIEffort != "" {
		t.Fatalf("expected empty AI metadata defaults, got err=%q model=%q effort=%q", got.AIEnrichmentError, got.AIModel, got.AIEffort)
	}
	if got.AITokensUsed != nil || got.LastSearchRunID != nil {
		t.Fatalf("expected nil AITokensUsed and LastSearchRunID, got tokens=%v runID=%v", got.AITokensUsed, got.LastSearchRunID)
	}
}

func TestSearchRunAndSearchRunJob_CompositePKAndCascades(t *testing.T) {
	db := setupIsolatedSchemaDB(t)

	run := SearchRun{
		Label:          "Go sweep",
		Source:         "search",
		TriggeredBy:    "mcp",
		QueriesJSON:    JSONB(`["golang","postgres"]`),
		TotalScraped:   10,
		FilteredCount:  5,
		PersistedCount: 1,
	}
	if err := db.Create(&run).Error; err != nil {
		t.Fatalf("create search run: %v", err)
	}

	job := Job{
		Title:           "Senior Go Engineer",
		LastSearchRunID: &run.ID,
	}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	link := SearchRunJob{SearchRunID: run.ID, JobID: job.ID}
	if err := db.Create(&link).Error; err != nil {
		t.Fatalf("create search_run_jobs link: %v", err)
	}

	// Duplicate composite PK insert must fail without OnConflict.
	if err := db.Create(&SearchRunJob{SearchRunID: run.ID, JobID: job.ID}).Error; err == nil {
		t.Fatal("expected duplicate (search_run_id, job_id) insert to fail")
	}

	// Duplicate insert with DoNothing must succeed idempotently.
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&SearchRunJob{SearchRunID: run.ID, JobID: job.ID}).Error; err != nil {
		t.Fatalf("expected OnConflict DoNothing insert to succeed: %v", err)
	}

	// Deleting SearchRun cascades to SearchRunJob and sets Job.LastSearchRunID = NULL.
	if err := db.Delete(&SearchRun{}, run.ID).Error; err != nil {
		t.Fatalf("delete search run: %v", err)
	}

	var linkCount int64
	if err := db.Model(&SearchRunJob{}).Where("search_run_id = ? AND job_id = ?", run.ID, job.ID).Count(&linkCount).Error; err != nil {
		t.Fatalf("count search_run_jobs: %v", err)
	}
	if linkCount != 0 {
		t.Fatalf("expected search_run_jobs to cascade delete on SearchRun delete, got %d", linkCount)
	}

	var reloadedJob Job
	if err := db.First(&reloadedJob, job.ID).Error; err != nil {
		t.Fatalf("expected Job to survive SearchRun delete: %v", err)
	}
	if reloadedJob.LastSearchRunID != nil {
		t.Fatalf("expected Job.LastSearchRunID to be SET NULL on SearchRun delete, got %v", *reloadedJob.LastSearchRunID)
	}

	// Deleting Job cascades to SearchRunJob while SearchRun survives.
	run2 := SearchRun{Label: "Second run", Source: "search", TriggeredBy: "ui"}
	if err := db.Create(&run2).Error; err != nil {
		t.Fatalf("create run2: %v", err)
	}
	if err := db.Create(&SearchRunJob{SearchRunID: run2.ID, JobID: job.ID}).Error; err != nil {
		t.Fatalf("create link2: %v", err)
	}
	if err := db.Delete(&Job{}, job.ID).Error; err != nil {
		t.Fatalf("delete job: %v", err)
	}

	if err := db.Model(&SearchRunJob{}).Where("search_run_id = ?", run2.ID).Count(&linkCount).Error; err != nil {
		t.Fatalf("count search_run_jobs after job delete: %v", err)
	}
	if linkCount != 0 {
		t.Fatalf("expected search_run_jobs to cascade delete on Job delete, got %d", linkCount)
	}

	var run2Check SearchRun
	if err := db.First(&run2Check, run2.ID).Error; err != nil {
		t.Fatalf("expected SearchRun to survive Job delete: %v", err)
	}
}

func TestEnrichmentBatchAndItems_CRUDAndCascade(t *testing.T) {
	db := setupIsolatedSchemaDB(t)

	batch := EnrichmentBatch{
		TriggeredBy: "ui",
		TotalCount:  1,
		QueuedCount: 1,
	}
	if err := db.Create(&batch).Error; err != nil {
		t.Fatalf("create enrichment batch: %v", err)
	}
	if batch.Mode != "full" || batch.Status != "queued" || batch.Force {
		t.Fatalf("unexpected batch defaults: mode=%q status=%q force=%v", batch.Mode, batch.Status, batch.Force)
	}

	job := Job{Title: "Batch target job"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	item := EnrichmentBatchItem{
		BatchID: batch.ID,
		JobID:   job.ID,
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatalf("create batch item: %v", err)
	}
	if item.Status != "queued" || item.TotalTokens != 0 || item.DetailFetched || item.LLMInvoked {
		t.Fatalf("unexpected item defaults: %+v", item)
	}

	if err := db.Model(&item).Updates(map[string]any{
		"status":        "completed",
		"llm_invoked":   true,
		"input_tokens":  100,
		"output_tokens": 50,
		"total_tokens":  150,
	}).Error; err != nil {
		t.Fatalf("update batch item: %v", err)
	}

	// Deleting EnrichmentBatch cascades to EnrichmentBatchItem while Job survives.
	if err := db.Delete(&EnrichmentBatch{}, batch.ID).Error; err != nil {
		t.Fatalf("delete enrichment batch: %v", err)
	}
	var itemCount int64
	if err := db.Model(&EnrichmentBatchItem{}).Where("id = ?", item.ID).Count(&itemCount).Error; err != nil {
		t.Fatalf("count batch items: %v", err)
	}
	if itemCount != 0 {
		t.Fatalf("expected EnrichmentBatchItem cascade delete on Batch delete, got %d", itemCount)
	}
	if err := db.First(&Job{}, job.ID).Error; err != nil {
		t.Fatalf("expected Job to survive Batch delete: %v", err)
	}

	// Deleting Job cascades to EnrichmentBatchItem while EnrichmentBatch survives.
	batch2 := EnrichmentBatch{Mode: "ai_only", TriggeredBy: "mcp"}
	if err := db.Create(&batch2).Error; err != nil {
		t.Fatalf("create batch2: %v", err)
	}
	item2 := EnrichmentBatchItem{BatchID: batch2.ID, JobID: job.ID}
	if err := db.Create(&item2).Error; err != nil {
		t.Fatalf("create item2: %v", err)
	}
	if err := db.Delete(&Job{}, job.ID).Error; err != nil {
		t.Fatalf("delete job: %v", err)
	}
	if err := db.Model(&EnrichmentBatchItem{}).Where("id = ?", item2.ID).Count(&itemCount).Error; err != nil {
		t.Fatalf("count batch items after job delete: %v", err)
	}
	if itemCount != 0 {
		t.Fatalf("expected EnrichmentBatchItem cascade delete on Job delete, got %d", itemCount)
	}
	if err := db.First(&EnrichmentBatch{}, batch2.ID).Error; err != nil {
		t.Fatalf("expected EnrichmentBatch to survive Job delete: %v", err)
	}
}

func TestExistingAnalyzedJobsBackfill_Idempotent(t *testing.T) {
	db := setupIsolatedSchemaDB(t)

	presetTime := time.Date(2026, 11, 15, 10, 30, 0, 0, time.UTC)

	job1 := Job{Title: "Analyzed no timestamp", Proposal: "Cover letter...", AIEnrichmentStatus: "none"}
	job2 := Job{Title: "Analyzed preset timestamp", Proposal: "Cover letter 2", AIEnrichmentStatus: "none", AIEnrichedAt: &presetTime}
	job3 := Job{Title: "Whitespace proposal", Proposal: "   \n\t ", AIEnrichmentStatus: "none"}
	job4 := Job{Title: "Empty proposal", Proposal: "", AIEnrichmentStatus: "none"}

	for _, j := range []*Job{&job1, &job2, &job3, &job4} {
		if err := db.Create(j).Error; err != nil {
			t.Fatalf("seed job %q: %v", j.Title, err)
		}
	}

	backfillSQL := `UPDATE "jobs"
SET "ai_enrichment_status" = 'completed',
    "ai_enriched_at" = COALESCE("ai_enriched_at", "updated_at")
WHERE COALESCE("proposal", '') ~ '\S'
  AND "ai_enrichment_status" = 'none';`

	if err := db.Exec(backfillSQL).Error; err != nil {
		t.Fatalf("first backfill execution: %v", err)
	}
	if err := db.Exec(backfillSQL).Error; err != nil {
		t.Fatalf("second backfill execution: %v", err)
	}

	var got1, got2, got3, got4 Job
	if err := db.First(&got1, job1.ID).Error; err != nil {
		t.Fatalf("load job1: %v", err)
	}
	if err := db.First(&got2, job2.ID).Error; err != nil {
		t.Fatalf("load job2: %v", err)
	}
	if err := db.First(&got3, job3.ID).Error; err != nil {
		t.Fatalf("load job3: %v", err)
	}
	if err := db.First(&got4, job4.ID).Error; err != nil {
		t.Fatalf("load job4: %v", err)
	}

	if got1.AIEnrichmentStatus != "completed" || got1.AIEnrichedAt == nil || !got1.AIEnrichedAt.Equal(got1.UpdatedAt) {
		t.Fatalf("job1 = (status=%q, enrichedAt=%v, updatedAt=%v), want completed & equal to updated_at", got1.AIEnrichmentStatus, got1.AIEnrichedAt, got1.UpdatedAt)
	}
	if got2.AIEnrichmentStatus != "completed" || got2.AIEnrichedAt == nil || !got2.AIEnrichedAt.Equal(presetTime) {
		t.Fatalf("job2 = (status=%q, enrichedAt=%v), want completed & %v", got2.AIEnrichmentStatus, got2.AIEnrichedAt, presetTime)
	}
	if got3.AIEnrichmentStatus != "none" || got3.AIEnrichedAt != nil {
		t.Fatalf("job3 should stay 'none'/nil, got (%q, %v)", got3.AIEnrichmentStatus, got3.AIEnrichedAt)
	}
	if got4.AIEnrichmentStatus != "none" || got4.AIEnrichedAt != nil {
		t.Fatalf("job4 should stay 'none'/nil, got (%q, %v)", got4.AIEnrichmentStatus, got4.AIEnrichedAt)
	}
}

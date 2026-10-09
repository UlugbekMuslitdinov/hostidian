package files

import (
	"time"

	"hostidian/backend/internal/db/sqlcgen"
)

func listUnreferencedParams(minAge time.Duration) sqlcgen.ListUnreferencedAttachmentsParams {
	return sqlcgen.ListUnreferencedAttachmentsParams{MinAgeSeconds: minAge.Seconds(), Batch: sweepBatch}
}

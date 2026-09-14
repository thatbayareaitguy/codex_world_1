CREATE INDEX "artist_mapping_review_pending_idx" ON "artist_mapping_reviews" USING btree ("provider","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "feed_user_seen_id_idx" ON "feed_items" USING btree ("user_id","first_seen_at","id");--> statement-breakpoint
CREATE INDEX "feed_user_release_seen_idx" ON "feed_items" USING btree ("user_id","release_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "feed_track_idx" ON "feed_items" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "feed_appearance_idx" ON "feed_items" USING btree ("appearance_id");--> statement-breakpoint
CREATE INDEX "playlist_export_track_status_idx" ON "playlist_exports" USING btree ("track_id","status");--> statement-breakpoint
CREATE INDEX "release_candidates_matched_track_seen_idx" ON "release_candidates" USING btree ("matched_track_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "release_external_release_provider_idx" ON "release_external_ids" USING btree ("release_id","provider");--> statement-breakpoint
CREATE INDEX "scan_runs_started_history_idx" ON "scan_runs" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "scan_runs_status_provider_started_idx" ON "scan_runs" USING btree ("status","provider","started_at");--> statement-breakpoint
CREATE INDEX "source_evidence_candidate_idx" ON "source_evidence" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "spotify_artist_coverage_reconcile_idx" ON "spotify_artist_coverage" USING btree ("partial","status","updated_at");--> statement-breakpoint
CREATE INDEX "spotify_release_track_retrieval_resume_idx" ON "spotify_release_track_retrievals" USING btree ("status","next_offset","updated_at");--> statement-breakpoint
CREATE INDEX "spotify_release_track_retrieval_release_idx" ON "spotify_release_track_retrievals" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "track_availability_track_provider_idx" ON "track_availabilities" USING btree ("track_id","provider");--> statement-breakpoint
CREATE INDEX "track_external_track_provider_idx" ON "track_external_ids" USING btree ("track_id","provider");

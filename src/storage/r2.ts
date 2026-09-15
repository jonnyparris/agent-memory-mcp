import type { FileVersion, MemoryFile, MemoryFileMetadata } from "../types";

/**
 * Where superseded content is kept, as `_history/<path>/<version-id>.snap`.
 *
 * R2 has no object versioning — `PutBucketVersioning` and
 * `GetBucketVersioning` are both unimplemented in its S3 layer, there is no
 * REST endpoint for it, and `wrangler r2 bucket update` only takes
 * `storage-class`. So a write was unrecoverable: this module used to ask for
 * `bucket.list({ include: ["versions"] })`, which is not a valid option, and
 * dutifully returned `[]` forever while telling callers to enable a bucket
 * feature that does not exist. History is therefore kept by hand.
 *
 * Three properties of this layout are load-bearing:
 *
 * - **Underscore prefix, excluded from `list`.** Snapshots must never appear
 *   in normal enumeration. `list` has no pagination at the tool level, so a
 *   few hundred snapshots would otherwise bloat every `list("", true)`, and
 *   the client sync script would happily download the lot.
 * - **`.snap`, not `.md`.** The daily reflection scanner filters for `.md`
 *   and would otherwise start feeding old copies of your notes back into the
 *   LLM. Belt and braces with the `list` exclusion: two independent reasons
 *   it can't happen.
 * - **Timestamp-led version ids.** R2 lists lexicographically, so an
 *   ISO-derived prefix makes "newest first" a reverse of natural order
 *   rather than a sort of parsed dates.
 */
export const HISTORY_PREFIX = "_history/";

/** Snapshots kept per path before the oldest are dropped. */
export const HISTORY_RETENTION = 20;

export interface WriteOptions {
	/**
	 * Snapshot the current content to `_history/` before overwriting it.
	 *
	 * Off by default, and deliberately opt-in per call site rather than
	 * automatic. `reminders/index.json` and `conversations/index.json` are
	 * rewritten on every single mutation; snapshotting those would bury the
	 * handful of files a human actually edits under machine churn.
	 */
	history?: boolean;
	/** Snapshots to keep for this path. Defaults to `HISTORY_RETENTION`. */
	retain?: number;
}

export interface WriteResult {
	version_id?: string;
	/**
	 * Version id the *replaced* content was saved under, when history was
	 * requested and there was something to replace. This is the handle you
	 * pass to `rollback` to undo this write.
	 */
	previous_version_id?: string;
}

export interface R2Storage {
	read(path: string): Promise<MemoryFile | null>;
	write(path: string, content: string, options?: WriteOptions): Promise<WriteResult>;
	list(path?: string, recursive?: boolean): Promise<MemoryFileMetadata[]>;
	delete(path: string): Promise<void>;
	getVersions(path: string, limit?: number): Promise<FileVersion[]>;
	getVersion(path: string, versionId: string): Promise<string | null>;
}

/** Directory holding every snapshot of one path. */
function historyDir(path: string): string {
	return `${HISTORY_PREFIX}${path}/`;
}

function historyKey(path: string, versionId: string): string {
	return `${historyDir(path)}${versionId}.snap`;
}

/**
 * Sortable, collision-resistant version id.
 *
 * The timestamp is colon- and dot-free so it is safe in a key and still
 * sorts chronologically as a string. The suffix matters: `write_many`
 * snapshots up to 50 paths concurrently and two writes to the same path
 * within a millisecond would otherwise collide and silently lose one.
 */
function newVersionId(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

/** Every snapshot key for one path, oldest first (keys sort chronologically). */
async function listHistoryKeys(bucket: R2Bucket, path: string): Promise<R2Object[]> {
	const prefix = historyDir(path);
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix, cursor });
		objects.push(...listed.objects);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Copy the object currently at `path` into `_history/`, then trim the oldest
 * snapshots beyond the retention limit. Returns the new version id, or null
 * when there was nothing at `path` to preserve.
 */
async function snapshot(
	bucket: R2Bucket,
	path: string,
	retain: number = HISTORY_RETENTION,
): Promise<string | undefined> {
	const existing = await bucket.get(path);
	if (!existing) {
		// First write to this path. Nothing has been superseded, so there is
		// no version to record — and recording an empty one would make
		// `rollback` offer to restore a file into existence from nothing.
		return undefined;
	}

	const versionId = newVersionId();
	// Stream the body straight through rather than `await existing.text()`.
	// These are whole memory documents — learnings.md is 76KB and climbing —
	// and there is no reason to hold one in memory to hand it back to R2.
	await bucket.put(historyKey(path, versionId), existing.body, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
		customMetadata: { source: path, capturedAt: new Date().toISOString() },
	});

	if (retain > 0) {
		const keys = await listHistoryKeys(bucket, path);
		const excess = keys.length - retain;
		for (let i = 0; i < excess; i++) {
			const victim = keys[i];
			if (victim) await bucket.delete(victim.key);
		}
	}

	return versionId;
}

export function createR2Storage(bucket: R2Bucket): R2Storage {
	return {
		async read(path: string): Promise<MemoryFile | null> {
			const object = await bucket.get(path);
			if (!object) {
				return null;
			}

			const content = await object.text();
			return {
				path,
				content,
				updated_at: object.uploaded.toISOString(),
				size: object.size,
			};
		},

		async write(path: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
			let previousVersionId: string | undefined;

			if (options.history && !path.startsWith(HISTORY_PREFIX)) {
				// Snapshot failures must not block the write. The caller
				// asked to persist content; losing that to a bookkeeping
				// error is the more serious failure. A safety net must not
				// be able to stop you saving your work.
				try {
					previousVersionId = await snapshot(bucket, path, options.retain);
				} catch (error) {
					console.error(`history snapshot failed for ${path}:`, error);
				}
			}

			const result = await bucket.put(path, content, {
				httpMetadata: {
					contentType: "text/plain; charset=utf-8",
				},
			});

			return {
				// R2 populates this only with bucket versioning enabled, which
				// it never is. Kept so the field does not vanish from existing
				// response shapes; `previous_version_id` is the useful one.
				version_id: result?.version,
				previous_version_id: previousVersionId,
			};
		},

		async list(path = "", recursive = false): Promise<MemoryFileMetadata[]> {
			const prefix = path ? (path.endsWith("/") ? path : `${path}/`) : "";
			const delimiter = recursive ? undefined : "/";

			const files: MemoryFileMetadata[] = [];
			const seenPrefixes = new Set<string>();

			// R2 paginates, and it does not promise to fill a page before
			// setting `truncated` — a single call can return well under the
			// limit and still have more behind a cursor. Ignoring that made
			// `list` silently under-report: a bucket holding ~960 objects
			// answered with 397 for one prefix and 685 for another, and files
			// that were perfectly readable never appeared at all. Any audit
			// built on those numbers is wrong in a way nothing surfaces, so
			// always drain the cursor.
			let cursor: string | undefined;
			do {
				const listed = await bucket.list({ prefix, delimiter, cursor });

				for (const object of listed.objects) {
					// Snapshots are storage, not content. They stay readable
					// through `history`/`rollback` but must never surface as
					// files: `list` is unpaginated at the tool level, the
					// client sync script mirrors whatever it returns to disk,
					// and the reflection scanner reads what it finds.
					if (object.key.startsWith(HISTORY_PREFIX)) continue;
					files.push({
						path: object.key,
						size: object.size,
						updated_at: object.uploaded.toISOString(),
						// md5 hex (no quotes) for simple puts — clients diff this
						// against a local content hash to skip no-op downloads.
						etag: object.etag,
					});
				}

				// Include "directories" from delimited prefixes. Deduplicated
				// because the same prefix can recur across pages.
				if (listed.delimitedPrefixes) {
					for (const delimited of listed.delimitedPrefixes) {
						if (delimited.startsWith(HISTORY_PREFIX)) continue;
						if (seenPrefixes.has(delimited)) continue;
						seenPrefixes.add(delimited);
						files.push({
							path: delimited,
							size: 0,
							updated_at: new Date().toISOString(),
						});
					}
				}

				cursor = listed.truncated ? listed.cursor : undefined;
			} while (cursor);

			return files;
		},

		async delete(path: string): Promise<void> {
			await bucket.delete(path);
		},

		async getVersions(path: string, limit = 10): Promise<FileVersion[]> {
			const objects = await listHistoryKeys(bucket, path);
			const dir = historyDir(path);

			// Newest first: keys are timestamp-led, so reversing natural
			// order is the correct sort without parsing anything.
			return objects
				.reverse()
				.slice(0, limit)
				.map((object) => ({
					version_id: object.key.slice(dir.length).replace(/\.snap$/, ""),
					// `uploaded` is when the snapshot was taken, which is the
					// moment the content stopped being current.
					timestamp: object.uploaded.toISOString(),
					size: object.size,
				}));
		},

		async getVersion(path: string, versionId: string): Promise<string | null> {
			// No try/catch. The old implementation swallowed every error and
			// returned null, so "this version does not exist" and "R2 is
			// failing" were indistinguishable — and the caller reported the
			// reassuring one. A real fault should surface.
			const object = await bucket.get(historyKey(path, versionId));
			return object ? await object.text() : null;
		},
	};
}

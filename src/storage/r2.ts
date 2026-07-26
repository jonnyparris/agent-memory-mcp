import type { FileVersion, MemoryFile, MemoryFileMetadata } from "../types";

export interface R2Storage {
	read(path: string): Promise<MemoryFile | null>;
	write(path: string, content: string): Promise<{ version_id?: string }>;
	list(path?: string, recursive?: boolean): Promise<MemoryFileMetadata[]>;
	delete(path: string): Promise<void>;
	getVersions(path: string, limit?: number): Promise<FileVersion[]>;
	getVersion(path: string, versionId: string): Promise<string | null>;
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

		async write(path: string, content: string): Promise<{ version_id?: string }> {
			const result = await bucket.put(path, content, {
				httpMetadata: {
					contentType: "text/plain; charset=utf-8",
				},
			});

			return {
				version_id: result?.version,
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
			// R2 versioning requires bucket-level versioning to be enabled
			// For now, return empty array - this will be implemented when versioning is enabled
			// In production, use bucket.list with versions option
			try {
				const listed = await bucket.list({
					prefix: path,
					include: ["versions"],
				});

				const versions: FileVersion[] = [];
				for (const object of listed.objects) {
					if (object.key === path && object.version) {
						versions.push({
							version_id: object.version,
							timestamp: object.uploaded.toISOString(),
							size: object.size,
						});
					}
				}

				return versions.slice(0, limit);
			} catch {
				// Versioning not enabled or not supported
				return [];
			}
		},

		async getVersion(path: string, versionId: string): Promise<string | null> {
			try {
				const object = await bucket.get(path, { version: versionId });
				if (!object) {
					return null;
				}
				return await object.text();
			} catch {
				return null;
			}
		},
	};
}

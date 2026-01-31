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

			const listed = await bucket.list({
				prefix,
				delimiter,
			});

			const files: MemoryFileMetadata[] = [];

			for (const object of listed.objects) {
				files.push({
					path: object.key,
					size: object.size,
					updated_at: object.uploaded.toISOString(),
				});
			}

			// Include "directories" from delimited prefixes
			if (listed.delimitedPrefixes) {
				for (const prefix of listed.delimitedPrefixes) {
					files.push({
						path: prefix,
						size: 0,
						updated_at: new Date().toISOString(),
					});
				}
			}

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

/**
 * Global type declarations for Cloudflare Workers runtime
 * These types are available globally in the Workers environment
 */

// Web Platform API interfaces
interface Request {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly bodyUsed: boolean;
	json<T = unknown>(): Promise<T>;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	formData(): Promise<FormData>;
	blob(): Promise<Blob>;
	clone(): Request;
}

interface RequestInit {
	method?: string;
	headers?: HeadersInit;
	body?: BodyInit | null;
	mode?: RequestMode;
	credentials?: RequestCredentials;
	cache?: RequestCache;
	redirect?: RequestRedirect;
	referrer?: string;
	referrerPolicy?: ReferrerPolicy;
	integrity?: string;
	keepalive?: boolean;
	signal?: AbortSignal | null;
	cf?: Record<string, unknown>;
}

declare let Request: {
	prototype: Request;
	new (input: RequestInfo | URL, init?: RequestInit): Request;
};

interface Response {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly headers: Headers;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly bodyUsed: boolean;
	json<T = unknown>(): Promise<T>;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	formData(): Promise<FormData>;
	blob(): Promise<Blob>;
	clone(): Response;
}

interface ResponseInit {
	status?: number;
	statusText?: string;
	headers?: HeadersInit;
}

declare let Response: {
	prototype: Response;
	new (body?: BodyInit | null, init?: ResponseInit): Response;
	json(data: unknown, init?: ResponseInit): Response;
	redirect(url: string | URL, status?: number): Response;
	error(): Response;
};

interface URL {
	hash: string;
	host: string;
	hostname: string;
	href: string;
	readonly origin: string;
	password: string;
	pathname: string;
	port: string;
	protocol: string;
	search: string;
	readonly searchParams: URLSearchParams;
	username: string;
	toString(): string;
	toJSON(): string;
}

declare let URL: {
	prototype: URL;
	new (url: string | URL, base?: string | URL): URL;
	canParse(url: string | URL, base?: string | URL): boolean;
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
};

interface Headers {
	append(name: string, value: string): void;
	delete(name: string): void;
	get(name: string): string | null;
	has(name: string): boolean;
	set(name: string, value: string): void;
	forEach(
		callbackfn: (value: string, key: string, parent: Headers) => void,
		thisArg?: unknown,
	): void;
	entries(): IterableIterator<[string, string]>;
	keys(): IterableIterator<string>;
	values(): IterableIterator<string>;
	[Symbol.iterator](): IterableIterator<[string, string]>;
}

type HeadersInit = Headers | Record<string, string> | [string, string][];

declare let Headers: {
	prototype: Headers;
	new (init?: HeadersInit): Headers;
};

interface TextEncoder {
	readonly encoding: string;
	encode(input?: string): Uint8Array;
	encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

declare let TextEncoder: {
	prototype: TextEncoder;
	new (): TextEncoder;
};

interface TextDecoderOptions {
	fatal?: boolean;
	ignoreBOM?: boolean;
}

interface TextDecoder {
	readonly encoding: string;
	readonly fatal: boolean;
	readonly ignoreBOM: boolean;
	decode(input?: BufferSource, options?: { stream?: boolean }): string;
}

declare let TextDecoder: {
	prototype: TextDecoder;
	new (label?: string, options?: TextDecoderOptions): TextDecoder;
};

interface Console {
	log(...data: unknown[]): void;
	error(...data: unknown[]): void;
	warn(...data: unknown[]): void;
	info(...data: unknown[]): void;
	debug(...data: unknown[]): void;
	trace(...data: unknown[]): void;
}

declare let console: Console;
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
declare function setTimeout(
	callback: (...args: unknown[]) => void,
	ms?: number,
	...args: unknown[]
): number;
declare function clearTimeout(id: number): void;

type RequestInfo = Request | string;
type BodyInit =
	| ReadableStream<Uint8Array>
	| string
	| ArrayBuffer
	| ArrayBufferView
	| FormData
	| URLSearchParams
	| Blob;
type RequestMode = "cors" | "navigate" | "no-cors" | "same-origin";
type RequestCredentials = "include" | "omit" | "same-origin";
type RequestCache =
	| "default"
	| "force-cache"
	| "no-cache"
	| "no-store"
	| "only-if-cached"
	| "reload";
type RequestRedirect = "error" | "follow" | "manual";
type ReferrerPolicy =
	| ""
	| "no-referrer"
	| "no-referrer-when-downgrade"
	| "origin"
	| "origin-when-cross-origin"
	| "same-origin"
	| "strict-origin"
	| "strict-origin-when-cross-origin"
	| "unsafe-url";

// Cloudflare Workers types

/**
 * R2 Bucket interface
 */
interface R2Bucket {
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
	put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
		options?: R2PutOptions,
	): Promise<R2Object | null>;
	delete(key: string | string[]): Promise<void>;
	list(options?: R2ListOptions): Promise<R2Objects>;
	head(key: string): Promise<R2Object | null>;
}

interface R2GetOptions {
	onlyIf?: R2Conditional;
	range?: R2Range;
	version?: string;
}

interface R2PutOptions {
	httpMetadata?: R2HTTPMetadata;
	customMetadata?: Record<string, string>;
	md5?: ArrayBuffer | string;
	sha1?: ArrayBuffer | string;
	sha256?: ArrayBuffer | string;
	sha384?: ArrayBuffer | string;
	sha512?: ArrayBuffer | string;
	storageClass?: string;
}

interface R2ListOptions {
	prefix?: string;
	delimiter?: string;
	cursor?: string;
	limit?: number;
	include?: string[];
}

interface R2Conditional {
	etagMatches?: string;
	etagDoesNotMatch?: string;
	uploadedBefore?: Date;
	uploadedAfter?: Date;
}

interface R2Range {
	offset?: number;
	length?: number;
	suffix?: number;
}

interface R2HTTPMetadata {
	contentType?: string;
	contentLanguage?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	cacheExpiry?: Date;
}

interface R2Object {
	key: string;
	version: string;
	size: number;
	etag: string;
	httpEtag: string;
	checksums: R2Checksums;
	uploaded: Date;
	httpMetadata?: R2HTTPMetadata;
	customMetadata?: Record<string, string>;
	storageClass: string;
}

interface R2ObjectBody extends R2Object {
	body: ReadableStream;
	bodyUsed: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	blob(): Promise<Blob>;
}

interface R2Checksums {
	md5?: ArrayBuffer;
	sha1?: ArrayBuffer;
	sha256?: ArrayBuffer;
	sha384?: ArrayBuffer;
	sha512?: ArrayBuffer;
}

interface R2Objects {
	objects: R2Object[];
	truncated: boolean;
	cursor?: string;
	delimitedPrefixes: string[];
}

/**
 * Workers AI interface
 */
interface Ai {
	run<T = unknown>(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<T>;
}

interface AiOptions {
	gateway?: {
		id: string;
		skipCache?: boolean;
		cacheTtl?: number;
	};
}

/**
 * Durable Object types
 */
interface DurableObjectNamespace<T = unknown> {
	idFromName(name: string): DurableObjectId;
	idFromString(id: string): DurableObjectId;
	newUniqueId(options?: { jurisdiction?: string }): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub<T>;
}

interface DurableObjectId {
	toString(): string;
	equals(other: DurableObjectId): boolean;
}

interface DurableObjectStub<T = unknown> {
	id: DurableObjectId;
	name?: string;
	fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectState {
	id: DurableObjectId;
	storage: DurableObjectStorage;
	waitUntil(promise: Promise<unknown>): void;
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectStorage {
	get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
	get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
	put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
	put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
	delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
	delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
	deleteAll(options?: DurableObjectPutOptions): Promise<void>;
	list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
	sql: SqlStorage;
}

interface SqlStorage {
	exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

interface SqlStorageCursor<T = Record<string, unknown>> extends Iterable<T> {
	[Symbol.iterator](): IterableIterator<T>;
	toArray(): T[];
	one(): T | null;
	raw<R extends unknown[] = unknown[]>(): IterableIterator<R>;
	columnNames: string[];
	rowsRead: number;
	rowsWritten: number;
}

interface DurableObjectGetOptions {
	allowConcurrency?: boolean;
	noCache?: boolean;
}

interface DurableObjectPutOptions {
	allowConcurrency?: boolean;
	allowUnconfirmed?: boolean;
	noCache?: boolean;
}

interface DurableObjectListOptions {
	start?: string;
	startAfter?: string;
	end?: string;
	prefix?: string;
	reverse?: boolean;
	limit?: number;
	allowConcurrency?: boolean;
	noCache?: boolean;
}

/**
 * ExecutionContext
 */
interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

/**
 * ScheduledEvent for cron triggers
 */
interface ScheduledEvent {
	scheduledTime: number;
	cron: string;
	noRetry(): void;
}

/**
 * DurableObject base class
 */
declare abstract class DurableObject<Env = unknown> {
	protected ctx: DurableObjectState;
	protected env: Env;
	constructor(ctx: DurableObjectState, env: Env);
	fetch?(request: Request): Promise<Response>;
	alarm?(): Promise<void>;
	webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): Promise<void> | void;
	webSocketClose?(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void> | void;
	webSocketError?(ws: WebSocket, error: unknown): Promise<void> | void;
}

// URLSearchParams
interface URLSearchParams {
	append(name: string, value: string): void;
	delete(name: string): void;
	get(name: string): string | null;
	getAll(name: string): string[];
	has(name: string): boolean;
	set(name: string, value: string): void;
	sort(): void;
	toString(): string;
	forEach(
		callbackfn: (value: string, key: string, parent: URLSearchParams) => void,
		thisArg?: unknown,
	): void;
	entries(): IterableIterator<[string, string]>;
	keys(): IterableIterator<string>;
	values(): IterableIterator<string>;
	[Symbol.iterator](): IterableIterator<[string, string]>;
}

/**
 * cloudflare:workers module declaration
 * This module is provided by the Cloudflare Workers runtime
 */
declare module "cloudflare:workers" {
	export { DurableObject };
}

// Node.js types for tests
declare namespace NodeJS {
	interface ProcessEnv {
		[key: string]: string | undefined;
	}

	interface Process {
		env: ProcessEnv;
	}
}

declare let process: NodeJS.Process;

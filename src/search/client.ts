import type { Env } from "../types";
import type { MemoryIndexRpc } from "./durable-object";

/**
 * Resolve the singleton `MemoryIndex` Durable Object stub.
 *
 * All callers in this Worker share a single DO instance named "default", so
 * centralising the lookup avoids the `idFromName("default")` / `.get()`
 * boilerplate from spreading across tool handlers.
 *
 * Returns the stub typed as `MemoryIndexRpc` rather than the SDK's
 * `DurableObjectStub<MemoryIndex>`. The SDK type technically supports RPC
 * through its `Fetcher` generic, but the method shapes don't surface
 * cleanly without branding the class — an explicit interface keeps call
 * sites well-typed without that ceremony.
 */
export function getMemoryIndex(env: Env): MemoryIndexRpc {
	const stub = env.MEMORY_INDEX.get(env.MEMORY_INDEX.idFromName("default"));
	return stub as unknown as MemoryIndexRpc;
}

/**
 * Resolve the `MemoryIndex` Durable Object holding conversation exchanges.
 *
 * Same class as the memory index, different instance — so a separate SQLite
 * database and a separate HNSW graph.
 *
 * The split is deliberate. Exchanges outnumber memory files by an order of
 * magnitude (hundreds of sessions, each with several exchanges, against ~200
 * curated files). Sharing one graph meant `search` had to pull `limit`
 * candidates and then discard whichever ones came from the wrong namespace,
 * so a query against memory could come back nearly empty purely because
 * conversation vectors won the top slots. Two graphs make that starvation
 * impossible: each scope searches only its own, and neither can crowd out the
 * other however lopsided the volumes get.
 */
export function getConversationIndex(env: Env): MemoryIndexRpc {
	const stub = env.MEMORY_INDEX.get(env.MEMORY_INDEX.idFromName("conversations"));
	return stub as unknown as MemoryIndexRpc;
}

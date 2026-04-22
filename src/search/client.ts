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

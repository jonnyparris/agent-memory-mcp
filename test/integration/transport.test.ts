import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The server is stateless. A GET that returns an event stream which closes
// at once makes the MCP TS client reconnect every second for as long as it
// stays open (765K requests in a month). GET and DELETE must answer 405 so
// clients never open the standalone stream.
describe("MCP transport", () => {
	const auth = `Bearer ${env.MEMORY_AUTH_TOKEN}`;

	for (const method of ["GET", "DELETE"]) {
		it(`answers ${method} /mcp with 405`, async () => {
			const res = await SELF.fetch("http://localhost/mcp", {
				method,
				headers: { Authorization: auth, Accept: "text/event-stream" },
			});
			expect(res.status).toBe(405);
			expect(res.headers.get("Allow")).toBe("POST");
			expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
		});
	}

	it("still serves POST /mcp", async () => {
		const res = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: auth,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { tools: unknown[] } };
		expect(body.result.tools.length).toBeGreaterThan(0);
	});
});

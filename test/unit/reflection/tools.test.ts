import { describe, expect, it } from "vitest";
import { QUICK_SCAN_TOOLS, REFLECTION_TOOLS } from "../../../src/reflection/tools";

describe("REFLECTION_TOOLS", () => {
	it("should have valid tool definitions", () => {
		for (const tool of REFLECTION_TOOLS) {
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.parameters.type).toBe("object");
			expect(tool.parameters.properties).toBeDefined();
		}
	});

	it("should have all required tools", () => {
		const toolNames = REFLECTION_TOOLS.map((t) => t.name);

		expect(toolNames).toContain("searchMemory");
		expect(toolNames).toContain("readFile");
		expect(toolNames).toContain("listFiles");
		expect(toolNames).toContain("proposeEdit");
		expect(toolNames).toContain("autoApply");
		expect(toolNames).toContain("finishReflection");
	});

	it("searchMemory should have required query parameter", () => {
		const tool = REFLECTION_TOOLS.find((t) => t.name === "searchMemory");
		expect(tool).toBeDefined();
		expect(tool?.parameters.required).toContain("query");
	});

	it("proposeEdit should have required path, action, and reason", () => {
		const tool = REFLECTION_TOOLS.find((t) => t.name === "proposeEdit");
		expect(tool).toBeDefined();
		expect(tool?.parameters.required).toContain("path");
		expect(tool?.parameters.required).toContain("action");
		expect(tool?.parameters.required).toContain("reason");
	});

	it("proposeEdit action should have valid enum values", () => {
		const tool = REFLECTION_TOOLS.find((t) => t.name === "proposeEdit");
		const actionProp = tool?.parameters.properties.action;
		expect(actionProp?.enum).toContain("replace");
		expect(actionProp?.enum).toContain("append");
		expect(actionProp?.enum).toContain("delete");
		expect(actionProp?.enum).toContain("create");
	});

	it("autoApply should have valid fixType enum", () => {
		const tool = REFLECTION_TOOLS.find((t) => t.name === "autoApply");
		const fixTypeProp = tool?.parameters.properties.fixType;
		expect(fixTypeProp?.enum).toContain("typo");
		expect(fixTypeProp?.enum).toContain("whitespace");
		expect(fixTypeProp?.enum).toContain("newline");
		expect(fixTypeProp?.enum).toContain("duplicate");
		expect(fixTypeProp?.enum).toContain("formatting");
	});

	it("finishReflection should require summary and counts", () => {
		const tool = REFLECTION_TOOLS.find((t) => t.name === "finishReflection");
		expect(tool?.parameters.required).toContain("summary");
		expect(tool?.parameters.required).toContain("proposedChanges");
		expect(tool?.parameters.required).toContain("autoApplied");
	});
});

describe("QUICK_SCAN_TOOLS", () => {
	it("should have valid tool definitions", () => {
		for (const tool of QUICK_SCAN_TOOLS) {
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.parameters.type).toBe("object");
		}
	});

	it("should have limited set of safe tools", () => {
		const toolNames = QUICK_SCAN_TOOLS.map((t) => t.name);

		// Should have these safe tools
		expect(toolNames).toContain("listFiles");
		expect(toolNames).toContain("readFile");
		expect(toolNames).toContain("autoApply");
		expect(toolNames).toContain("flagForDeepAnalysis");
		expect(toolNames).toContain("finishQuickScan");

		// Should NOT have proposeEdit or searchMemory (reserved for deep analysis)
		expect(toolNames).not.toContain("proposeEdit");
		expect(toolNames).not.toContain("searchMemory");
	});

	it("flagForDeepAnalysis should require path and issue", () => {
		const tool = QUICK_SCAN_TOOLS.find((t) => t.name === "flagForDeepAnalysis");
		expect(tool?.parameters.required).toContain("path");
		expect(tool?.parameters.required).toContain("issue");
	});

	it("finishQuickScan should require counts", () => {
		const tool = QUICK_SCAN_TOOLS.find((t) => t.name === "finishQuickScan");
		expect(tool?.parameters.required).toContain("autoApplied");
		expect(tool?.parameters.required).toContain("flaggedForDeepAnalysis");
	});
});

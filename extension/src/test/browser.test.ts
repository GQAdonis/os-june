import { describe, expect, it } from "vitest";
import { browserFailureResponse, chunkBytes, TaskTabRegistry } from "../browser";

describe("task tab registry", () => {
  it("refuses tabs outside the broker session", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.add("session-a", 10);
    expect(() => registry.tab("session-a", 11)).toThrow(/not owned/);
    expect(() => registry.tab("session-b", 10)).toThrow(/not found/);
  });

  it("expires snapshot refs on navigation or mutation", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.add("session-a", 10);
    expect(registry.setRefs("session-a", 10, 0, ["e0:n20"])).toBe(true);
    expect(registry.acceptsRef("session-a", 10, "e0:n20")).toBe(true);
    expect(registry.invalidate("session-a", 10)).toBe(1);
    expect(registry.acceptsRef("session-a", 10, "e0:n20")).toBe(false);
    expect(registry.setRefs("session-a", 10, 0, ["e0:n20"])).toBe(false);
  });

  it("plans disconnect cleanup using owned tabs only", () => {
    const registry = new TaskTabRegistry();
    registry.start("one");
    registry.start("two");
    registry.add("one", 1);
    registry.add("two", 2);
    expect(registry.cleanupPlan().sort()).toEqual([1, 2]);
  });

  it("forgets an empty tab group so a later task tab can create a new one", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.add("session-a", 10);
    registry.session("session-a").groupId = 42;
    registry.removeTab("session-a", 10);
    expect(registry.session("session-a").groupId).toBeUndefined();
  });
});

describe("native payload chunking", () => {
  it("keeps chunks well below the native frame limit and roundtrips bytes", () => {
    const input = Uint8Array.from({ length: 700_000 }, (_, index) => index % 251);
    const chunks = chunkBytes(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(512 * 1024);
    const output = chunks.flatMap((chunk) => [
      ...Uint8Array.from(atob(chunk), (value) => value.charCodeAt(0)),
    ]);
    expect(Uint8Array.from(output)).toEqual(input);
  });
});

describe("browser error redaction", () => {
  it("omits browser content from protocol failures", () => {
    const error = Object.assign(
      new Error(
        "Page text from https://private.example/secret with screenshot bytes and field-value-123",
      ),
      { code: "https://private.example/secret" },
    );
    const response = browserFailureResponse(
      {
        v: 2,
        type: "request",
        id: 9,
        tool: "navigate",
        arguments: {
          session_id: "session-123",
          tab_id: 42,
          url: "https://private.example/secret",
          text: "field-value-123",
        },
      },
      error,
    );

    expect(response.errorCode).toBe("extension_request_failed");
    expect(response.message).toContain("navigate");
    expect(response.message).toContain("session-123");
    expect(response.message).toContain("tab 42");
    expect(response.message).not.toContain("private.example");
    expect(response.message).not.toContain("Page text");
    expect(response.message).not.toContain("screenshot bytes");
    expect(response.message).not.toContain("field-value-123");
  });
});

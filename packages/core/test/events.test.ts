import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../src/events.js";
import { testDatabase } from "./test-database.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-event-hub-"));
  temporary.push(root);
  const database = testDatabase(root);
  const session = database.createSession({
    title: "events",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
  });
  return { database, session, hub: new EventHub(database) };
}

describe("EventHub", () => {
  it("requires a transaction and broadcasts committed nested events", async () => {
    const { database, session, hub } = await fixture();
    expect(() => hub.emit(session.id, undefined, "session.snapshot", {})).toThrow("inside");
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    hub.subscribe(() => {
      throw new Error("consumer failure");
    });

    const result = hub.transaction(() =>
      hub.transaction(() => {
        const event = hub.emit(session.id, undefined, "session.snapshot", { committed: true });
        expect(listener).not.toHaveBeenCalled();
        return event.sequence;
      }),
    );
    expect(result).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(database.listEvents(session.id, 0).events).toHaveLength(1);
    unsubscribe();
    hub.transaction(() => hub.emit(session.id, undefined, "session.snapshot", { ignored: true }));
    expect(listener).toHaveBeenCalledOnce();
    database.close();
  });

  it("does not broadcast or persist rolled-back events", async () => {
    const { database, session, hub } = await fixture();
    const listener = vi.fn();
    hub.subscribe(listener);
    expect(() =>
      hub.transaction(() => {
        hub.emit(session.id, undefined, "session.snapshot", { partial: true });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(listener).not.toHaveBeenCalled();
    expect(database.listEvents(session.id, 0).events).toHaveLength(0);
    database.close();
  });

  it("requires transactions for resource invalidation and broadcasts each committed resource once", async () => {
    const { database, hub } = await fixture();
    expect(() => hub.invalidate("tasks")).toThrow("inside");

    const listener = vi.fn();
    const unsubscribe = hub.subscribeResources(listener);
    hub.subscribeResources(() => {
      throw new Error("consumer failure");
    });

    hub.transaction(() => {
      hub.invalidate("tasks");
      hub.transaction(() => {
        hub.invalidate("tasks");
        hub.invalidate("memory");
      });
      expect(listener).not.toHaveBeenCalled();
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "resource.invalidated",
        protocolVersion: 13,
        resource: "tasks",
      }),
    );
    expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({ resource: "memory" }));

    unsubscribe();
    hub.transaction(() => hub.invalidate("knowledge"));
    expect(listener).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("does not broadcast rolled-back resource invalidations", async () => {
    const { database, hub } = await fixture();
    const listener = vi.fn();
    hub.subscribeResources(listener);

    expect(() =>
      hub.transaction(() => {
        hub.invalidate("schedules");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(listener).not.toHaveBeenCalled();
    database.close();
  });
});

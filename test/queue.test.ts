import { describe, expect, it } from "vitest";
import { createSingleFlightQueue } from "../src/queue.js";

describe("createSingleFlightQueue", () => {
  it("runs tasks strictly one at a time in FIFO order", async () => {
    const queue = createSingleFlightQueue();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const first = queue.enqueue(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("first");
      active -= 1;
      return "first-done";
    });
    const second = queue.enqueue(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push("second");
      active -= 1;
      return "second-done";
    });

    expect(events).toEqual([]);
    expect(await first).toBe("first-done");
    expect(await second).toBe("second-done");
    expect(events).toEqual(["first", "second"]);
    expect(maxActive).toBe(1);
  });

  it("reports the enqueue-to-turn wait time for each task", async () => {
    const queue = createSingleFlightQueue();
    let waitedMs = 0;
    const first = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "first";
    });
    const second = queue.enqueue(async (waited) => {
      waitedMs = waited;
      return "done";
    });
    expect(await first).toBe("first");
    expect(await second).toBe("done");
    expect(waitedMs).toBeGreaterThan(0);
  });

  it("keeps the FIFO chain usable after a rejected task", async () => {
    const queue = createSingleFlightQueue();
    const failing = queue.enqueue(async () => {
      throw new Error("task failed");
    });
    const result = queue.enqueue(async () => "after-failure");
    await expect(failing).rejects.toThrow("task failed");
    expect(await result).toBe("after-failure");
  });
});

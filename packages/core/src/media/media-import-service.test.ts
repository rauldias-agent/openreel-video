import { describe, expect, it, vi } from "vitest";

import { MediaImportService } from "./media-import-service";
import type { MediaImportResult } from "./types";

/**
 * importMultiple() has no production callers yet, so these tests pin the
 * contract rather than any UI behaviour: order preservation, the concurrency
 * ceiling, and what onProgress is allowed to report.
 */

function fakeFiles(count: number): File[] {
  return Array.from(
    { length: count },
    (_, i) => new File([new Uint8Array(1)], `clip-${i}.mov`, { type: "video/quicktime" }),
  );
}

/** Each stubbed result carries its file name in `warnings` so order is observable. */
function nameOf(result: MediaImportResult): string | undefined {
  return result.warnings?.[0];
}

/** Builds a service whose importMedia is replaced by a controllable stub. */
function serviceWithStub() {
  const service = new MediaImportService({} as never, {} as never);

  let current = 0;
  let peak = 0;

  const importMedia = vi.fn(async (file: File): Promise<MediaImportResult> => {
    current += 1;
    peak = Math.max(peak, current);
    // Yield so overlapping workers can actually be observed.
    await new Promise((resolve) => setTimeout(resolve, 1));
    current -= 1;
    return { success: true, warnings: [file.name] };
  });

  vi.spyOn(service, "importMedia").mockImplementation(importMedia);
  return { service, importMedia, peakInFlight: () => peak };
}

describe("MediaImportService.importMultiple", () => {
  it("returns results in the order of the input files", async () => {
    const { service } = serviceWithStub();
    const files = fakeFiles(12);

    const results = await service.importMultiple(files);

    expect(results).toHaveLength(files.length);
    expect(results.map(nameOf)).toEqual(files.map((f) => f.name));
  });

  it("never exceeds the configured concurrency", async () => {
    const { service, peakInFlight } = serviceWithStub();

    await service.importMultiple(fakeFiles(20), { concurrency: 3 });

    expect(peakInFlight()).toBeLessThanOrEqual(3);
  });

  it("runs at most one file when concurrency is one", async () => {
    const { service, peakInFlight } = serviceWithStub();

    await service.importMultiple(fakeFiles(6), { concurrency: 1 });

    expect(peakInFlight()).toBe(1);
  });

  it("clamps a nonsensical concurrency instead of stalling", async () => {
    const { service, importMedia } = serviceWithStub();

    const results = await service.importMultiple(fakeFiles(4), { concurrency: 0 });

    expect(importMedia).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(4);
  });

  it("does not start more workers than there are files", async () => {
    const { service, peakInFlight } = serviceWithStub();

    await service.importMultiple(fakeFiles(2), { concurrency: 16 });

    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it("reports completed counts that only ever move forward", async () => {
    const { service } = serviceWithStub();
    const files = fakeFiles(10);
    const seen: number[] = [];

    await service.importMultiple(files, { concurrency: 4 }, (completed, total) => {
      seen.push(completed);
      expect(total).toBe(files.length);
    });

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns an empty array for no files without calling importMedia", async () => {
    const { service, importMedia } = serviceWithStub();

    await expect(service.importMultiple([])).resolves.toEqual([]);
    expect(importMedia).not.toHaveBeenCalled();
  });
});
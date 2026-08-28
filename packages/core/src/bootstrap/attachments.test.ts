import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAttachments } from "./attachments.js";

const okResponse = (data: string) =>
  new Response(new Blob([data]), { status: 200 });

describe("downloadAttachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dispatches all downloads in parallel, not one at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    // fetch never settles on its own — we control it. A sequential loop would
    // only have issued the FIRST fetch while waiting; parallel issues all three.
    const releases: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(
      (url: string) => new Promise<Response>((resolve) => releases.push(() => resolve(okResponse(`body:${url}`)))),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const pending = downloadAttachments(
        [
          { filename: "a.txt", content_type: "text/plain", url: "https://s3/a" },
          { filename: "b.txt", content_type: "text/plain", url: "https://s3/b" },
          { filename: "c.txt", content_type: "text/plain", url: "https://s3/c" },
        ],
        dir,
      );

      // Let mkdir + the synchronous fan-out of fetch() calls flush.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      releases.forEach((release) => release());
      await pending;

      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("body:https://s3/a");
      expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("body:https://s3/c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects (fails boot) when any single download fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(url.endsWith("bad") ? new Response(null, { status: 500 }) : okResponse("ok")),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        downloadAttachments(
          [
            { filename: "good.txt", content_type: "text/plain", url: "https://s3/good" },
            { filename: "boom.txt", content_type: "text/plain", url: "https://s3/bad" },
          ],
          dir,
        ),
      ).rejects.toThrow(/download failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

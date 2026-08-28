import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "../log.js";
import type { AttachmentSpec } from "../manifest/types.js";

/** Download one attachment to `dest`. Uses the Node global fetch (Node >= 18). */
export async function downloadAttachment(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

/** Download every attachment into `dir`, in parallel, sanitising filenames to
 *  basenames so a crafted name cannot escape the attachments directory.
 *
 *  Concurrent rather than sequential: the set is small (throngx caps a task at
 *  10 attachments) so unbounded fan-out needs no pool, and wall-clock is the
 *  slowest single download instead of their sum. `Promise.all` still fails loud
 *  — the first rejection rejects the whole call, which boot turns into a
 *  `StepError("attachments")`. */
export async function downloadAttachments(attachments: AttachmentSpec[], dir: string): Promise<void> {
  if (attachments.length === 0) return;
  await mkdir(dir, { recursive: true });
  await Promise.all(
    attachments.map((att) => {
      const name = basename(att.filename);
      const dest = join(dir, name);
      log.info("downloading attachment", { name, dest });
      return downloadAttachment(att.url, dest);
    }),
  );
}

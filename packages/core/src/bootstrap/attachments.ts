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

/** Download every attachment into `dir`, sanitising filenames to basenames so a
 *  crafted name cannot escape the attachments directory. */
export async function downloadAttachments(attachments: AttachmentSpec[], dir: string): Promise<void> {
  if (attachments.length === 0) return;
  await mkdir(dir, { recursive: true });
  for (const att of attachments) {
    const name = basename(att.filename);
    const dest = join(dir, name);
    log.info("downloading attachment", { name, dest });
    await downloadAttachment(att.url, dest);
  }
}

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";

export type FrameDirection = "client_to_agent" | "agent_to_client";

export type RecordedFrame = {
  timestamp: string;
  direction: FrameDirection;
  seq: number;
  payload: unknown;
  raw: string;
};

export class ProtocolRecorder {
  private seq = 0;
  private readonly frames: RecordedFrame[] = [];
  private readonly ndjson;

  constructor(ndjsonPath: string) {
    mkdirSync(dirname(ndjsonPath), { recursive: true });
    this.ndjson = createWriteStream(ndjsonPath, { encoding: "utf8" });
  }

  record(direction: FrameDirection, raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;
    let payload: unknown = line;
    try {
      payload = JSON.parse(line);
    } catch {
      payload = { unparsed: line };
    }
    const frame: RecordedFrame = {
      timestamp: new Date().toISOString(),
      direction,
      seq: ++this.seq,
      payload,
      raw: line,
    };
    this.frames.push(frame);
    this.ndjson.write(`${JSON.stringify(frame)}\n`);
  }

  tapWritable(writable: Writable): void {
    const originalWrite = writable.write.bind(writable);
    writable.write = ((
      chunk: string | Buffer,
      encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
      callback?: (error: Error | null | undefined) => void,
    ) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : Buffer.from(chunk).toString("utf8");
      for (const line of text.split(/\n/)) this.record("client_to_agent", line);
      if (typeof encoding === "function") {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk, encoding, callback);
    }) as Writable["write"];
  }

  tapReadable(readable: Readable): Transform {
    let buffer = "";
    const recorder = this;
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        const text = chunk.toString("utf8");
        buffer += text;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          recorder.record("agent_to_client", buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
        callback(null, chunk);
      },
      flush(callback) {
        if (buffer.trim()) recorder.record("agent_to_client", buffer);
        callback();
      },
    });
    readable.pipe(tap);
    return tap;
  }

  async close(): Promise<RecordedFrame[]> {
    await new Promise<void>((resolve, reject) => {
      this.ndjson.end((error) => (error ? reject(error) : resolve()));
    });
    return this.frames;
  }
}

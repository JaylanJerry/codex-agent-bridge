process.stderr.write("noise".repeat(8_000));
process.stdin.resume();
setInterval(() => undefined, 1 << 30);

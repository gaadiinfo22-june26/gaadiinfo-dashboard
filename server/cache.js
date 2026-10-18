/**
 * Small JSON file cache under CACHE_DIR (git-ignored). Holds conversations,
 * contacts and AI summaries so the same Zoho / Claude calls aren't repeated.
 * It contains customer data: keep CACHE_DIR on the machine running the server.
 */
const fs = require('fs');
const path = require('path');

function createCache(dir) {
  function file(bucket, key) {
    if (!/^[a-z-]+$/.test(bucket) || !/^[\w-]+$/.test(String(key))) throw new Error('Invalid cache key');
    return path.join(dir, bucket, `${key}.json`);
  }
  return {
    dir,
    read(bucket, key) {
      try { return JSON.parse(fs.readFileSync(file(bucket, key), 'utf8')); } catch (e) { return null; }
    },
    write(bucket, key, value) {
      const f = file(bucket, key);
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
  };
}

module.exports = { createCache };

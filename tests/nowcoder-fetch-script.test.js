import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArticleStore } from "../src/storage/articleStore.js";
import { FEED_QUERY_SENTINEL } from "../src/sources/nowcoderAdapter.js";
import {
  DEFAULT_JOB,
  NOWCODER_EXPERIENCE_JOBS,
  parseArgs,
  runFetchArticles
} from "../scripts/nowcoderFetchArticles.js";

async function tempDir() {
  return await mkdtemp(join(tmpdir(), "itw-nowcoder-script-"));
}

function record(url, title, query = FEED_QUERY_SENTINEL) {
  return {
    source: "nowcoder",
    sourceUrl: url,
    query,
    title,
    text: `${title} 正文 问了 MySQL 索引和事务。`,
    fetchedAt: "2026-05-05T10:00:00.000Z",
    rawMetadata: {}
  };
}

test("parseArgs defaults to latest feed without requiring a count", () => {
  const options = parseArgs([]);
  assert.equal(options.query, "");
  assert.equal(options.job, DEFAULT_JOB);
  assert.equal(options.dataDir, "data");
  assert.equal(options.targetNew, 5);
  assert.equal(options.ttlDays, 14);
});

test("parseArgs accepts a job filter for future feed variants", () => {
  const options = parseArgs(["--job", "后端开发"]);
  assert.equal(options.job, "后端开发");
});

test("runFetchArticles saves feed records and skips them on the next run", async () => {
  const dir = await tempDir();
  const store = createArticleStore({ baseDir: dir });
  const calls = [];
  const adapter = {
    async searchAndFetch({ query, maxArticles, excludeUrls }) {
      calls.push({ query, maxArticles, excludeUrls });
      const all = [
        { url: "https://www.nowcoder.com/discuss/1", title: "字节后端一面" },
        { url: "https://www.nowcoder.com/discuss/2", title: "美团 Java 二面" },
        { url: "https://www.nowcoder.com/discuss/3", title: "腾讯 CSIG 后台开发 一面" }
      ];
      const fresh = all.filter((c) => !excludeUrls.includes(c.url)).slice(0, maxArticles);
      return {
        mode: "feed",
        entryUrl: NOWCODER_EXPERIENCE_JOBS[DEFAULT_JOB],
        candidates: fresh,
        skipped: all.filter((c) => excludeUrls.includes(c.url)).map((c) => c.url),
        records: fresh.map((c) => record(c.url, c.title))
      };
    }
  };

  const first = await runFetchArticles({
    articleStore: store,
    adapter,
    targetNew: 2,
    now: () => "2026-05-05T10:00:00.000Z"
  });
  assert.equal(first.partitionQuery, FEED_QUERY_SENTINEL);
  assert.equal(first.job, DEFAULT_JOB);
  assert.equal(first.feedUrl, NOWCODER_EXPERIENCE_JOBS[DEFAULT_JOB]);
  assert.equal(first.savedCount, 2);
  assert.equal(first.skippedOldCount, 0);

  const second = await runFetchArticles({
    articleStore: store,
    adapter,
    targetNew: 2,
    now: () => "2026-05-05T10:10:00.000Z"
  });
  assert.equal(second.savedCount, 1);
  assert.equal(second.skippedOldCount, 2);
  assert.deepEqual(calls[1].excludeUrls, [
    "https://www.nowcoder.com/discuss/1",
    "https://www.nowcoder.com/discuss/2"
  ]);

  const saved = await store.listByQuery(FEED_QUERY_SENTINEL);
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.map((a) => a.sourceUrl), [
    "https://www.nowcoder.com/discuss/1",
    "https://www.nowcoder.com/discuss/2",
    "https://www.nowcoder.com/discuss/3"
  ]);
});

test("runFetchArticles advances a cursor so the next run continues after the previous batch", async () => {
  const dir = await tempDir();
  const store = createArticleStore({ baseDir: dir });
  const calls = [];
  const adapter = {
    async searchAndFetch({ query, maxArticles, excludeUrls, offset }) {
      calls.push({ query, maxArticles, excludeUrls, offset });
      const all = [
        { url: "https://www.nowcoder.com/discuss/1", title: "后端一面 1" },
        { url: "https://www.nowcoder.com/discuss/2", title: "后端一面 2" },
        { url: "https://www.nowcoder.com/discuss/3", title: "后端一面 3" },
        { url: "https://www.nowcoder.com/discuss/4", title: "后端一面 4" }
      ];
      const fresh = all.slice(offset).filter((c) => !excludeUrls.includes(c.url)).slice(0, maxArticles);
      return {
        mode: "feed",
        entryUrl: NOWCODER_EXPERIENCE_JOBS[DEFAULT_JOB],
        offset,
        nextOffset: offset + fresh.length,
        candidates: fresh,
        skipped: all.filter((c) => excludeUrls.includes(c.url)).map((c) => c.url),
        records: fresh.map((c) => record(c.url, c.title))
      };
    }
  };

  const first = await runFetchArticles({
    dataDir: dir,
    articleStore: store,
    adapter,
    targetNew: 2
  });
  const second = await runFetchArticles({
    dataDir: dir,
    articleStore: store,
    adapter,
    targetNew: 2
  });

  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 2);
  assert.equal(second.offset, 2);
  assert.equal(second.nextOffset, 4);
  assert.deepEqual(second.savedArticles.map((a) => a.sourceUrl), [
    "https://www.nowcoder.com/discuss/3",
    "https://www.nowcoder.com/discuss/4"
  ]);
  assert.equal(calls[0].offset, 0);
  assert.equal(calls[1].offset, 2);
});

test("runFetchArticles dry-run does not advance the cursor", async () => {
  const dir = await tempDir();
  const store = createArticleStore({ baseDir: dir });
  const adapter = {
    async searchAndFetch({ offset }) {
      return {
        mode: "feed",
        entryUrl: NOWCODER_EXPERIENCE_JOBS[DEFAULT_JOB],
        offset,
        nextOffset: offset + 1,
        candidates: [{ url: "https://www.nowcoder.com/discuss/1", title: "后端一面" }],
        skipped: [],
        records: [record("https://www.nowcoder.com/discuss/1", "后端一面")]
      };
    }
  };

  const first = await runFetchArticles({
    dataDir: dir,
    articleStore: store,
    adapter,
    dryRun: true
  });
  const second = await runFetchArticles({
    dataDir: dir,
    articleStore: store,
    adapter,
    dryRun: true
  });

  assert.equal(first.offset, 0);
  assert.equal(second.offset, 0);
});

test("runFetchArticles dry-run reports candidates without writing records", async () => {
  const dir = await tempDir();
  const store = createArticleStore({ baseDir: dir });
  const adapter = {
    async searchAndFetch() {
      return {
        mode: "search",
        entryUrl: "https://www.nowcoder.com/search/all?query=mysql",
        candidates: [{ url: "https://www.nowcoder.com/discuss/9", title: "MySQL 面经" }],
        skipped: [],
        records: [record("https://www.nowcoder.com/discuss/9", "MySQL 面经", "mysql")]
      };
    }
  };

  const summary = await runFetchArticles({
    query: "mysql",
    articleStore: store,
    adapter,
    dryRun: true
  });
  assert.equal(summary.savedCount, 1);
  assert.equal(summary.dryRun, true);
  assert.equal((await store.listByQuery("mysql")).length, 0);
});

test("runFetchArticles reports network failures without throwing", async () => {
  const dir = await tempDir();
  const store = createArticleStore({ baseDir: dir });
  const timeout = new Error("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT"
    })
  });
  const adapter = {
    async searchAndFetch() {
      throw timeout;
    }
  };

  const summary = await runFetchArticles({
    articleStore: store,
    adapter
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.mode, "feed");
  assert.equal(summary.savedCount, 0);
  assert.equal(summary.error.code, "UND_ERR_CONNECT_TIMEOUT");
  assert.match(summary.error.hint, /连接牛客超时/);
});

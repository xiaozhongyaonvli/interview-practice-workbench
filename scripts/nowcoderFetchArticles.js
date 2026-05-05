import { createArticleStore } from "../src/storage/articleStore.js";
import { createCrawlCursorStore } from "../src/storage/crawlCursorStore.js";
import {
  createNowCoderAdapter,
  FEED_QUERY_SENTINEL
} from "../src/sources/nowcoderAdapter.js";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET_NEW = 5;
const DEFAULT_TTL_DAYS = 14;
export const DEFAULT_JOB = "后端开发";
export const NOWCODER_EXPERIENCE_JOBS = Object.freeze({
  后端开发: "https://www.nowcoder.com/discuss/experience?tagId=639"
});

function feedUrlForJob(job) {
  return NOWCODER_EXPERIENCE_JOBS[job] ?? NOWCODER_EXPERIENCE_JOBS[DEFAULT_JOB];
}

function nowIso() {
  return new Date().toISOString();
}

function randomSuffix() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function idSlug(query) {
  return query === "" ? "feed" : query.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 32);
}

function generateArticleId(query) {
  return `nowcoder-${idSlug(query)}-${Date.now().toString(36)}-${randomSuffix()}`;
}

function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function describeError(err) {
  const cause = err?.cause;
  const code = err?.code ?? cause?.code ?? "FETCH_FAILED";
  const message = err?.message ?? String(err);
  const causeMessage = cause?.message ?? null;
  return {
    code,
    message,
    cause: causeMessage,
    hint:
      code === "UND_ERR_CONNECT_TIMEOUT"
        ? "连接牛客超时。请确认本机网络、代理或 DNS 后重试。"
        : "抓取失败。可先用 --dry-run --debug 查看入口和已有去重记录。"
  };
}

export function parseArgs(argv) {
  const options = {
    query: "",
    job: DEFAULT_JOB,
    dataDir: "data",
    targetNew: DEFAULT_TARGET_NEW,
    ttlDays: DEFAULT_TTL_DAYS,
    dryRun: false,
    resetCursor: false,
    json: false,
    debug: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--query") {
      options.query = String(argv[++i] ?? "").trim();
    } else if (arg === "--job") {
      options.job = String(argv[++i] ?? "").trim() || DEFAULT_JOB;
    } else if (arg === "--data-dir") {
      options.dataDir = String(argv[++i] ?? "").trim() || "data";
    } else if (arg === "--target-new") {
      options.targetNew = parsePositiveInt(argv[++i], "--target-new");
    } else if (arg === "--ttl-days") {
      options.ttlDays = parsePositiveInt(argv[++i], "--ttl-days");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--reset-cursor") {
      options.resetCursor = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--debug") {
      options.debug = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function helpText() {
  return [
    "Usage: node scripts/nowcoderFetchArticles.js [options]",
    "",
    "Options:",
    "  --query <topic>       Optional direction. Empty means latest feed.",
    `  --job <name>          Job filter for latest feed. Default: ${DEFAULT_JOB}.`,
    "  --data-dir <dir>      Storage directory. Default: data",
    "  --target-new <n>      Debug knob: new articles to save from this run. Default: 5",
    "  --ttl-days <n>        Prune old nowcoder ArticleRecord rows. Default: 14",
    "  --dry-run             Fetch and show what would be saved, without writing JSONL.",
    "  --reset-cursor        Start this feed/job from the first fresh candidate again.",
    "  --debug               Print candidate URLs and titles.",
    "  --json                Print machine-readable JSON summary.",
    "  --help                Show this help."
  ].join("\n");
}

export async function runFetchArticles({
  query = "",
  job = DEFAULT_JOB,
  dataDir = "data",
  targetNew = DEFAULT_TARGET_NEW,
  ttlDays = DEFAULT_TTL_DAYS,
  dryRun = false,
  resetCursor = false,
  now = nowIso,
  articleStore = createArticleStore({ baseDir: dataDir }),
  cursorStore = createCrawlCursorStore({ baseDir: dataDir }),
  adapter = null
} = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  const normalizedJob = typeof job === "string" && job.trim() ? job.trim() : DEFAULT_JOB;
  const feedUrl = feedUrlForJob(normalizedJob);
  const effectiveAdapter = adapter ?? createNowCoderAdapter({ now, feedUrl });
  const partitionQuery = normalizedQuery === "" ? FEED_QUERY_SENTINEL : normalizedQuery;
  const cursorKey = normalizedQuery === "" ? `feed-${normalizedJob}` : `search-${normalizedQuery}`;

  let prunedArticles = 0;
  if (ttlDays > 0 && typeof articleStore.pruneOlderThan === "function") {
    const pruned = await articleStore.pruneOlderThan({
      days: ttlDays,
      source: "nowcoder"
    });
    prunedArticles = pruned?.removedCount ?? 0;
  }

  const existing = await articleStore.listByQuery(partitionQuery);
  const excludeUrls = existing
    .map((a) => a.sourceUrl)
    .filter((u) => typeof u === "string" && u.length > 0);

  let cursor = await cursorStore.get(cursorKey);
  if (resetCursor) {
    cursor = await cursorStore.set(cursorKey, { nextOffset: 0, updatedAt: now() });
  }
  const offset = cursor.nextOffset;

  let result;
  try {
    result = await effectiveAdapter.searchAndFetch({
      query: normalizedQuery,
      maxArticles: targetNew,
      offset,
      excludeUrls
    });
  } catch (err) {
    return {
      ok: false,
      mode: normalizedQuery === "" ? "feed" : "search",
      query: normalizedQuery,
      job: normalizedJob,
      partitionQuery,
      feedUrl,
      cursorKey,
      offset,
      nextOffset: offset,
      targetNew,
      dryRun,
      existingCount: existing.length,
      skippedOldCount: 0,
      skippedOldUrls: [],
      candidateCount: 0,
      candidates: [],
      fetchedRecordCount: 0,
      savedCount: 0,
      savedArticles: [],
      failed: [],
      prunedArticles,
      error: describeError(err)
    };
  }

  const savedArticles = [];
  const failed = [];
  for (const item of result.records ?? []) {
    if (item.__error) {
      failed.push({
        url: item.url,
        code: item.code ?? "NOWCODER_ARTICLE_FAILED",
        message: item.message ?? ""
      });
      continue;
    }
    const article = {
      id: generateArticleId(normalizedQuery),
      ...item,
      query: partitionQuery,
      fetchedAt: item.fetchedAt || now()
    };
    if (!dryRun) {
      await articleStore.append(article);
    }
    savedArticles.push(article);
  }

  const nextOffset = result.nextOffset ?? offset + (result.candidates ?? []).length;
  if (!dryRun) {
    await cursorStore.set(cursorKey, { nextOffset, updatedAt: now() });
  }

  return {
    ok: true,
    mode: result.mode ?? (normalizedQuery === "" ? "feed" : "search"),
    query: normalizedQuery,
    job: normalizedJob,
    partitionQuery,
    feedUrl,
    cursorKey,
    offset,
    nextOffset,
    entryUrl: result.entryUrl ?? result.searchUrl ?? null,
    targetNew,
    dryRun,
    existingCount: existing.length,
    skippedOldCount: (result.skipped ?? []).length,
    skippedOldUrls: result.skipped ?? [],
    candidateCount: (result.candidates ?? []).length,
    candidates: result.candidates ?? [],
    fetchedRecordCount: (result.records ?? []).filter((r) => !r.__error).length,
    savedCount: savedArticles.length,
    savedArticles,
    failed,
    prunedArticles
  };
}

function formatSummary(summary, { debug = false } = {}) {
  const lines = [
    `ok=${summary.ok}`,
    `mode=${summary.mode}`,
    `query=${summary.query || "(feed)"}`,
    `job=${summary.job}`,
    `partition=${summary.partitionQuery}`,
    `feedUrl=${summary.feedUrl}`,
    `cursorKey=${summary.cursorKey}`,
    `offset=${summary.offset}`,
    `nextOffset=${summary.nextOffset}${summary.dryRun ? " (not persisted)" : ""}`,
    `entry=${summary.entryUrl}`,
    `existing=${summary.existingCount}`,
    `skippedOld=${summary.skippedOldCount}`,
    `candidates=${summary.candidateCount}`,
    `saved=${summary.savedCount}${summary.dryRun ? " (dry-run)" : ""}`,
    `failed=${summary.failed.length}`,
    `pruned=${summary.prunedArticles}`
  ];

  if (!summary.ok && summary.error) {
    lines.push(`errorCode=${summary.error.code}`);
    lines.push(`error=${summary.error.message}`);
    if (summary.error.cause) lines.push(`cause=${summary.error.cause}`);
    lines.push(`hint=${summary.error.hint}`);
  }

  if (debug) {
    if (summary.savedArticles.length > 0) {
      lines.push("");
      lines.push("Fetched article titles:");
      for (const a of summary.savedArticles) {
        lines.push(`  - ${a.title}`);
        lines.push(`    ${a.sourceUrl}`);
      }
    }
    lines.push("");
    lines.push("Fresh listing candidates:");
    if (summary.candidates.length === 0) {
      lines.push("  (none)");
    } else {
      for (const c of summary.candidates) {
        lines.push(`  - ${c.title || "(listing text unavailable)"}`);
        lines.push(`    ${c.url}`);
      }
    }
  }

  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const summary = await runFetchArticles(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatSummary(summary, { debug: options.debug }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack ?? err?.message ?? String(err));
    process.exitCode = 1;
  });
}

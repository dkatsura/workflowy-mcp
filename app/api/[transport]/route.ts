import { createHash } from "crypto";
import { queryCachedNodes } from "../../lib/search-query";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { z } from "zod";
import {
  AI_INSTRUCTIONS_BOOKMARK,
  DEFAULT_SERVER_INSTRUCTIONS,
  DEFAULT_TOOL_DESCRIPTIONS,
  LINE_TYPES,
  sanitizeToolDescriptions,
  type McpToolName,
} from "../../lib/mcp-defaults";
import {
  getMcpAccessSecret,
  getWorkflowyApiKey,
  timingSafeStringEqual,
} from "../admin/_auth";

export const runtime = "nodejs";

const WORKFLOWY_API_BASE = "https://workflowy.com";
const LLM_DOC_API_BASE = "https://beta.workflowy.com";
const EXPORT_RATE_LIMIT_MS = 60 * 1000;
const STALE_SYNC_LOCK_MS = 5 * 60 * 1000;
const CACHE_STALE_MS = 60 * 60 * 1000;
const INSERT_CHUNK_SIZE = 500;

type SqlClient = NeonQueryFunction<false, false>;
type ToolResponse = { content: Array<{ type: "text"; text: string }> };
type McpLogLevel = "info" | "success" | "warning" | "error";

interface WorkflowyExportNode {
  id: string;
  name?: string;
  note?: string;
  parent_id?: string;
  completed?: boolean;
  completedAt?: number | null;
  priority?: number;
  createdAt?: number;
  modifiedAt?: number;
}

interface WorkflowyExportResponse {
  nodes: WorkflowyExportNode[];
}

interface CachedNodeRow {
  id: string;
  name: string;
  note: string | null;
  parent_id: string | null;
  completed: boolean;
  children_count: number;
  priority: number;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  relevance_score?: number;
}

interface McpSettings {
  server_instructions: string | null;
  tool_descriptions: Partial<Record<McpToolName, string>>;
}

interface McpLogInput {
  accountKey: string;
  level: McpLogLevel;
  event: string;
  message: string;
  metadata?: Record<string, unknown>;
}

let dbPromise: Promise<SqlClient> | undefined;
type ToolRegistry = Partial<Record<McpToolName, RegisteredTool>>;

async function getDb(): Promise<SqlClient> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is not set in process.env");
    }

    const sql = neon(databaseUrl);
    await sql`
      CREATE TABLE IF NOT EXISTS workflowy_bookmarks (
        account_key TEXT NOT NULL,
        name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        context TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (account_key, name)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS workflowy_nodes (
        account_key TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        note TEXT,
        parent_id TEXT,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        children_count INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (account_key, id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS workflowy_sync_meta (
        account_key TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (account_key, key)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS workflowy_mcp_settings (
        account_key TEXT PRIMARY KEY,
        server_instructions TEXT,
        tool_descriptions JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS workflowy_mcp_logs (
        id BIGSERIAL PRIMARY KEY,
        account_key TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'mcp',
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflowy_nodes_parent
      ON workflowy_nodes (account_key, parent_id, priority)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflowy_nodes_completed
      ON workflowy_nodes (account_key, completed)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflowy_nodes_search
      ON workflowy_nodes
      USING GIN (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(note, '')))
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflowy_mcp_logs_account_created
      ON workflowy_mcp_logs (account_key, created_at DESC)
    `;

    return sql;
  })();

  return dbPromise;
}

function jsonContent(value: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function textContent(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

function parseJsonContent(value: ToolResponse): unknown {
  const text = value.content.find((item) => item.type === "text")?.text;
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getApiKey(extra: { authInfo?: AuthInfo }): string {
  if (!extra.authInfo?.token) {
    throw new Error("Workflowy API key not provided in Authorization header");
  }
  return extra.authInfo.token;
}

function accountKeyFromApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function safeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return "[truncated]";
  }

  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => safeLogValue(item, depth + 1));
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      if (/authorization|secret|token|api[_-]?key|password|credential/i.test(key)) {
        sanitized[key] = "[redacted]";
        continue;
      }
      sanitized[key] = safeLogValue(childValue, depth + 1);
    }
    return sanitized;
  }

  return String(value);
}

function safeLogMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return (safeLogValue(metadata ?? {}) ?? {}) as Record<string, unknown>;
}

async function writeMcpLog({
  accountKey,
  level,
  event,
  message,
  metadata,
}: McpLogInput): Promise<void> {
  try {
    const sql = await getDb();
    await sql`
      INSERT INTO workflowy_mcp_logs (
        account_key,
        level,
        source,
        event,
        message,
        metadata
      )
      VALUES (
        ${accountKey},
        ${level},
        'mcp',
        ${event},
        ${message},
        ${JSON.stringify(safeLogMetadata(metadata))}::jsonb
      )
    `;
  } catch {
    // Logging must never break MCP tool calls.
  }
}

function responseHasError(response: ToolResponse): boolean {
  const text = response.content.find((item) => item.type === "text")?.text;
  if (!text || !/(^|\{|,)\s*"error"\s*:|(^|\{|,)\s*"success"\s*:\s*false/.test(text)) {
    return false;
  }

  const payload = parseJsonContent(response);
  return Boolean(
    isRecord(payload) &&
      (payload.error === true ||
        payload.success === false ||
        typeof payload.error === "string" ||
        isRecord(payload.error)),
  );
}

async function loggedToolCall(
  extra: { authInfo?: AuthInfo },
  toolName: McpToolName,
  metadata: Record<string, unknown>,
  run: (apiKey: string, accountKey: string) => Promise<ToolResponse>,
): Promise<ToolResponse> {
  const apiKey = getApiKey(extra);
  const accountKey = accountKeyFromApiKey(apiKey);
  const startedAt = Date.now();

  try {
    const response = await run(apiKey, accountKey);
    const hasError = responseHasError(response);
    await writeMcpLog({
      accountKey,
      level: hasError ? "warning" : "success",
      event: `tool.${toolName}`,
      message: hasError
        ? `${toolName} completed with tool-level error`
        : `${toolName} completed`,
      metadata: {
        ...metadata,
        duration_ms: Date.now() - startedAt,
      },
    });
    return response;
  } catch (error) {
    await writeMcpLog({
      accountKey,
      level: "error",
      event: `tool.${toolName}`,
      message: `${toolName} failed`,
      metadata: {
        ...metadata,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(error),
      },
    });
    throw error;
  }
}

async function getMcpSettings(
  sql: SqlClient,
  accountKey: string,
): Promise<McpSettings> {
  const rows = await sql`
    SELECT server_instructions, tool_descriptions
    FROM workflowy_mcp_settings
    WHERE account_key = ${accountKey}
  `;
  const row = rows[0];

  return {
    server_instructions:
      typeof row?.server_instructions === "string" && row.server_instructions.trim()
        ? row.server_instructions
        : null,
    tool_descriptions: sanitizeToolDescriptions(
      isRecord(row?.tool_descriptions) ? row.tool_descriptions : null,
    ),
  };
}

function toolDescription(
  settings: McpSettings,
  name: McpToolName,
): string {
  return settings.tool_descriptions[name] || DEFAULT_TOOL_DESCRIPTIONS[name];
}

async function getSettingsForApiKey(apiKey: string): Promise<{
  sql: SqlClient;
  accountKey: string;
  settings: McpSettings;
}> {
  const sql = await getDb();
  const accountKey = accountKeyFromApiKey(apiKey);
  const settings = await getMcpSettings(sql, accountKey);
  return { sql, accountKey, settings };
}

function updateRegisteredToolDescriptions(settings: McpSettings, registeredTools: ToolRegistry): void {
  for (const [name, tool] of Object.entries(registeredTools) as Array<
    [McpToolName, RegisteredTool | undefined]
  >) {
    tool?.update({ description: toolDescription(settings, name) });
  }
}

async function refreshRegisteredToolDescriptions(apiKey: string, registeredTools: ToolRegistry): Promise<void> {
  const { settings } = await getSettingsForApiKey(apiKey);
  updateRegisteredToolDescriptions(settings, registeredTools);
}

function updateServerInstructions(
  server: { _instructions?: string },
  instructions: string,
): void {
  server._instructions = instructions;
}

function normalizeNodeId(value: string): string {
  const trimmed = value.trim();
  const linkMatch = trimmed.match(/#\/([0-9a-f]{12})(?:\b|$)/i);
  return linkMatch?.[1] ?? trimmed;
}

function clampDepth(depth: number | undefined): number {
  if (!Number.isFinite(depth)) {
    return 3;
  }
  return Math.min(Math.max(Math.trunc(depth ?? 3), 1), 10);
}

async function workflowyJsonRequest(
  apiKey: string,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: res.ok, status: res.status, data };
}

function toIsoFromWorkflowyTimestamp(value: number | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

async function getSyncMeta(
  sql: SqlClient,
  accountKey: string,
  key: string,
): Promise<string | null> {
  const rows = await sql`
    SELECT value
    FROM workflowy_sync_meta
    WHERE account_key = ${accountKey} AND key = ${key}
  `;
  return typeof rows[0]?.value === "string" ? rows[0].value : null;
}

function syncMetaQuery(
  sql: SqlClient,
  accountKey: string,
  key: string,
  value: string,
) {
  return sql`
    INSERT INTO workflowy_sync_meta (account_key, key, value, updated_at)
    VALUES (${accountKey}, ${key}, ${value}, NOW())
    ON CONFLICT (account_key, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function setSyncMeta(
  sql: SqlClient,
  accountKey: string,
  key: string,
  value: string,
): Promise<void> {
  await syncMetaQuery(sql, accountKey, key, value);
}

async function getCacheStatus(sql: SqlClient, accountKey: string) {
  const [countRows, lastSync, syncInProgress] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS count
      FROM workflowy_nodes
      WHERE account_key = ${accountKey}
    `,
    getSyncMeta(sql, accountKey, "last_full_sync"),
    getSyncMeta(sql, accountKey, "sync_in_progress"),
  ]);

  const nodeCount = Number(countRows[0]?.count ?? 0);
  const lastSyncedAt = lastSync ?? "never";
  const lastSyncTime = lastSync ? new Date(lastSync).getTime() : 0;
  const cacheIsStale = !lastSyncTime || Date.now() - lastSyncTime > CACHE_STALE_MS;

  return {
    node_count: nodeCount,
    last_synced_at: lastSyncedAt,
    is_stale: cacheIsStale,
    sync_in_progress: syncInProgress === "true",
  };
}

async function markCacheStale(sql: SqlClient, accountKey: string): Promise<void> {
  const staleTimestamp = new Date(Date.now() - CACHE_STALE_MS - 1000).toISOString();
  await setSyncMeta(sql, accountKey, "last_full_sync", staleTimestamp);
}

async function fetchNodesExport(apiKey: string): Promise<WorkflowyExportResponse> {
  const result = await workflowyJsonRequest(
    apiKey,
    `${WORKFLOWY_API_BASE}/api/v1/nodes-export`,
    { method: "GET" },
  );

  if (!result.ok) {
    throw new Error(`Workflowy export failed with HTTP ${result.status}`);
  }

  if (!isRecord(result.data) || !Array.isArray(result.data.nodes)) {
    return { nodes: [] };
  }

  return { nodes: result.data.nodes as WorkflowyExportNode[] };
}

function serializeNodesForCache(nodes: WorkflowyExportNode[]) {
  const childrenCountMap = new Map<string, number>();
  for (const node of nodes) {
    if (node.parent_id) {
      childrenCountMap.set(
        node.parent_id,
        (childrenCountMap.get(node.parent_id) ?? 0) + 1,
      );
    }
  }

  return nodes
    .filter((node) => typeof node.id === "string" && node.id.trim())
    .map((node) => ({
      id: node.id,
      name: node.name ?? "",
      note: node.note ?? null,
      parent_id: node.parent_id ?? null,
      completed: Boolean(node.completed),
      children_count: childrenCountMap.get(node.id) ?? 0,
      priority: node.priority ?? 0,
      created_at: toIsoFromWorkflowyTimestamp(node.createdAt),
      updated_at: toIsoFromWorkflowyTimestamp(node.modifiedAt),
      completed_at: toIsoFromWorkflowyTimestamp(node.completedAt),
    }));
}

async function replaceNodesCache(
  sql: SqlClient,
  accountKey: string,
  nodes: WorkflowyExportNode[],
  syncedAt: string,
): Promise<void> {
  const serializedNodes = serializeNodesForCache(nodes);
  const queries = [
    sql`DELETE FROM workflowy_nodes WHERE account_key = ${accountKey}`,
  ];

  for (let index = 0; index < serializedNodes.length; index += INSERT_CHUNK_SIZE) {
    const chunk = serializedNodes.slice(index, index + INSERT_CHUNK_SIZE);
    queries.push(
      sql(
        `
          INSERT INTO workflowy_nodes (
            account_key,
            id,
            name,
            note,
            parent_id,
            completed,
            children_count,
            priority,
            created_at,
            updated_at,
            completed_at
          )
          SELECT
            $1,
            id,
            name,
            note,
            parent_id,
            completed,
            children_count,
            priority,
            created_at,
            updated_at,
            completed_at
          FROM jsonb_to_recordset($2::jsonb) AS node(
            id TEXT,
            name TEXT,
            note TEXT,
            parent_id TEXT,
            completed BOOLEAN,
            children_count INTEGER,
            priority INTEGER,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ
          )
        `,
        [accountKey, JSON.stringify(chunk)],
      ),
    );
  }

  queries.push(
    syncMetaQuery(sql, accountKey, "last_full_sync", syncedAt),
    syncMetaQuery(sql, accountKey, "last_sync_node_count", String(serializedNodes.length)),
    syncMetaQuery(sql, accountKey, "sync_in_progress", "false"),
  );

  await sql.transaction(queries);
}

async function performFullSync(apiKey: string, accountKey: string): Promise<{
  success: boolean;
  nodes_synced?: number;
  synced_at?: string;
  cache_status?: Awaited<ReturnType<typeof getCacheStatus>>;
  error?: string;
}> {
  const sql = await getDb();
  const lastExportCalledAt = await getSyncMeta(sql, accountKey, "last_export_called_at");
  if (lastExportCalledAt) {
    const elapsedMs = Date.now() - new Date(lastExportCalledAt).getTime();
    if (elapsedMs < EXPORT_RATE_LIMIT_MS) {
      return {
        success: false,
        error: `Rate limited. Please wait ${Math.ceil(
          (EXPORT_RATE_LIMIT_MS - elapsedMs) / 1000,
        )} seconds.`,
        cache_status: await getCacheStatus(sql, accountKey),
      };
    }
  }

  const inProgress = await getSyncMeta(sql, accountKey, "sync_in_progress");
  const syncStartedAt = await getSyncMeta(sql, accountKey, "sync_started_at");
  if (inProgress === "true" && syncStartedAt) {
    const elapsedMs = Date.now() - new Date(syncStartedAt).getTime();
    if (elapsedMs < STALE_SYNC_LOCK_MS) {
      return {
        success: false,
        error: "Sync already in progress.",
        cache_status: await getCacheStatus(sql, accountKey),
      };
    }
  }

  const startedAt = new Date().toISOString();
  await setSyncMeta(sql, accountKey, "sync_in_progress", "true");
  await setSyncMeta(sql, accountKey, "sync_started_at", startedAt);
  await setSyncMeta(sql, accountKey, "last_export_called_at", startedAt);

  try {
    const exportData = await fetchNodesExport(apiKey);
    const syncedAt = new Date().toISOString();
    await replaceNodesCache(sql, accountKey, exportData.nodes, syncedAt);

    return {
      success: true,
      nodes_synced: exportData.nodes.length,
      synced_at: syncedAt,
      cache_status: await getCacheStatus(sql, accountKey),
    };
  } catch (error) {
    await setSyncMeta(sql, accountKey, "sync_in_progress", "false");
    await setSyncMeta(sql, accountKey, "last_sync_error", errorMessage(error));
    return {
      success: false,
      error: errorMessage(error),
      cache_status: await getCacheStatus(sql, accountKey),
    };
  }
}

async function ensureCacheFresh(apiKey: string, accountKey: string): Promise<{
  attempted: boolean;
  synced: boolean;
  error?: string;
  cache_status: Awaited<ReturnType<typeof getCacheStatus>>;
}> {
  const sql = await getDb();
  const cacheStatus = await getCacheStatus(sql, accountKey);

  if (cacheStatus.node_count > 0 && !cacheStatus.is_stale) {
    return {
      attempted: false,
      synced: false,
      cache_status: cacheStatus,
    };
  }

  const syncResult = await performFullSync(apiKey, accountKey);
  return {
    attempted: true,
    synced: Boolean(syncResult.success),
    error: syncResult.error,
    cache_status: syncResult.cache_status ?? (await getCacheStatus(sql, accountKey)),
  };
}

async function buildNodePath(
  sql: SqlClient,
  accountKey: string,
  nodeId: string,
): Promise<string[]> {
  const rows = await sql`
    WITH RECURSIVE path AS (
      SELECT id, name, parent_id, 0 AS depth
      FROM workflowy_nodes
      WHERE account_key = ${accountKey} AND id = ${nodeId}

      UNION ALL

      SELECT parent.id, parent.name, parent.parent_id, path.depth + 1
      FROM workflowy_nodes parent
      JOIN path ON path.parent_id = parent.id
      WHERE parent.account_key = ${accountKey} AND path.depth < 20
    )
    SELECT name
    FROM path
    ORDER BY depth DESC
  `;

  return rows
    .map((row) => String(row.name ?? ""))
    .filter(Boolean);
}

function formatPathString(path: string[]): string {
  return path.length > 0 ? path.join(" > ") : "";
}

async function getChildrenPreview(
  sql: SqlClient,
  accountKey: string,
  parentId: string,
) {
  const rows = await sql`
    SELECT name, children_count
    FROM workflowy_nodes
    WHERE account_key = ${accountKey} AND parent_id = ${parentId}
    ORDER BY priority
    LIMIT 5
  `;

  return rows.map((row) => ({
    name: String(row.name ?? ""),
    children_count: Number(row.children_count ?? 0),
  }));
}

async function formatSearchResults(
  sql: SqlClient,
  accountKey: string,
  rows: CachedNodeRow[],
) {
  return Promise.all(
    rows.map(async (row) => {
      const path = await buildNodePath(sql, accountKey, row.id);
      const childrenPreview =
        row.children_count > 0
          ? await getChildrenPreview(sql, accountKey, row.id)
          : [];

      return {
        id: row.id,
        name: row.name,
        note: row.note || null,
        parent_id: row.parent_id || null,
        completed: Boolean(row.completed),
        children_count: Number(row.children_count ?? 0),
        children_preview: childrenPreview,
        path,
        path_display: formatPathString(path),
        relevance_score:
          typeof row.relevance_score === "number"
            ? Math.round(row.relevance_score * 100) / 100
            : null,
        created_at: row.created_at || null,
        modified_at: row.updated_at || null,
        completed_at: row.completed_at || null,
      };
    }),
  );
}

async function searchCachedNodes({
  apiKey,
  accountKey,
  query,
  includeCompleted,
  limit,
}: {
  apiKey: string;
  accountKey: string;
  query: string;
  includeCompleted: boolean;
  limit: number;
}) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("query must contain non-whitespace text");
  }

  const sql = await getDb();
  const autoSync = await ensureCacheFresh(apiKey, accountKey);
  const cacheStatus = autoSync.cache_status;
  if (cacheStatus.node_count === 0) {
    return {
      error: autoSync.error
        ? `Cache is empty and auto-sync failed: ${autoSync.error}`
        : "Cache is empty. Run sync_nodes first.",
      cache_status: cacheStatus,
      auto_sync: autoSync,
      results: [],
    };
  }

  const rows = (await queryCachedNodes(
    sql, accountKey, normalizedQuery, includeCompleted, limit,
  )) as CachedNodeRow[];

  return {
    cache_status: cacheStatus,
    auto_sync: autoSync,
    results: await formatSearchResults(sql, accountKey, rows),
  };
}

function normalizeNodeApiParentId(
  parentId: string | null | undefined,
): string | null | undefined {
  if (parentId === undefined) return undefined;
  if (parentId === null || parentId === "None") return null;
  if (parentId === "inbox" || parentId === "home") return parentId;
  if (
    parentId === "today" ||
    parentId === "tomorrow" ||
    parentId === "next_week" ||
    /^\d{4}(?:-\d{2}){0,2}$/.test(parentId)
  ) {
    return undefined;
  }

  return parentId;
}

function encodeSyncTarget(parentId: string | null): string {
  return parentId === null ? "__ROOT__" : parentId;
}

function decodeSyncTarget(parentId: string): string | null {
  return parentId === "__ROOT__" ? null : parentId;
}

async function getCachedParentId(
  sql: SqlClient,
  accountKey: string,
  nodeId: string,
): Promise<string | null | undefined> {
  const rows = await sql`
    SELECT parent_id
    FROM workflowy_nodes
    WHERE account_key = ${accountKey} AND id = ${nodeId}
  `;

  if (rows.length === 0) {
    return undefined;
  }

  return typeof rows[0].parent_id === "string" ? rows[0].parent_id : null;
}

async function deleteNodeFromCache(
  sql: SqlClient,
  accountKey: string,
  nodeId: string,
): Promise<void> {
  await sql`
    WITH RECURSIVE descendants AS (
      SELECT id
      FROM workflowy_nodes
      WHERE account_key = ${accountKey} AND id = ${nodeId}

      UNION ALL

      SELECT child.id
      FROM workflowy_nodes child
      JOIN descendants ON child.parent_id = descendants.id
      WHERE child.account_key = ${accountKey}
    )
    DELETE FROM workflowy_nodes
    WHERE account_key = ${accountKey}
      AND id IN (SELECT id FROM descendants)
  `;
}

async function syncSingleNode(
  apiKey: string,
  accountKey: string,
  nodeId: string,
  parentIdOverride?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const sql = await getDb();
  const result = await workflowyJsonRequest(
    apiKey,
    `${WORKFLOWY_API_BASE}/api/v1/nodes/${encodeURIComponent(nodeId)}`,
    { method: "GET" },
  );

  if (!result.ok) {
    if (result.status === 404) {
      await deleteNodeFromCache(sql, accountKey, nodeId);
      return { success: true };
    }

    return {
      success: false,
      error: `Workflowy node refresh failed with HTTP ${result.status}`,
    };
  }

  if (!isRecord(result.data) || !isRecord(result.data.node)) {
    return { success: false, error: "Workflowy node refresh returned no node." };
  }

  const node = result.data.node as unknown as WorkflowyExportNode;
  if (!node.id) {
    return { success: false, error: "Workflowy node refresh returned a node without an id." };
  }

  const existing = await sql`
    SELECT parent_id, children_count
    FROM workflowy_nodes
    WHERE account_key = ${accountKey} AND id = ${node.id}
  `;
  const cachedParentId =
    typeof existing[0]?.parent_id === "string" ? existing[0].parent_id : null;
  const parentId =
    parentIdOverride !== undefined ? parentIdOverride : cachedParentId;
  const childrenCount = Number(existing[0]?.children_count ?? 0);

  await sql`
    INSERT INTO workflowy_nodes (
      account_key,
      id,
      name,
      note,
      parent_id,
      completed,
      children_count,
      priority,
      created_at,
      updated_at,
      completed_at
    )
    VALUES (
      ${accountKey},
      ${node.id},
      ${node.name ?? ""},
      ${node.note ?? null},
      ${parentId},
      ${Boolean(node.completed || node.completedAt)},
      ${childrenCount},
      ${node.priority ?? 0},
      ${toIsoFromWorkflowyTimestamp(node.createdAt)},
      ${toIsoFromWorkflowyTimestamp(node.modifiedAt)},
      ${toIsoFromWorkflowyTimestamp(node.completedAt)}
    )
    ON CONFLICT (account_key, id)
    DO UPDATE SET
      name = EXCLUDED.name,
      note = EXCLUDED.note,
      parent_id = EXCLUDED.parent_id,
      completed = EXCLUDED.completed,
      priority = EXCLUDED.priority,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      completed_at = EXCLUDED.completed_at
  `;

  return { success: true };
}

async function syncNodeChildren(
  apiKey: string,
  accountKey: string,
  parentId: string | null,
): Promise<{ success: boolean; error?: string; nodes_synced?: number }> {
  const sql = await getDb();
  const parentQuery =
    parentId === null
      ? "None"
      : parentId;
  const result = await workflowyJsonRequest(
    apiKey,
    `${WORKFLOWY_API_BASE}/api/v1/nodes?parent_id=${encodeURIComponent(parentQuery)}`,
    { method: "GET" },
  );

  if (!result.ok) {
    return {
      success: false,
      error: `Workflowy children refresh failed with HTTP ${result.status}`,
    };
  }

  if (!isRecord(result.data) || !Array.isArray(result.data.nodes)) {
    return { success: false, error: "Workflowy children refresh returned no nodes." };
  }

  const nodes = result.data.nodes as WorkflowyExportNode[];
  const existingRows =
    parentId === null
      ? await sql`
          SELECT id
          FROM workflowy_nodes
          WHERE account_key = ${accountKey} AND parent_id IS NULL
        `
      : await sql`
          SELECT id
          FROM workflowy_nodes
          WHERE account_key = ${accountKey} AND parent_id = ${parentId}
        `;
  const existingIds = new Set(existingRows.map((row) => String(row.id)));
  const seenIds = new Set<string>();

  for (const node of nodes) {
    if (!node.id) {
      continue;
    }

    seenIds.add(node.id);
    await sql`
      INSERT INTO workflowy_nodes (
        account_key,
        id,
        name,
        note,
        parent_id,
        completed,
        children_count,
        priority,
        created_at,
        updated_at,
        completed_at
      )
      VALUES (
        ${accountKey},
        ${node.id},
        ${node.name ?? ""},
        ${node.note ?? null},
        ${parentId},
        ${Boolean(node.completed || node.completedAt)},
        0,
        ${node.priority ?? 0},
        ${toIsoFromWorkflowyTimestamp(node.createdAt)},
        ${toIsoFromWorkflowyTimestamp(node.modifiedAt)},
        ${toIsoFromWorkflowyTimestamp(node.completedAt)}
      )
      ON CONFLICT (account_key, id)
      DO UPDATE SET
        name = EXCLUDED.name,
        note = EXCLUDED.note,
        parent_id = EXCLUDED.parent_id,
        completed = EXCLUDED.completed,
        priority = EXCLUDED.priority,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at
    `;
  }

  for (const existingId of existingIds) {
    if (!seenIds.has(existingId)) {
      await deleteNodeFromCache(sql, accountKey, existingId);
    }
  }

  if (parentId && isConcreteNodeId(parentId)) {
    await sql`
      UPDATE workflowy_nodes
      SET children_count = ${nodes.length}
      WHERE account_key = ${accountKey} AND id = ${parentId}
    `;
  }

  return { success: true, nodes_synced: nodes.length };
}

async function refreshCacheAfterEdit(
  apiKey: string,
  accountKey: string,
  root: string,
  operations: LlmDocOperation[],
): Promise<{
  stale_marked: boolean;
  parent_targets_refreshed: number;
  nodes_refreshed: number;
  errors: string[];
}> {
  const sql = await getDb();
  await markCacheStale(sql, accountKey);

  const parentTargets = new Set<string>();
  const nodeSyncRequests = new Map<string, string | null | undefined>();
  const errors: string[] = [];

  const addParentTarget = (parentId: string | null | undefined): void => {
    const normalized = normalizeNodeApiParentId(parentId);
    if (normalized !== undefined) {
      parentTargets.add(encodeSyncTarget(normalized));
    }
  };

  for (const operation of operations) {
    if (operation.op === "insert") {
      if (operation.under !== undefined) {
        addParentTarget(operation.under);
      } else if (operation.after) {
        addParentTarget(await getCachedParentId(sql, accountKey, operation.after));
      } else {
        addParentTarget(root);
      }
      continue;
    }

    if (!operation.ref) {
      continue;
    }

    const cachedParentId = await getCachedParentId(sql, accountKey, operation.ref);

    if (operation.op === "update") {
      nodeSyncRequests.set(operation.ref, undefined);
      continue;
    }

    if (operation.op === "delete") {
      addParentTarget(cachedParentId);
      nodeSyncRequests.set(operation.ref, undefined);
      continue;
    }

    if (operation.op === "move") {
      const newParentId = normalizeNodeApiParentId(operation.under);
      addParentTarget(newParentId);
      nodeSyncRequests.set(operation.ref, newParentId);
    }
  }

  let parentTargetsRefreshed = 0;
  let nodesRefreshed = 0;

  for (const parentTarget of parentTargets) {
    const result = await syncNodeChildren(
      apiKey,
      accountKey,
      decodeSyncTarget(parentTarget),
    );
    if (result.success) {
      parentTargetsRefreshed += 1;
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  for (const [nodeId, parentIdOverride] of nodeSyncRequests.entries()) {
    const result = await syncSingleNode(apiKey, accountKey, nodeId, parentIdOverride);
    if (result.success) {
      nodesRefreshed += 1;
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return {
    stale_marked: true,
    parent_targets_refreshed: parentTargetsRefreshed,
    nodes_refreshed: nodesRefreshed,
    errors,
  };
}

async function llmDocRead(
  apiKey: string,
  nodeId: string,
  depth?: number,
): Promise<ToolResponse> {
  try {
    const safeDepth = clampDepth(depth);
    const normalizedNodeId = normalizeNodeId(nodeId);
    const url = `${LLM_DOC_API_BASE}/api/llm/doc/read/${encodeURIComponent(
      normalizedNodeId,
    )}/?depth=${safeDepth}`;
    const result = await workflowyJsonRequest(apiKey, url, { method: "GET" });

    if (!result.ok) {
      return jsonContent({
        error: true,
        http_status: result.status,
        message: result.data,
      });
    }

    return jsonContent(result.data);
  } catch (error) {
    return jsonContent({ error: true, message: errorMessage(error) });
  }
}

const docItemSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      n: z.string().describe("Node text/name"),
      d: z.string().optional().describe("Node note/description"),
      l: z.enum(LINE_TYPES).optional().describe("Workflowy line type"),
      x: z.number().optional().describe("Completion status: 1 or 0"),
      c: z.array(docItemSchema).optional().describe("Nested child nodes"),
    })
    .passthrough(),
);

const operationSchema = z
  .object({
    op: z.enum(["insert", "update", "delete", "move"]),
    under: z
      .string()
      .optional()
      .describe("For insert/move: parent tag or target"),
    after: z
      .string()
      .optional()
      .describe("For insert: sibling tag to insert after"),
    items: z.array(docItemSchema).optional().describe("For insert: nodes"),
    position: z.enum(["top", "bottom"]).optional(),
    ref: z.string().optional().describe("For update/delete/move: node tag"),
    to: z
      .object({
        n: z.string().optional().describe("New node text/name"),
        d: z.string().optional().describe("New node note/description"),
        l: z.enum(LINE_TYPES).optional().describe("New line type"),
        x: z.number().optional().describe("New completion status: 1 or 0"),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type LlmDocOperation = z.infer<typeof operationSchema>;

function validateOperations(operations: LlmDocOperation[]): string | null {
  if (!Array.isArray(operations) || operations.length === 0) {
    return "operations must be a non-empty array";
  }

  for (const [index, operation] of operations.entries()) {
    const label = `operations[${index}]`;
    if (operation.op === "insert") {
      const hasUnder = Boolean(operation.under);
      const hasAfter = Boolean(operation.after);
      if (hasUnder === hasAfter) {
        return `${label}: insert requires exactly one of under or after`;
      }
      if (!operation.items?.length) {
        return `${label}: insert requires at least one item`;
      }
    }

    if (operation.op === "update") {
      if (!operation.ref) {
        return `${label}: update requires ref`;
      }
      if (!operation.to || Object.keys(operation.to).length === 0) {
        return `${label}: update requires a non-empty to object`;
      }
    }

    if (operation.op === "delete" && !operation.ref) {
      return `${label}: delete requires ref`;
    }

    if (operation.op === "move") {
      if (!operation.ref) {
        return `${label}: move requires ref`;
      }
      if (!operation.under) {
        return `${label}: move requires under`;
      }
    }
  }

  return null;
}

function isConcreteNodeId(value: string): boolean {
  return /^[0-9a-f]{12}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
}

function concreteRootFromReadResult(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (!NODE_META_KEYS.has(key) && typeof childValue === "string") {
      return key;
    }
  }

  return null;
}

async function resolveEditableRoot(apiKey: string, root: string): Promise<string> {
  const normalizedRoot = normalizeNodeId(root);
  if (isConcreteNodeId(normalizedRoot)) {
    return normalizedRoot;
  }

  const result = await workflowyJsonRequest(
    apiKey,
    `${LLM_DOC_API_BASE}/api/llm/doc/read/${encodeURIComponent(
      normalizedRoot,
    )}/?depth=10`,
    { method: "GET" },
  );

  if (!result.ok) {
    throw new Error(`Workflowy root read failed with HTTP ${result.status}`);
  }

  return concreteRootFromReadResult(result.data) ?? normalizedRoot;
}

async function llmDocEdit(
  apiKey: string,
  root: string,
  operations: LlmDocOperation[],
): Promise<ToolResponse> {
  const validationError = validateOperations(operations);
  if (validationError) {
    return jsonContent({ error: true, message: validationError });
  }

  const body = {
    root: await resolveEditableRoot(apiKey, root),
    operations,
  };

  try {
    const result = await workflowyJsonRequest(
      apiKey,
      `${LLM_DOC_API_BASE}/api/llm/doc/edit`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    if (!result.ok) {
      return jsonContent({
        error: true,
        http_status: result.status,
        message: result.data,
        request: body,
      });
    }

    return jsonContent({ success: true, response: result.data });
  } catch (error) {
    return jsonContent({ error: true, message: errorMessage(error), request: body });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NODE_META_KEYS = new Set([
  "ancestors",
  "c",
  "d",
  "l",
  "m",
  "x",
  "+",
]);

function nodeTitle(node: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(node)) {
    if (!NODE_META_KEYS.has(key) && typeof value === "string") {
      return value;
    }
  }
  return "";
}

function docToOutline(value: unknown, depth = 0): string {
  if (!isRecord(value)) {
    return "";
  }

  const indent = "  ".repeat(depth);
  const title = nodeTitle(value);
  const note = typeof value.d === "string" ? value.d : "";
  const lines: string[] = [];

  if (title) {
    lines.push(`${indent}- ${title}${value.x === 1 ? " [completed]" : ""}`);
  }

  if (note) {
    for (const line of note.split(/\r?\n/)) {
      lines.push(`${indent}  ${line}`);
    }
  }

  const children = Array.isArray(value.c) ? value.c : [];
  for (const child of children) {
    const childOutline = docToOutline(child, depth + 1);
    if (childOutline) {
      lines.push(childOutline);
    }
  }

  return lines.join("\n");
}

async function readUserInstructions(
  apiKey: string,
  nodeId: string,
): Promise<string> {
  const result = await workflowyJsonRequest(
    apiKey,
    `${LLM_DOC_API_BASE}/api/llm/doc/read/${encodeURIComponent(
      normalizeNodeId(nodeId),
    )}/?depth=6`,
    { method: "GET" },
  );

  if (!result.ok) {
    return `(Could not read ${AI_INSTRUCTIONS_BOOKMARK}: Workflowy returned ${result.status})`;
  }

  const outline = docToOutline(result.data).trim();
  return outline || `(${AI_INSTRUCTIONS_BOOKMARK} returned no readable text)`;
}

async function buildServerInstructions(apiKey: string): Promise<string> {
  const { sql, accountKey, settings } = await getSettingsForApiKey(apiKey);
  let instructions = settings.server_instructions || DEFAULT_SERVER_INSTRUCTIONS;

  instructions += `\n\n## Hosted Deployment\nThis is the remote self-hosted Workflowy MCP. Credentials are server-side, bookmarks and cache are stored in Neon, and backups/desktop controls are intentionally unavailable here.`;

  const bookmarks = await sql`
    SELECT name, node_id
    FROM workflowy_bookmarks
    WHERE account_key = ${accountKey}
    ORDER BY name
  `;
  const aiInstructionsBookmark = bookmarks.find(
    (bookmark) => bookmark.name === AI_INSTRUCTIONS_BOOKMARK,
  );

  if (aiInstructionsBookmark) {
    const userInstructions = await readUserInstructions(
      apiKey,
      String(aiInstructionsBookmark.node_id),
    );
    instructions += `\n\n## User's Custom Instructions\nThe user has configured the following custom instructions in their Workflowy "${AI_INSTRUCTIONS_BOOKMARK}" bookmark. Follow these preferences:\n\n${userInstructions}`;
  }

  return instructions;
}

const handler = createMcpHandler(
  async (server) => {
    const registeredTools: ToolRegistry = {};
    registeredTools.list_bookmarks = server.tool(
      "list_bookmarks",
      DEFAULT_TOOL_DESCRIPTIONS.list_bookmarks,
      {},
      async (_args, extra) => {
        return loggedToolCall(extra, "list_bookmarks", {}, async (apiKey, accountKey) => {
          const sql = await getDb();
          const bookmarks = await sql`
            SELECT name, node_id, context, created_at, updated_at
            FROM workflowy_bookmarks
            WHERE account_key = ${accountKey}
            ORDER BY name
          `;
          const aiInstructionsBookmark = bookmarks.find(
            (bookmark) => bookmark.name === AI_INSTRUCTIONS_BOOKMARK,
          );
          const userInstructions = aiInstructionsBookmark
            ? await readUserInstructions(apiKey, String(aiInstructionsBookmark.node_id))
            : undefined;

          return jsonContent({
            _instructions:
              "READ THIS FIRST: Use user_instructions for this conversation when present. Use bookmark node_ids directly with read_doc.",
            account: {
              id: accountKey.slice(0, 12),
              storage: "remote-neon",
            },
            bookmarks,
            user_instructions: userInstructions,
            action_required: aiInstructionsBookmark
              ? undefined
              : `No ${AI_INSTRUCTIONS_BOOKMARK} bookmark found. If the user has an AI Instructions node, read it and save it with save_bookmark using name "${AI_INSTRUCTIONS_BOOKMARK}".`,
          });
        });
      },
    );

    registeredTools.save_bookmark = server.tool(
      "save_bookmark",
      DEFAULT_TOOL_DESCRIPTIONS.save_bookmark,
      {
        name: z
          .string()
          .min(1)
          .describe("A friendly name, for example daily_tasks or ai_instructions"),
        node_id: z
          .string()
          .min(1)
          .describe("A Workflowy node tag, UUID, special target, or Workflowy link"),
        context: z
          .string()
          .optional()
          .describe("Notes for future AI sessions about when and how to use this node"),
      },
      async (
        {
          name,
          node_id,
          context,
        }: { name: string; node_id: string; context?: string },
        extra,
      ) => {
        const normalizedNodeId = normalizeNodeId(node_id);
        const normalizedContext = context?.trim() || null;

        return loggedToolCall(
          extra,
          "save_bookmark",
          {
            bookmark_name: name,
            node_id: normalizedNodeId,
            has_context: Boolean(normalizedContext),
          },
          async (_apiKey, accountKey) => {
            const sql = await getDb();
            await sql`
              INSERT INTO workflowy_bookmarks (account_key, name, node_id, context)
              VALUES (${accountKey}, ${name}, ${normalizedNodeId}, ${normalizedContext})
              ON CONFLICT (account_key, name)
              DO UPDATE SET
                node_id = EXCLUDED.node_id,
                context = EXCLUDED.context,
                updated_at = NOW()
            `;

            return textContent(
              `Bookmark "${name}" saved with node ID: ${normalizedNodeId}${
                normalizedContext ? ` and context: "${normalizedContext}"` : ""
              }`,
            );
          },
        );
      },
    );

    registeredTools.delete_bookmark = server.tool(
      "delete_bookmark",
      DEFAULT_TOOL_DESCRIPTIONS.delete_bookmark,
      {
        name: z.string().min(1).describe("The bookmark name to delete"),
      },
      async ({ name }: { name: string }, extra) => {
        return loggedToolCall(
          extra,
          "delete_bookmark",
          { bookmark_name: name },
          async (_apiKey, accountKey) => {
            const sql = await getDb();
            const deleted = await sql`
              DELETE FROM workflowy_bookmarks
              WHERE account_key = ${accountKey} AND name = ${name}
              RETURNING name
            `;

            if (deleted.length === 0) {
              return textContent(`Bookmark "${name}" not found`);
            }

            return textContent(`Bookmark "${name}" deleted`);
          },
        );
      },
    );

    registeredTools.read_doc = server.tool(
      "read_doc",
      DEFAULT_TOOL_DESCRIPTIONS.read_doc,
      {
        node_id: z
          .string()
          .min(1)
          .describe(
            "12-hex tag, full UUID, Workflowy link, or special target: today, tomorrow, next_week, inbox, None",
          ),
        depth: z
          .number()
          .optional()
          .describe("How many child levels to include. Default 3, max 10."),
      },
      async (
        { node_id, depth }: { node_id: string; depth?: number },
        extra,
      ) => loggedToolCall(
        extra,
        "read_doc",
        {
          node_id: normalizeNodeId(node_id),
          depth: clampDepth(depth),
        },
        async (apiKey) => llmDocRead(apiKey, node_id, depth),
      ),
    );

    registeredTools.edit_doc = server.tool(
      "edit_doc",
      DEFAULT_TOOL_DESCRIPTIONS.edit_doc,
      {
        root: z
          .string()
          .min(1)
          .describe("Subtree root tag/UUID or target such as today, inbox, or None"),
        operations: z
          .array(operationSchema)
          .min(1)
          .describe("Operations to apply in order"),
      },
      async (
        {
          root,
          operations,
        }: { root: string; operations: LlmDocOperation[] },
        extra,
      ) => {
        return loggedToolCall(
          extra,
          "edit_doc",
          {
            root: normalizeNodeId(root),
            operation_count: operations.length,
            operation_types: operations.map((operation) => operation.op),
          },
          async (apiKey, accountKey) => {
            const editResponse = await llmDocEdit(apiKey, root, operations);
            const payload = parseJsonContent(editResponse);

            if (isRecord(payload) && payload.success === true) {
              const cacheRefresh = await refreshCacheAfterEdit(
                apiKey,
                accountKey,
                root,
                operations,
              );
              return jsonContent({
                ...payload,
                cache_refresh: cacheRefresh,
              });
            }

            return editResponse;
          },
        );
      },
    );

    registeredTools.search_nodes = server.tool(
      "search_nodes",
      DEFAULT_TOOL_DESCRIPTIONS.search_nodes,
      {
        query: z.string().min(1).describe("Text to search for"),
        include_completed: z
          .boolean()
          .optional()
          .describe("Include completed Workflowy nodes. Defaults to false."),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of results. Defaults to 10, max 100."),
      },
      async (
        {
          query,
          include_completed,
          limit,
        }: { query: string; include_completed?: boolean; limit?: number },
        extra,
      ) => {
        const safeLimit = Math.min(Math.max(Math.trunc(limit ?? 10), 1), 100);
        return loggedToolCall(
          extra,
          "search_nodes",
          {
            query_length: query.trim().length,
            include_completed: include_completed ?? false,
            limit: safeLimit,
          },
          async (apiKey, accountKey) => {
            const result = await searchCachedNodes({
              apiKey,
              accountKey,
              query,
              includeCompleted: include_completed ?? false,
              limit: safeLimit,
            });

            return jsonContent({
              query,
              results: result.results,
              total_found: result.results.length,
              cache_status: result.cache_status,
              auto_sync: result.auto_sync,
              error: result.error,
            });
          },
        );
      },
    );

    registeredTools.sync_nodes = server.tool(
      "sync_nodes",
      DEFAULT_TOOL_DESCRIPTIONS.sync_nodes,
      {},
      async (_args, extra) => {
        return loggedToolCall(extra, "sync_nodes", {}, async (apiKey, accountKey) =>
          jsonContent(await performFullSync(apiKey, accountKey)),
        );
      },
    );

    registeredTools.cache_status = server.tool(
      "cache_status",
      DEFAULT_TOOL_DESCRIPTIONS.cache_status,
      {},
      async (_args, extra) => {
        return loggedToolCall(extra, "cache_status", {}, async (_apiKey, accountKey) => {
          const sql = await getDb();
          return jsonContent(await getCacheStatus(sql, accountKey));
        });
      },
    );

    registeredTools.get_targets = server.tool(
      "get_targets",
      DEFAULT_TOOL_DESCRIPTIONS.get_targets,
      {},
      async (_args, extra) => {
        return loggedToolCall(extra, "get_targets", {}, async (apiKey) => {
          try {
            const result = await workflowyJsonRequest(
              apiKey,
              `${WORKFLOWY_API_BASE}/api/v1/targets`,
              { method: "GET" },
            );
            return jsonContent({
              http_status: result.status,
              ok: result.ok,
              data: result.data,
            });
          } catch (error) {
            return jsonContent({ error: true, message: errorMessage(error) });
          }
        });
      },
    );

    server.prompt(
      "server_instructions",
      "Get the current Workflowy MCP instructions, hosted deployment notes, and user's ai_instructions content when configured.",
      async (extra) => {
        const apiKey = getApiKey(extra);
        const accountKey = accountKeyFromApiKey(apiKey);
        const startedAt = Date.now();

        try {
          await ensureCacheFresh(apiKey, accountKey).catch(() => undefined);
          const instructions = await buildServerInstructions(apiKey);
          await writeMcpLog({
            accountKey,
            level: "success",
            event: "prompt.server_instructions",
            message: "server_instructions prompt completed",
            metadata: {
              duration_ms: Date.now() - startedAt,
              character_count: instructions.length,
            },
          });

          return {
            description: "Server instructions for working with Workflowy",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: instructions,
                },
              },
            ],
          };
        } catch (error) {
          await writeMcpLog({
            accountKey,
            level: "error",
            event: "prompt.server_instructions",
            message: "server_instructions prompt failed",
            metadata: {
              duration_ms: Date.now() - startedAt,
              error: errorMessage(error),
            },
          });
          throw error;
        }
      },
    );

    const protocolServer = (
      server.server as unknown as {
        _requestHandlers?: Map<
          string,
          (request: unknown, extra: unknown) => unknown | Promise<unknown>
        >;
        _instructions?: string;
      }
    );
    const requestHandlers = protocolServer._requestHandlers;
    const originalInitializeHandler = requestHandlers?.get("initialize");
    const originalListToolsHandler = requestHandlers?.get("tools/list");

    if (originalInitializeHandler) {
      server.server.setRequestHandler(InitializeRequestSchema, async (request, extra) => {
        const apiKey = getApiKey(extra);
        const accountKey = accountKeyFromApiKey(apiKey);
        const startedAt = Date.now();
        try {
          updateServerInstructions(
            protocolServer,
            await buildServerInstructions(apiKey),
          );
        } catch {
          updateServerInstructions(protocolServer, DEFAULT_SERVER_INSTRUCTIONS);
        }

        const result = (await originalInitializeHandler(request, extra)) as {
          protocolVersion: string;
          capabilities: unknown;
          serverInfo: unknown;
          instructions?: string;
        };
        await writeMcpLog({
          accountKey,
          level: "success",
          event: "mcp.initialize",
          message: "MCP client initialized",
          metadata: {
            duration_ms: Date.now() - startedAt,
            protocol_version: result.protocolVersion,
          },
        });
        return result;
      });
    }

    if (originalListToolsHandler) {
      server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const apiKey = getApiKey(extra);
        const accountKey = accountKeyFromApiKey(apiKey);
        const startedAt = Date.now();
        await refreshRegisteredToolDescriptions(apiKey, registeredTools).catch(() => undefined);
        const result = (await originalListToolsHandler(request, extra)) as {
          tools: unknown[];
        };
        await writeMcpLog({
          accountKey,
          level: "success",
          event: "mcp.tools_list",
          message: "MCP tools listed",
          metadata: {
            duration_ms: Date.now() - startedAt,
            tool_count: result.tools.length,
          },
        });
        return result;
      });
    }

    const envApiKey = getWorkflowyApiKey();
    if (envApiKey) {
      await refreshRegisteredToolDescriptions(envApiKey, registeredTools).catch(() => undefined);
      await buildServerInstructions(envApiKey)
        .then((instructions) => updateServerInstructions(protocolServer, instructions))
        .catch(() => undefined);
    }
  },
  { instructions: DEFAULT_SERVER_INSTRUCTIONS },
  { basePath: "/api" },
);

const verifyToken = async (
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) {
    return undefined;
  }

  const accessSecret = getMcpAccessSecret();
  if (!accessSecret) {
    return undefined;
  }

  const workflowyApiKeyFromEnv = getWorkflowyApiKey();
  if (timingSafeStringEqual(bearerToken, accessSecret)) {
    if (!workflowyApiKeyFromEnv) {
      return undefined;
    }

    return {
      token: workflowyApiKeyFromEnv,
      scopes: ["workflowy"],
      clientId: accountKeyFromApiKey(workflowyApiKeyFromEnv).slice(0, 12),
    };
  }

  const separatorIndex = bearerToken.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const providedSecret = bearerToken.slice(0, separatorIndex);
  if (!timingSafeStringEqual(providedSecret, accessSecret)) {
    return undefined;
  }

  const workflowyApiKey = bearerToken.slice(separatorIndex + 1).trim();
  if (!workflowyApiKey) {
    return undefined;
  }

  return {
    token: workflowyApiKey,
    scopes: ["workflowy"],
    clientId: accountKeyFromApiKey(workflowyApiKey).slice(0, 12),
  };
};

function originIsAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  if (!origin || !allowedOrigins?.trim()) {
    return true;
  }

  return allowedOrigins
    .split(",")
    .map((allowedOrigin) => allowedOrigin.trim())
    .filter(Boolean)
    .includes(origin);
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  const allowOrigin = allowedOrigins?.trim() ? origin ?? "null" : origin ?? "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Expose-Headers":
      "mcp-session-id, mcp-protocol-version, www-authenticate",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = corsHeaders(request);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

const authHandler = withMcpAuth(handler, verifyToken, { required: true });
const runAuthHandler = authHandler as (
  request: Request,
  context?: { params: Promise<{ transport: string }> },
) => Response | Promise<Response>;

async function route(
  request: Request,
  context: { params: Promise<{ transport: string }> },
): Promise<Response> {
  if (!originIsAllowed(request)) {
    return new Response("Origin not allowed", { status: 403 });
  }

  return withCors(await runAuthHandler(request, context), request);
}

async function options(
  request: Request,
): Promise<Response> {
  if (!originIsAllowed(request)) {
    return new Response("Origin not allowed", { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export { route as DELETE, route as GET, options as OPTIONS, route as POST };

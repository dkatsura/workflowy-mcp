"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TOOL_DESCRIPTIONS,
  MCP_TOOL_NAMES,
  type McpToolName,
} from "./lib/mcp-defaults";
import styles from "./page.module.css";

type Section = "connection" | "setup" | "tools" | "bookmarks" | "cache" | "diagnostics";
type SetupTab = "claude" | "generic" | "json";
type LogType = "info" | "success" | "error" | "warning";

interface ToolInfo {
  name: string;
  description?: string;
}

interface Bookmark {
  name: string;
  node_id: string;
  context?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface CacheStatus {
  node_count: number;
  last_synced_at: string;
  is_stale: boolean;
  sync_in_progress: boolean;
}

interface AdminStatus {
  authenticated: boolean;
  admin_configured: boolean;
  version: string;
  endpoint: string;
  mcp_access_secret_configured: boolean;
  workflowy_api_key_configured: boolean;
  database_configured: boolean;
}

interface McpSettingsPayload {
  account_id: string;
  server_instructions: string | null;
  tool_descriptions: Partial<Record<McpToolName, string>>;
  default_server_instructions: string;
  default_tool_descriptions: Record<McpToolName, string>;
  tool_names: McpToolName[];
  updated_at: string | null;
}

interface ActivityLog {
  id: number;
  type: LogType;
  message: string;
  timestamp: string;
}

interface ServerLog {
  id: string | number;
  level: LogType;
  source: string;
  event: string;
  message: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

interface ServerLogsPayload {
  logs?: ServerLog[];
  total_returned?: number;
  error?: { message?: string } | string;
}

interface McpResponse<T = unknown> {
  result?: T;
  error?: { message?: string; code?: number } | string;
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
}

interface ListBookmarksPayload {
  bookmarks?: Bookmark[];
  user_instructions?: string;
  action_required?: string;
}

interface SearchPayload {
  results?: Array<{
    id: string;
    name: string;
    path_display?: string;
    children_count?: number;
    relevance_score?: number | null;
  }>;
  total_found?: number;
  cache_status?: CacheStatus;
  auto_sync?: {
    attempted: boolean;
    synced: boolean;
    error?: string;
    cache_status?: CacheStatus;
  };
  error?: string;
}

const navItems: Array<{ id: Section; label: string }> = [
  { id: "connection", label: "Connection" },
  { id: "setup", label: "Setup" },
  { id: "tools", label: "Tools" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "cache", label: "Cache" },
  { id: "diagnostics", label: "Diagnostics" },
];

function parseSseJson(text: string): McpResponse {
  const dataLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice(6) : text;
  return JSON.parse(jsonText) as McpResponse;
}

function extractToolText(result: ToolCallResult): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function parseToolJson<T>(result: ToolCallResult): T {
  return JSON.parse(extractToolText(result)) as T;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return "";
  }

  return JSON.stringify(metadata);
}

function initParticleBackground(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return () => {};
  }
  const context = ctx;

  let animFrameId = 0;
  let spawnInterval = 0;
  let resizeTimeout = 0;

  const bgR = 26;
  const bgG = 26;
  const bgB = 46;
  const spacing = 10;
  const radius = 3;
  const baseRgb = { r: 38, g: 38, b: 58 };
  const targetRgb = { r: 140, g: 140, b: 170 };
  const fadeRgb = { r: bgR, g: bgG, b: bgB };
  const transitionSpeed = 2.5;
  const targetActivePercent = 0.006;
  const moveChance = 0.7;
  const minWaitTime = 600;
  const maxWaitTime = 2200;
  const checkInterval = 120;
  const edgeFadeDistance = 300;

  const STATE_IDLE = 0;
  const STATE_DARKENING = 1;
  const STATE_WAITING = 2;
  const STATE_LIGHTENING_TO_MOVE = 3;
  const STATE_DARKENING_AFTER_MOVE = 4;
  const STATE_DECAYING = 5;

  const directions = [
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: 1 },
  ];

  interface Dot {
    x: number;
    y: number;
    gridX: number;
    gridY: number;
    progress: number;
    state: number;
    waitUntil: number;
    fadedBaseR: number;
    fadedBaseG: number;
    fadedBaseB: number;
    fadedTargetR: number;
    fadedTargetG: number;
    fadedTargetB: number;
    drawX?: number;
    drawY?: number;
  }

  let dots: Dot[] = [];
  const dotGrid: Record<string, Dot> = {};
  const activeDots = new Set<Dot>();
  let gridCols = 0;
  let gridRows = 0;

  function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  function calcEdgeFade(y: number): number {
    const dist = Math.min(y, canvas.height - y);
    return dist >= edgeFadeDistance ? 1 : dist / edgeFadeDistance;
  }

  function initDots(): void {
    dots = [];
    activeDots.clear();
    for (const key in dotGrid) {
      delete dotGrid[key];
    }
    gridCols = Math.floor(canvas.width / spacing);
    gridRows = Math.floor(canvas.height / spacing);

    for (let gx = 0; gx < gridCols; gx += 1) {
      for (let gy = 0; gy < gridRows; gy += 1) {
        const x = gx * spacing + spacing / 2;
        const y = gy * spacing + spacing / 2;
        const edgeFade = calcEdgeFade(y);
        const dot: Dot = {
          x,
          y,
          gridX: gx,
          gridY: gy,
          progress: 0,
          state: STATE_IDLE,
          waitUntil: 0,
          fadedBaseR: Math.round(lerp(fadeRgb.r, baseRgb.r, edgeFade)),
          fadedBaseG: Math.round(lerp(fadeRgb.g, baseRgb.g, edgeFade)),
          fadedBaseB: Math.round(lerp(fadeRgb.b, baseRgb.b, edgeFade)),
          fadedTargetR: Math.round(lerp(fadeRgb.r, targetRgb.r, edgeFade)),
          fadedTargetG: Math.round(lerp(fadeRgb.g, targetRgb.g, edgeFade)),
          fadedTargetB: Math.round(lerp(fadeRgb.b, targetRgb.b, edgeFade)),
        };
        dots.push(dot);
        dotGrid[`${gx},${gy}`] = dot;
      }
    }
  }

  function getDotAt(gx: number, gy: number): Dot | null {
    return dotGrid[`${gx},${gy}`] || null;
  }

  function isAvailable(gx: number, gy: number): boolean {
    if (gx < 0 || gx >= gridCols || gy < 0 || gy >= gridRows) {
      return false;
    }
    const dot = getDotAt(gx, gy);
    return Boolean(dot && dot.state === STATE_IDLE);
  }

  function getAdjacentAvailable(dot: Dot): Array<{ gx: number; gy: number }> {
    return directions
      .filter((direction) => isAvailable(dot.gridX + direction.dx, dot.gridY + direction.dy))
      .map((direction) => ({ gx: dot.gridX + direction.dx, gy: dot.gridY + direction.dy }));
  }

  function activateDot(dot: Dot): void {
    dot.state = STATE_DARKENING;
    activeDots.add(dot);
  }

  function deactivateDot(dot: Dot): void {
    dot.state = STATE_IDLE;
    dot.progress = 0;
    activeDots.delete(dot);
  }

  function spawnWanderers(): void {
    const needed = Math.floor(dots.length * targetActivePercent) - activeDots.size;
    if (needed <= 0) {
      return;
    }

    const idle = dots.filter((dot) => dot.state === STATE_IDLE);
    for (let index = 0; index < needed && idle.length > 0; index += 1) {
      const idleIndex = Math.floor(Math.random() * idle.length);
      activateDot(idle[idleIndex]);
      idle.splice(idleIndex, 1);
    }
  }

  function draw(): void {
    context.fillStyle = `rgb(${bgR}, ${bgG}, ${bgB})`;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const groups = new Map<string, Dot[]>();
    for (const dot of dots) {
      const r = Math.round(lerp(dot.fadedBaseR, dot.fadedTargetR, dot.progress));
      const g = Math.round(lerp(dot.fadedBaseG, dot.fadedTargetG, dot.progress));
      const b = Math.round(lerp(dot.fadedBaseB, dot.fadedTargetB, dot.progress));
      const key = `${r},${g},${b}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)?.push(dot);
    }

    for (const [key, groupDots] of groups) {
      context.fillStyle = `rgb(${key})`;
      context.beginPath();
      for (const dot of groupDots) {
        const px = dot.drawX ?? dot.x;
        const py = dot.drawY ?? dot.y;
        context.moveTo(px + radius, py);
        context.arc(px, py, radius, 0, Math.PI * 2);
      }
      context.fill();
    }
  }

  function update(): void {
    const speed = transitionSpeed / 100;
    const now = performance.now();
    const remove: Dot[] = [];

    for (const dot of activeDots) {
      switch (dot.state) {
        case STATE_DARKENING:
          dot.progress += speed;
          if (dot.progress >= 1) {
            dot.progress = 1;
            dot.state = STATE_WAITING;
            dot.waitUntil = now + minWaitTime + Math.random() * (maxWaitTime - minWaitTime);
          }
          break;
        case STATE_WAITING:
          if (now >= dot.waitUntil) {
            if (Math.random() < moveChance) {
              const available = getAdjacentAvailable(dot);
              if (available.length > 0) {
                const position = available[Math.floor(Math.random() * available.length)];
                const targetDot = getDotAt(position.gx, position.gy);
                if (targetDot) {
                  targetDot.state = STATE_DARKENING_AFTER_MOVE;
                  activeDots.add(targetDot);
                  dot.state = STATE_LIGHTENING_TO_MOVE;
                }
              } else {
                dot.state = STATE_DECAYING;
              }
            } else {
              dot.state = STATE_DECAYING;
            }
          }
          break;
        case STATE_LIGHTENING_TO_MOVE:
        case STATE_DECAYING:
          dot.progress -= speed;
          if (dot.progress <= 0) {
            remove.push(dot);
          }
          break;
        case STATE_DARKENING_AFTER_MOVE:
          dot.progress += speed;
          if (dot.progress >= 1) {
            dot.progress = 1;
            dot.state = STATE_WAITING;
            dot.waitUntil = now + minWaitTime + Math.random() * (maxWaitTime - minWaitTime);
          }
          break;
      }
    }

    for (const dot of remove) {
      deactivateDot(dot);
    }
  }

  function resizeCanvas(): void {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function onResize(): void {
    window.clearTimeout(resizeTimeout);
    resizeTimeout = window.setTimeout(() => {
      resizeCanvas();
      initDots();
    }, 200);
  }

  function animate(): void {
    update();
    draw();
    animFrameId = window.requestAnimationFrame(animate);
  }

  resizeCanvas();
  initDots();
  spawnInterval = window.setInterval(spawnWanderers, checkInterval);
  window.addEventListener("resize", onResize);
  animate();

  return () => {
    window.cancelAnimationFrame(animFrameId);
    window.clearInterval(spawnInterval);
    window.clearTimeout(resizeTimeout);
    window.removeEventListener("resize", onResize);
  };
}

export default function Home() {
  const particleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoConnectionCheckRef = useRef<string | null>(null);
  const [appMode, setAppMode] = useState<"dashboard" | "settings">("dashboard");
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [adminSecret, setAdminSecret] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>("connection");
  const [setupTab, setSetupTab] = useState<SetupTab>("claude");
  const [endpoint, setEndpoint] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "checking" | "connected" | "failed">("idle");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [mcpSettings, setMcpSettings] = useState<McpSettingsPayload | null>(null);
  const [serverInstructionsDraft, setServerInstructionsDraft] = useState("");
  const [toolDescriptionDrafts, setToolDescriptionDrafts] = useState<
    Partial<Record<McpToolName, string>>
  >({});
  const [expandedTools, setExpandedTools] = useState<Set<McpToolName>>(new Set());
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [serverLogs, setServerLogs] = useState<ServerLog[]>([]);
  const [bookmarkName, setBookmarkName] = useState("");
  const [bookmarkNodeId, setBookmarkNodeId] = useState("");
  const [bookmarkContext, setBookmarkContext] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchPayload["results"]>([]);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setEndpoint(`${window.location.origin}/api/mcp`);
    void refreshAdminSession(false);
  }, []);

  useEffect(() => {
    if (!particleCanvasRef.current) {
      return;
    }
    return initParticleBackground(particleCanvasRef.current);
  }, []);

  const isAuthenticated = Boolean(adminStatus?.authenticated);
  const serverReady = Boolean(
    adminStatus?.mcp_access_secret_configured &&
      adminStatus.workflowy_api_key_configured &&
      adminStatus.database_configured,
  );
  const canCallMcp = Boolean(endpoint && isAuthenticated && serverReady);
  const statusTone =
    !adminStatus || isAuthBusy
      ? "checking"
      : !adminStatus.admin_configured || (isAuthenticated && !serverReady)
        ? "failed"
        : connectionStatus;

  useEffect(() => {
    if (!canCallMcp || connectionStatus !== "idle" || isBusy || isAuthBusy) {
      return;
    }

    const autoCheckKey = [
      endpoint,
      adminStatus?.authenticated,
      adminStatus?.mcp_access_secret_configured,
      adminStatus?.workflowy_api_key_configured,
      adminStatus?.database_configured,
    ].join(":");

    if (autoConnectionCheckRef.current === autoCheckKey) {
      return;
    }

    autoConnectionCheckRef.current = autoCheckKey;
    void testConnection();
  }, [
    adminStatus?.authenticated,
    adminStatus?.database_configured,
    adminStatus?.mcp_access_secret_configured,
    adminStatus?.workflowy_api_key_configured,
    canCallMcp,
    connectionStatus,
    endpoint,
    isAuthBusy,
    isBusy,
  ]);

  const settingsToolNames = mcpSettings?.tool_names ?? MCP_TOOL_NAMES;
  const defaultToolDescriptions =
    mcpSettings?.default_tool_descriptions ?? DEFAULT_TOOL_DESCRIPTIONS;
  const hasSettingsChanges = Boolean(
    mcpSettings &&
      (serverInstructionsDraft.trim() !==
        (mcpSettings.server_instructions ?? mcpSettings.default_server_instructions).trim() ||
        settingsToolNames.some(
          (name) =>
            (toolDescriptionDrafts[name] ?? defaultToolDescriptions[name]).trim() !==
            (mcpSettings.tool_descriptions[name] ?? defaultToolDescriptions[name]).trim(),
        )),
  );

  function addLog(type: LogType, message: string): void {
    setActivity((current) => [
      ...current.slice(-80),
      {
        id: Date.now() + Math.floor(Math.random() * 1000),
        type,
        message,
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  async function refreshAdminSession(showLog = true): Promise<void> {
    try {
      const response = await fetch("/api/admin/session", {
        credentials: "same-origin",
      });
      const status = (await response.json()) as AdminStatus;
      setAdminStatus(status);
      setEndpoint(status.endpoint || `${window.location.origin}/api/mcp`);
      if (!status.authenticated) {
        setConnectionStatus("idle");
        setTools([]);
        setMcpSettings(null);
        setServerInstructionsDraft("");
        setToolDescriptionDrafts({});
        setExpandedTools(new Set());
        setBookmarks([]);
        setCacheStatus(null);
        setSearchResults([]);
        setServerLogs([]);
        setAppMode("dashboard");
      }
      if (showLog) {
        addLog("info", "Admin session status refreshed.");
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loginAdmin(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    setIsAuthBusy(true);
    setAuthMessage("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: adminSecret }),
      });
      const data = (await response.json()) as AdminStatus & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setAdminStatus(data);
      setEndpoint(data.endpoint || `${window.location.origin}/api/mcp`);
      setAdminSecret("");
      setAuthMessage("");
      addLog("success", "Admin console unlocked.");
      await refreshMcpSettings(false);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAuthBusy(false);
    }
  }

  async function logoutAdmin(): Promise<void> {
    setIsAuthBusy(true);
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      setAdminStatus((current) =>
        current
          ? { ...current, authenticated: false }
          : null,
      );
      setConnectionStatus("idle");
      setTools([]);
      setMcpSettings(null);
      setServerInstructionsDraft("");
      setToolDescriptionDrafts({});
      setExpandedTools(new Set());
      setBookmarks([]);
      setCacheStatus(null);
      setSearchResults([]);
      setServerLogs([]);
      setAppMode("dashboard");
      addLog("info", "Admin console locked.");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAuthBusy(false);
    }
  }

  async function mcpRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!canCallMcp) {
      throw new Error("Admin session or server configuration is incomplete.");
    }

    const response = await fetch("/api/admin/mcp", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });
    const text = await response.text();
    const parsed = parseSseJson(text);

    if (!response.ok || parsed.error) {
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }

    return parsed.result as T;
  }

  async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await mcpRequest<ToolCallResult>("tools/call", {
      name,
      arguments: args,
    });
    return parseToolJson<T>(result);
  }

  async function testConnection(): Promise<void> {
    setIsBusy(true);
    setConnectionStatus("checking");
    try {
      const init = await mcpRequest<{ serverInfo?: { name?: string }; protocolVersion?: string }>("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "workflowy-mcp-web-console", version: "0.1.0" },
      });
      const toolList = await mcpRequest<{ tools: ToolInfo[] }>("tools/list", {});
      setTools(toolList.tools ?? []);
      setConnectionStatus("connected");
      addLog(
        "success",
        `Connected to ${init.serverInfo?.name || "Workflowy MCP"} with ${toolList.tools?.length ?? 0} tools.`,
      );
      await refreshCacheStatus(false);
      await refreshBookmarks(false);
      await refreshMcpSettings(false);
      await refreshServerLogs(false);
    } catch (error) {
      setConnectionStatus("failed");
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshMcpSettings(showLog = true): Promise<void> {
    try {
      const response = await fetch("/api/admin/settings", {
        credentials: "same-origin",
      });
      const data = (await response.json()) as McpSettingsPayload & {
        error?: { message?: string } | string;
      };
      if (!response.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : data.error?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }

      setMcpSettings(data);
      setServerInstructionsDraft(
        data.server_instructions ?? data.default_server_instructions,
      );
      setToolDescriptionDrafts({
        ...data.default_tool_descriptions,
        ...data.tool_descriptions,
      });
      if (showLog) {
        addLog("success", "MCP instructions loaded.");
      }
    } catch (error) {
      if (showLog) {
        addLog("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  function toolDescriptionOverrides(): Partial<Record<McpToolName, string>> {
    const overrides: Partial<Record<McpToolName, string>> = {};

    for (const name of settingsToolNames) {
      const value = (toolDescriptionDrafts[name] ?? "").trim();
      if (value && value !== defaultToolDescriptions[name]) {
        overrides[name] = value;
      }
    }

    return overrides;
  }

  async function saveMcpSettings(): Promise<void> {
    setIsBusy(true);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_instructions: serverInstructionsDraft,
          tool_descriptions: toolDescriptionOverrides(),
        }),
      });
      const data = (await response.json()) as McpSettingsPayload & {
        error?: { message?: string } | string;
      };
      if (!response.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : data.error?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }

      setMcpSettings(data);
      setServerInstructionsDraft(
        data.server_instructions ?? data.default_server_instructions,
      );
      setToolDescriptionDrafts({
        ...data.default_tool_descriptions,
        ...data.tool_descriptions,
      });
      addLog("success", "MCP instructions saved.");
      if (connectionStatus === "connected") {
        await testConnection();
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  function resetServerInstructions(): void {
    if (mcpSettings) {
      setServerInstructionsDraft(mcpSettings.default_server_instructions);
    }
  }

  function updateToolDescription(name: McpToolName, value: string): void {
    setToolDescriptionDrafts((current) => ({
      ...current,
      [name]: value,
    }));
  }

  function resetToolDescription(name: McpToolName): void {
    setToolDescriptionDrafts((current) => ({
      ...current,
      [name]: defaultToolDescriptions[name],
    }));
  }

  function toggleToolExpanded(name: McpToolName): void {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function isToolCustomized(name: McpToolName): boolean {
    return (
      (toolDescriptionDrafts[name] ?? defaultToolDescriptions[name]).trim() !==
      defaultToolDescriptions[name].trim()
    );
  }

  async function refreshServerLogs(showLog = true): Promise<void> {
    try {
      const response = await fetch("/api/admin/logs?limit=120", {
        credentials: "same-origin",
      });
      const data = (await response.json()) as ServerLogsPayload;
      if (!response.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : data.error?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }

      setServerLogs(data.logs ?? []);
      if (showLog) {
        addLog("success", `Loaded ${data.logs?.length ?? 0} server logs.`);
      }
    } catch (error) {
      if (showLog) {
        addLog("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function clearServerLogs(): Promise<void> {
    setIsBusy(true);
    try {
      const response = await fetch("/api/admin/logs", {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = (await response.json()) as {
        deleted_count?: number;
        error?: { message?: string } | string;
      };
      if (!response.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : data.error?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }

      setServerLogs([]);
      addLog("success", `Cleared ${data.deleted_count ?? 0} server logs.`);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshBookmarks(showLog = true): Promise<void> {
    setIsBusy(true);
    try {
      const result = await callTool<ListBookmarksPayload>("list_bookmarks");
      setBookmarks(result.bookmarks ?? []);
      if (showLog) {
        addLog("success", `Loaded ${result.bookmarks?.length ?? 0} bookmarks.`);
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function saveBookmark(): Promise<void> {
    setIsBusy(true);
    try {
      await callTool("save_bookmark", {
        name: bookmarkName.trim(),
        node_id: bookmarkNodeId.trim(),
        context: bookmarkContext.trim(),
      });
      setBookmarkName("");
      setBookmarkNodeId("");
      setBookmarkContext("");
      addLog("success", "Bookmark saved.");
      await refreshBookmarks(false);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteBookmark(name: string): Promise<void> {
    setIsBusy(true);
    try {
      await callTool("delete_bookmark", { name });
      addLog("success", `Deleted bookmark ${name}.`);
      await refreshBookmarks(false);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshCacheStatus(showLog = true): Promise<void> {
    try {
      const result = await callTool<CacheStatus>("cache_status");
      setCacheStatus(result);
      if (showLog) {
        addLog("success", `Cache has ${result.node_count.toLocaleString()} nodes.`);
      }
    } catch (error) {
      if (showLog) {
        addLog("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function syncNodes(): Promise<void> {
    setIsBusy(true);
    try {
      const result = await callTool<{
        success?: boolean;
        nodes_synced?: number;
        error?: string;
        cache_status?: CacheStatus;
      }>("sync_nodes");
      if (!result.success) {
        throw new Error(result.error || "Sync failed.");
      }
      setCacheStatus(result.cache_status ?? null);
      addLog("success", `Synced ${(result.nodes_synced ?? 0).toLocaleString()} nodes.`);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function searchNodes(): Promise<void> {
    setIsBusy(true);
    try {
      const result = await callTool<SearchPayload>("search_nodes", {
        query: searchQuery.trim(),
        limit: 8,
      });
      setSearchResults(result.results ?? []);
      if (result.cache_status) {
        setCacheStatus(result.cache_status);
      }
      if (result.auto_sync?.attempted) {
        addLog(
          result.auto_sync.synced ? "success" : "warning",
          result.auto_sync.synced
            ? "Cache auto-synced before search."
            : `Auto-sync skipped: ${result.auto_sync.error || "using existing cache."}`,
        );
      }
      if (result.error) {
        addLog("warning", result.error);
      } else {
        addLog("success", `Found ${result.total_found ?? 0} results.`);
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  function copyText(value: string, label: string): void {
    void navigator.clipboard.writeText(value);
    addLog("success", `${label} copied.`);
  }

  const claudeConfig = `{
  "mcpServers": {
    "workflowy": {
      "type": "streamable-http",
      "url": "${endpoint || "https://YOUR-APP.vercel.app/api/mcp"}",
      "headers": {
        "Authorization": "Bearer MCP_ACCESS_SECRET"
      }
    }
  }
}`;

  const activeConfig =
    setupTab === "claude"
      ? claudeConfig
      : setupTab === "generic"
        ? `Endpoint: ${endpoint}\nAuthorization: Bearer MCP_ACCESS_SECRET`
        : JSON.stringify(
            {
              type: "streamable-http",
              url: endpoint,
              headers: { Authorization: "Bearer MCP_ACCESS_SECRET" },
            },
            null,
            2,
          );

  const connectionText = (() => {
    if (!adminStatus) {
      return "Checking admin session";
    }
    if (!adminStatus.admin_configured) {
      return "ADMIN_SECRET missing";
    }
    if (!isAuthenticated) {
      return "Admin console locked";
    }
    if (!serverReady) {
      return "Configuration issues";
    }
    if (connectionStatus === "connected") {
      return "Connected";
    }
    if (connectionStatus === "checking") {
      return "Checking connection";
    }
    if (connectionStatus === "failed") {
      return "Connection failed";
    }
    return "Not connected";
  })();
  const diagnosticLogs = [
    ...serverLogs.map((entry) => ({
      id: `server-${entry.id}`,
      type: entry.level,
      timestamp: entry.created_at,
      source: "server",
      message: `${entry.event}: ${entry.message}`,
      metadata: formatLogMetadata(entry.metadata),
    })),
    ...activity.map((entry) => ({
      id: `browser-${entry.id}`,
      type: entry.type,
      timestamp: entry.timestamp,
      source: "browser",
      message: entry.message,
      metadata: "",
    })),
  ].sort(
    (first, second) =>
      new Date(first.timestamp).getTime() - new Date(second.timestamp).getTime(),
  );

  return (
    <>
      <canvas ref={particleCanvasRef} className={styles.particleCanvas} />

      {!isAuthenticated && (
        <main className={styles.dashboardWrapper}>
          <section className={styles.dashboardCard}>
            <div className={styles.dashboardHeader}>
              <h1>Workflowy MCP</h1>
            </div>

            <div className={styles.dashboardStatus}>
              <span className={`${styles.dashboardStatusDot} ${styles[statusTone]}`} />
              <span className={styles.dashboardStatusText}>{connectionText}</span>
            </div>

            <form className={styles.loginForm} onSubmit={loginAdmin}>
              <label className={styles.inputGroup}>
                <span>Admin Secret</span>
                <input
                  type="password"
                  value={adminSecret}
                  onChange={(event) => setAdminSecret(event.target.value)}
                  placeholder="ADMIN_SECRET"
                  disabled={!adminStatus?.admin_configured || isAuthBusy}
                />
              </label>
              <button
                className={styles.dashboardSettingsButton}
                disabled={!adminStatus?.admin_configured || !adminSecret || isAuthBusy}
                type="submit"
              >
                Unlock Console
              </button>
            </form>

            {authMessage && <p className={styles.loginMessage}>{authMessage}</p>}
            {adminStatus && !adminStatus.admin_configured && (
              <p className={styles.loginMessage}>Set ADMIN_SECRET in Vercel to enable the web console.</p>
            )}
          </section>
        </main>
      )}

      {isAuthenticated && appMode === "dashboard" && (
        <main className={styles.dashboardWrapper}>
          <section className={styles.dashboardCard}>
            <div className={styles.dashboardHeader}>
              <h1>Workflowy MCP</h1>
            </div>

            <div className={styles.dashboardStatus}>
              <span className={`${styles.dashboardStatusDot} ${styles[statusTone]}`} />
              <span className={styles.dashboardStatusText}>{connectionText}</span>
            </div>

            <div className={styles.dashboardInfoGrid}>
              <div className={styles.dashboardInfoItem}>
                <span className={styles.dashboardInfoLabel}>Version</span>
                <span className={styles.dashboardInfoValue}>v{adminStatus?.version ?? "0.1.0"}</span>
              </div>
              <div className={styles.dashboardInfoItem}>
                <span className={styles.dashboardInfoLabel}>Cache</span>
                <span className={styles.dashboardInfoValue}>
                  {cacheStatus
                    ? `${cacheStatus.node_count.toLocaleString()} nodes`
                    : adminStatus?.database_configured
                      ? "Ready"
                      : "Database missing"}
                </span>
              </div>
            </div>

            <div className={styles.dashboardActionRow}>
              <button
                className={styles.dashboardSettingsButton}
                onClick={() => setAppMode("settings")}
                type="button"
              >
                Edit Settings
              </button>
              <button
                className={styles.dashboardSecondaryButton}
                onClick={logoutAdmin}
                type="button"
              >
                Lock
              </button>
            </div>
          </section>

          <a
            className={styles.dashboardGithubLink}
            href="https://github.com/rodolfo-terriquez/workflowy-mcp"
            target="_blank"
            rel="noopener noreferrer"
            title="View on GitHub"
            aria-label="View on GitHub"
          >
            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        </main>
      )}

      {isAuthenticated && appMode === "settings" && (
    <main className={styles.appLayout}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <button
            className={styles.sidebarBackButton}
            onClick={() => setAppMode("dashboard")}
            type="button"
          >
            ← Back to Dashboard
          </button>
          <div>
            <h1>Workflowy MCP</h1>
            <p>Remote console</p>
          </div>
        </div>

        <nav className={styles.sidebarNav}>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`${styles.navItem} ${activeSection === item.id ? styles.active : ""}`}
              onClick={() => setActiveSection(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={`${styles.statusDot} ${styles[statusTone]}`} />
          <span>{connectionText}</span>
        </div>
      </aside>

      <section className={styles.mainContent}>
        <div className={styles.container}>
          {activeSection === "connection" && (
            <>
              <Header title="Connection" subtitle="Verify the server-side credentials and deployed MCP endpoint." />
              <div className={styles.gridTwo}>
                <label className={styles.inputGroup}>
                  <span>Endpoint</span>
                  <input value={endpoint} readOnly />
                </label>
                <label className={styles.inputGroup}>
                  <span>Status</span>
                  <input value={connectionStatus} readOnly />
                </label>
              </div>
              <div className={styles.buttonRow}>
                <button className={styles.primaryButton} onClick={testConnection} disabled={isBusy || !canCallMcp} type="button">
                  Test Connection
                </button>
                <button className={styles.secondaryButton} onClick={() => refreshAdminSession()} disabled={isBusy} type="button">
                  Refresh Status
                </button>
                <button className={styles.dangerButton} onClick={logoutAdmin} type="button">
                  Lock Console
                </button>
              </div>

              <div className={styles.summaryGrid}>
                <Metric label="Endpoint" value={endpoint ? "configured" : "missing"} />
                <Metric label="MCP Secret" value={adminStatus?.mcp_access_secret_configured ? "configured" : "missing"} />
                <Metric label="Workflowy Key" value={adminStatus?.workflowy_api_key_configured ? "server-side" : "missing"} />
                <Metric label="Database" value={adminStatus?.database_configured ? "configured" : "missing"} />
              </div>
            </>
          )}

          {activeSection === "setup" && (
            <>
              <Header title="Setup" subtitle="Generate the remote MCP configuration for your client." />
              <p>ChatGPT: choose OAuth and enter this server’s /api/mcp URL. Leave Client ID and Client Secret blank for automatic registration, then approve the connection as the administrator.</p>
              <p><a href="/oauth/connections">Manage or revoke ChatGPT connections</a></p>
              <div className={styles.tabs}>
                <button className={`${styles.tab} ${setupTab === "claude" ? styles.tabActive : ""}`} onClick={() => setSetupTab("claude")} type="button">
                  Claude
                </button>
                <button className={`${styles.tab} ${setupTab === "generic" ? styles.tabActive : ""}`} onClick={() => setSetupTab("generic")} type="button">
                  Header
                </button>
                <button className={`${styles.tab} ${setupTab === "json" ? styles.tabActive : ""}`} onClick={() => setSetupTab("json")} type="button">
                  JSON
                </button>
              </div>
              <div className={styles.buttonRow}>
                <button className={styles.secondaryButton} onClick={() => copyText(activeConfig, "Configuration")} type="button">
                  Copy
                </button>
              </div>
              <pre className={styles.codeBlock}>{activeConfig}</pre>
            </>
          )}

          {activeSection === "tools" && (
            <>
              <Header title="Tools" subtitle="Customize how AI clients understand and use the hosted Workflowy tools." />
              <div className={styles.toolSection}>
                <label className={styles.inputGroup}>
                  <span>Server Instructions</span>
                  <textarea
                    className={styles.serverInstructionsField}
                    value={serverInstructionsDraft}
                    onChange={(event) => setServerInstructionsDraft(event.target.value)}
                    rows={16}
                    placeholder={mcpSettings?.default_server_instructions ?? "Load settings to edit instructions."}
                  />
                </label>
                <div className={styles.buttonRow}>
                  <button className={styles.primaryButton} onClick={saveMcpSettings} disabled={isBusy || !mcpSettings || !hasSettingsChanges} type="button">
                    Save Customizations
                  </button>
                  <button className={styles.secondaryButton} onClick={resetServerInstructions} disabled={isBusy || !mcpSettings} type="button">
                    Reset Instructions
                  </button>
                  <button className={styles.secondaryButton} onClick={() => refreshMcpSettings()} disabled={isBusy} type="button">
                    Reload Settings
                  </button>
                </div>
              </div>

              <div className={styles.toolSection}>
                <div className={styles.sectionHeaderRow}>
                  <h2>Tool Descriptions</h2>
                  <button className={styles.secondaryButton} onClick={saveMcpSettings} disabled={isBusy || !mcpSettings || !hasSettingsChanges} type="button">
                    Save
                  </button>
                </div>
                <div className={styles.toolEditorList}>
                  {settingsToolNames.map((name) => (
                    <article key={name} className={styles.toolEditorItem}>
                      <button className={styles.toolEditorHeader} onClick={() => toggleToolExpanded(name)} type="button">
                        <span>{expandedTools.has(name) ? "▾" : "▸"}</span>
                        <strong>{name}</strong>
                        {isToolCustomized(name) && <em>customized</em>}
                      </button>
                      {expandedTools.has(name) && (
                        <div className={styles.toolEditorBody}>
                          <textarea
                            value={toolDescriptionDrafts[name] ?? defaultToolDescriptions[name]}
                            onChange={(event) => updateToolDescription(name, event.target.value)}
                            rows={8}
                          />
                          <button className={styles.secondaryButton} onClick={() => resetToolDescription(name)} disabled={!isToolCustomized(name)} type="button">
                            Reset
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeSection === "bookmarks" && (
            <>
              <Header title="Bookmarks" subtitle="Manage remote bookmarks stored in Neon for this Workflowy key." />
              <div className={styles.gridTwo}>
                <label className={styles.inputGroup}>
                  <span>Name</span>
                  <input value={bookmarkName} onChange={(event) => setBookmarkName(event.target.value)} placeholder="ai_instructions" />
                </label>
                <label className={styles.inputGroup}>
                  <span>Node ID</span>
                  <input value={bookmarkNodeId} onChange={(event) => setBookmarkNodeId(event.target.value)} placeholder="inbox, today, or a node id" />
                </label>
              </div>
              <label className={styles.inputGroup}>
                <span>Context</span>
                <textarea value={bookmarkContext} onChange={(event) => setBookmarkContext(event.target.value)} rows={3} />
              </label>
              <div className={styles.buttonRow}>
                <button className={styles.primaryButton} onClick={saveBookmark} disabled={isBusy || !bookmarkName || !bookmarkNodeId || !canCallMcp} type="button">
                  Save Bookmark
                </button>
                <button className={styles.secondaryButton} onClick={() => refreshBookmarks()} disabled={isBusy || !canCallMcp} type="button">
                  Refresh
                </button>
              </div>
              <div className={styles.list}>
                {bookmarks.length === 0 ? (
                  <EmptyState text="No bookmarks saved yet." />
                ) : (
                  bookmarks.map((bookmark) => (
                    <article key={bookmark.name} className={styles.itemCard}>
                      <div className={styles.itemHeader}>
                        <h2>{bookmark.name}</h2>
                        <button className={styles.dangerButtonSmall} onClick={() => deleteBookmark(bookmark.name)} type="button">
                          Delete
                        </button>
                      </div>
                      <code>{bookmark.node_id}</code>
                      <p>{bookmark.context || "No context set."}</p>
                    </article>
                  ))
                )}
              </div>
            </>
          )}

          {activeSection === "cache" && (
            <>
              <Header title="Cache" subtitle="Sync and search the Neon-backed Workflowy cache." />
              <div className={styles.summaryGrid}>
                <Metric label="Nodes" value={cacheStatus ? cacheStatus.node_count.toLocaleString() : "unknown"} />
                <Metric label="Last Sync" value={cacheStatus?.last_synced_at === "never" || !cacheStatus ? "never" : new Date(cacheStatus.last_synced_at).toLocaleString()} />
                <Metric label="Freshness" value={cacheStatus ? (cacheStatus.is_stale ? "stale" : "fresh") : "unknown"} />
                <Metric label="Sync" value={cacheStatus?.sync_in_progress ? "running" : "idle"} />
              </div>
              <div className={styles.buttonRow}>
                <button className={styles.primaryButton} onClick={syncNodes} disabled={isBusy || !canCallMcp} type="button">
                  Sync Nodes
                </button>
                <button className={styles.secondaryButton} onClick={() => refreshCacheStatus()} disabled={isBusy || !canCallMcp} type="button">
                  Refresh Status
                </button>
              </div>
              <div className={styles.searchRow}>
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search Workflowy cache" />
                <button className={styles.secondaryButton} onClick={searchNodes} disabled={isBusy || !searchQuery || !canCallMcp} type="button">
                  Search
                </button>
              </div>
              <div className={styles.list}>
                {searchResults?.length ? (
                  searchResults.map((result) => (
                    <article key={result.id} className={styles.itemCard}>
                      <h2>{result.name || "(Untitled)"}</h2>
                      <p>{result.path_display || result.id}</p>
                      <div className={styles.metaRow}>
                        <span>{result.children_count ?? 0} children</span>
                        <span>score {result.relevance_score ?? "n/a"}</span>
                      </div>
                    </article>
                  ))
                ) : (
                  <EmptyState text="Search results will appear here." />
                )}
              </div>
            </>
          )}

          {activeSection === "diagnostics" && (
            <>
              <Header title="Diagnostics" subtitle="Server events and recent console activity in one timeline." />
              <div className={styles.sectionHeaderRow}>
                <h2>Logs</h2>
                <div className={styles.inlineActions}>
                  <button className={styles.secondaryButton} onClick={() => {
                    void refreshAdminSession();
                    void refreshCacheStatus(false);
                    void refreshServerLogs(false);
                  }} disabled={isBusy} type="button">
                    Refresh
                  </button>
                  <button className={styles.dangerButton} onClick={clearServerLogs} disabled={isBusy || !serverLogs.length} type="button">
                    Clear Server Logs
                  </button>
                  <button className={styles.secondaryButton} onClick={() => setActivity([])} type="button">
                    Clear Activity
                  </button>
                </div>
              </div>
              <div className={styles.logContainer}>
                {diagnosticLogs.length === 0 ? (
                  <div className={styles.logEntry}>No logs yet.</div>
                ) : (
                  diagnosticLogs.map((entry) => (
                    <div key={entry.id} className={`${styles.logEntry} ${styles[entry.type]}`}>
                      [{formatTime(entry.timestamp)}] {entry.source}: {entry.message}
                      {entry.metadata && (
                        <code>{entry.metadata}</code>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
      )}
    </>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className={styles.header}>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className={styles.emptyState}>{text}</div>;
}

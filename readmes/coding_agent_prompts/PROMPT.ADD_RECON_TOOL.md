# NEW TOOL IN RECON PIPELINE

Integrate **[TOOL_NAME]** into the RedAmon recon pipeline.

### Critical Rules

- **Python import safety**: The `recon_orchestrator` container volume-mounts source code (`./recon_orchestrator:/app`). Adding a new Python `import` that isn't already installed in the container image will **crash-loop** the service. Before importing any package, verify it exists in `recon_orchestrator/requirements.txt` or the `recon_orchestrator/Dockerfile`. If it's missing, add it and rebuild: `docker compose build recon-orchestrator`.
- **Don't break existing tools**: Adding a new tool must NOT modify the behavior, output format, or settings of any existing tool. If you change a shared file (e.g., `recon/project_settings.py`, `recon/main.py`), verify that all existing tools still work after your changes.
- **Container restart rules**: The `recon_orchestrator` container volume-mounts code — changes are live immediately. The `recon` container is built fresh per scan job, so Dockerfile changes require `docker compose build recon`. Frontend changes require `docker compose build webapp`.
- **Build/restart quick reference**:
  - Changed `recon/Dockerfile` or `recon/entrypoint.sh` → `docker compose build recon`
  - Changed `recon_orchestrator/*.py` → `docker compose restart recon-orchestrator`
  - Changed `recon/*.py` → no restart needed (spawned fresh per job), but rebuild if Dockerfile changed
  - Changed `webapp/prisma/schema.prisma` → `docker compose exec webapp npx prisma db push`
  - Changed `webapp/src/**` → `docker compose build webapp && docker compose up -d webapp`

### Phase 1: Research (do NOT write code yet)

1. **Tool research** — Search the tool's official documentation, GitHub repository, and README online. Determine:
   - **Integration type**: Does it have an official Docker image? A Python/Go library? A REST API? Is it CLI-only?
   - **Is it passive or active?** (passive = queries third-party APIs/databases only, active = sends traffic to target)
   - **Dependencies**: Does it need external binaries, wordlists, resolver lists, config files?
   - **API keys**: Does it use API keys? Can it run without them?

2. **Tool output** — Based on the integration type determined above, test the tool and capture its **exact output schema**:
   - If Docker image available: run `docker run <image> -h` to study all CLI flags, then run a real query against a safe target (e.g., `example.com`) with JSON output enabled to capture field names, types, and structure.
   - If API-based: study the API docs, endpoints, request/response schemas.
   - If Python library: study the package docs and return types.

3. **Choose integration pattern** — Based on the research above, match to the existing codebase patterns:
   - **Docker-in-Docker** (Naabu, httpx, Katana, Nuclei, GAU): `subprocess.run(['docker', 'run', '--rm', ...])` — see `recon/port_scan.py`, `recon/resource_enum.py`
   - **Direct subprocess** (Knockpy): `subprocess.run(['toolname', ...])` — see `recon/domain_recon.py`
   - **API/HTTP calls** (crt.sh, HackerTarget, URLScan, Shodan): `requests.get(...)` — see `recon/domain_recon.py`, `recon/urlscan_enrich.py`, `recon/shodan_enrich.py`

   If the tool has an official Docker image, prefer Docker-in-Docker. If it's a simple API, use HTTP calls. Only use direct subprocess if the tool is a pip package already in the container.

3. **Identify the pipeline phase** — Read `recon/main.py` to understand the phase structure. Determine which phase the tool belongs to and where its results feed into.

4. **Settings multi-layer flow** — Every new setting must be added in ALL these layers (miss one and it breaks):
   - `webapp/prisma/schema.prisma` — field with `@default()` and `@map()` (camelCase field, snake_case DB column)
   - `recon/project_settings.py` → `DEFAULT_SETTINGS` dict (SCREAMING_SNAKE_CASE keys)
   - `recon/project_settings.py` → `fetch_project_settings()` mapping (camelCase from DB → SCREAMING_SNAKE_CASE for Python)
   - `recon_orchestrator/api.py` → `GET /defaults` endpoint (include in served defaults)
   - `recon_orchestrator/api.py` → `RUNTIME_ONLY_KEYS` set (only if the setting should NOT appear in defaults)
   - Frontend section component (with fallback default in `onChange`)
   - **Naming convention**: `tool_setting` (DB column) → `toolSetting` (Prisma/frontend) → `TOOL_SETTING` (Python)

5. **Frontend settings page** — Study `webapp/src/components/projects/ProjectForm/ProjectForm.tsx` to find which tab the tool belongs to. Study existing section components in `webapp/src/components/projects/ProjectForm/sections/` — each has: collapsible header, toggle, description, badges (Passive/Active), conditional parameter inputs, and `NodeInfoTooltip` from `nodeMapping.ts`. Study how API key checks work in `ShodanSection.tsx` and `UrlscanSection.tsx` if the tool needs keys.

6. **API key handling** — Determine if the tool uses API keys (for external data sources, premium features, higher rate limits, etc.). If yes: check if the tool works **without** API keys (degraded/limited mode) and **with** them (full coverage). Follow the existing pattern: API keys are stored in the `UserSettings` model in Prisma (global, per-user, NOT per-project). At runtime, fetch via `_fetch_user_api_key()` in `recon/project_settings.py` using `?internal=true` for unmasked values. In the frontend section component, check key status via `/api/users/{userId}/settings` and show an info banner (like `ShodanSection.tsx` and `UrlscanSection.tsx` do): if key is set, use it; if empty, tool runs without it (reduced results but still functional). Study `webapp/src/app/api/users/[id]/settings/route.ts` for the GET/PUT pattern and the key masking logic.

7. **Graph DB integration** — Read `readmes/GRAPH.SCHEMA.md` for the full node/relationship schema. `graph_db/neo4j_client.py` is now a **thin orchestrator** (30 lines) — the actual graph methods live in the mixin files under `graph_db/mixins/`. For a new OSINT enrichment tool, the method goes in `graph_db/mixins/osint_mixin.py`. For a new core recon phase, it goes in `graph_db/mixins/recon_mixin.py`. Find the `update_graph_from_*()` method in the relevant mixin that is closest to the new tool's output type. Understand MERGE keys (always `(name/address, user_id, project_id)`), `ON CREATE SET` vs unconditional `SET`, and deduplication with existing nodes from other tools.

8. **RoE (Rules of Engagement) scope** — Study how the RoE settings affect tool execution. Check `recon/main.py` and the RoE tab in `ProjectForm.tsx` to understand how scope restrictions (allowed domains, IPs, excluded targets) are enforced. Determine if the new tool's output could include out-of-scope results (e.g., subdomains of unrelated domains, IPs outside allowed ranges) and ensure results are filtered against the RoE before being stored. Study how existing tools handle scope filtering — e.g., `domain_recon.py` splits results into in-scope `subdomains` vs out-of-scope `external_domains`.

9. **Output format** — Study how the tool's results merge into the combined recon JSON output in `recon/main.py`. Determine if results extend an existing section (e.g., subdomains into `discover_subdomains()` return) or need a new section in the combined output.

10. **Report integration** — The reports page (`/reports`) generates HTML reports from Neo4j data. Study the report pipeline to plan how the new tool's findings will appear:
   - `webapp/src/lib/report/reportData.ts` — contains query functions that pull tool data from Neo4j (e.g., `queryTrufflehog`, `querySecrets`, `queryJsRecon`, `queryOtx`), the `ReportData` interface, the `gatherReportData()` orchestrator, and the **risk score** calculation. Each tool has a dedicated `queryX()` function that runs Cypher queries filtered by `{project_id: $pid}` and returns structured data (totals, breakdowns by severity/type, and capped findings lists — typically max 50 items).
   - `webapp/src/lib/report/reportTemplate.ts` — contains `renderX()` functions that produce conditional HTML sections (only rendered if findings > 0), and the dynamic TOC builder that includes/excludes sections based on data availability.
   - `webapp/src/app/api/projects/[id]/reports/route.ts` — the POST handler that orchestrates data gathering, optional LLM narrative generation (via `condenseForAgent()`), and HTML generation. The `condenseForAgent()` function sends a summarized subset (15-20 items per tool) to the agent service for narrative text.
   - **Risk score**: Every tool contributes a weighted score to the overall risk metric. Study the `rawRisk` calculation in `reportData.ts` to determine the appropriate weight for the new tool (e.g., Trufflehog: verified=80pts, unverified=30pts; OTX: pulses=20pts, malware=50pts; JsRecon: high/critical=40pts).
   - **Existing pattern summary**: For each tool, there is (1) a TypeScript interface for its findings, (2) a `queryX()` function with Neo4j Cypher, (3) a section in the `ReportData` interface, (4) a call in `gatherReportData()`, (5) a `renderX()` function, (6) a TOC entry, (7) a risk score contribution, and (8) a condensed payload in `condenseForAgent()`.

11. **Parallelization opportunities (fan-out / fan-in)** — Study the execution flow in `recon/main.py` and determine whether the new tool can run **in parallel** with other tools in the same phase. Look for:
   - **Fan-out**: Can this tool be launched concurrently with other independent tools that share the same inputs? For example, multiple subdomain discovery sources (crt.sh, HackerTarget, Subfinder) all take the root domain as input and can run simultaneously. If the new tool has no dependency on the output of another tool in the same phase, it should fan out alongside them (e.g., using `concurrent.futures.ThreadPoolExecutor` or `asyncio.gather`).
   - **Fan-in**: After parallel execution, results from multiple tools must be merged/deduplicated before the next phase consumes them. Determine how the new tool's results join the fan-in point — does it contribute to an existing aggregation (e.g., a shared `subdomains` set) or require a new merge step?
   - **Dependencies that block parallelization**: If the tool depends on results from a prior tool (e.g., port scanning needs discovered hosts, URL crawling needs live subdomains), it must wait for that phase to complete — do NOT parallelize across dependency boundaries.
   - Check existing parallel patterns in the codebase and follow the same executor/threading approach rather than introducing a new concurrency mechanism.

### Phase 2: Implementation checklist

- [ ] Tool runner function in the appropriate `recon/*.py` file following the **enrichment module contract**:
  - Main function `run_X_enrichment(combined_result: dict, settings: dict) -> dict` — mutates `combined_result` in place by writing to `combined_result["toolname"]` and returns it
  - The top-level key **must match** the tool identifier used everywhere else in the pipeline (e.g. `combined_result["virustotal"]`, `combined_result["censys"]`) — never abbreviate or vary the name
  - Isolated wrapper `run_X_enrichment_isolated(combined_result: dict, settings: dict) -> dict` — shallow-copies `combined_result`, calls the main runner on the copy, returns only the tool's payload dict (e.g. `snapshot.get("toolname", {})`). This is the **actual call path** used by GROUP 3b fan-out in `recon/main.py` and by all unit tests — it must be present
  - If the tool uses API keys: follow the `_effective_key(api_key, key_rotator)` pattern. Copy this helper verbatim from an existing module (e.g. `censys_enrich.py`). Add a `TOOL_KEY_ROTATOR` settings key alongside `TOOL_API_KEY` so key rotation is supported from day one
- [ ] Settings keys in `recon/project_settings.py` (`DEFAULT_SETTINGS` + `fetch_project_settings()` mapping)
- [ ] Prisma schema fields in `webapp/prisma/schema.prisma`
- [ ] Run `docker compose exec webapp npx prisma db push` (never use `prisma migrate`)
- [ ] Docker image added to `recon/entrypoint.sh` IMAGES array (if Docker-based)
- [ ] Docker image setting (e.g. `TOOL_DOCKER_IMAGE`) in `DEFAULT_SETTINGS` (if Docker-based)
- [ ] Temp files in `/tmp/redamon/`, cleaned up in `finally` block
- [ ] Frontend section component in `webapp/src/components/projects/ProjectForm/sections/`
- [ ] Section imported and rendered in `ProjectForm.tsx` under the correct tab
- [ ] Section exported from `sections/index.ts`
- [ ] `SECTION_INPUT_MAP` and `SECTION_NODE_MAP` updated in `nodeMapping.ts` (if new section)
- [ ] `/defaults` endpoint updated in `recon_orchestrator/api.py`
- [ ] Graph DB: add or extend the appropriate `update_graph_from_*()` method in the correct mixin — `graph_db/mixins/osint_mixin.py` for OSINT enrichment tools, `graph_db/mixins/recon_mixin.py` for core recon phases. Do NOT edit `graph_db/neo4j_client.py` directly — it is a thin orchestrator that only imports the mixins.
- [ ] **Graph completeness**: Cross-check every field stored in the enrichment output dict (`combined_result["toolname"]`) against the `update_graph_from_*()` method — every collected field must be written to a node property or relationship. Silently dropping a field (collecting it in the enrichment module but never reading it in the graph method) is a data loss bug. If a field doesn't fit any existing node, either map it to the closest existing property or document explicitly why it is intentionally omitted.
- [ ] **Graph node reuse**: Before creating new node labels, check if the tool's output can be mapped to **existing** node types in `readmes/GRAPH.SCHEMA.md`. For example, discovered hostnames should go into `Subdomain`, not a new label. Only introduce new node labels if the data genuinely doesn't fit any existing type.
- [ ] **Schema sync (mandatory for every tool)**: If the tool writes **any** data to Neo4j — new node labels, new relationships, or new properties on existing nodes — update **ALL** of these. This applies even when adding properties to existing node types (e.g., new enrichment flags on `IP`, new fields on `Service`):
  1. `readmes/GRAPH.SCHEMA.md` — the canonical schema reference
  2. `agentic/prompts/base.py` — the `TEXT_TO_CYPHER_SYSTEM` prompt (LLM-facing schema for natural-language-to-Cypher). Missing this will cause the AI agent to generate incorrect Cypher or fail to expose the new data in queries.
  3. `webapp/src/app/graph/config/colors.ts` — add entry to `NODE_COLORS` dict with an appropriate color for the new node type (read existing color families as reference)
  4. `webapp/src/app/graph/config/colors.ts` — add entry to `NODE_SIZES` if the new node type needs a non-default size
  5. `webapp/src/app/graph/components/DataTable/DataTableToolbar.tsx` — add the new node type to the type filter dropdown so users can filter by it
  6. `webapp/src/app/graph/components/PageBottomBar/PageBottomBar.tsx` — add the new node type to the legend if applicable
- [ ] **Report data layer** (`webapp/src/lib/report/reportData.ts`):
  1. Add a TypeScript interface for the tool's findings (e.g., `MyToolRecord`) with all fields queried from Neo4j
  2. Add a new section to the `ReportData` interface (e.g., `myTool: { totalFindings: number; bySeverity: ...; findings: MyToolRecord[] }`)
  3. Create a `queryMyTool(session, pid)` function with Cypher queries — must filter by `{project_id: $pid}`, include summary counts + breakdowns, and cap detailed findings (typically 50 items)
  4. Call the new query function in `gatherReportData()` and include its result in the returned `ReportData` object
  5. Add the tool's weighted contribution to the `rawRisk` score calculation — choose weights consistent with existing tools (study the risk score block for reference)
  6. If the tool produces secrets/credentials, also add its count to the `metrics.secretsExposed` total
- [ ] **Report template** (`webapp/src/lib/report/reportTemplate.ts`):
  1. Create a `renderMyTool(data: ReportData): string` function that returns an HTML section — must be **conditional** (return empty string if no findings), include a `page-break` div, and use a unique `id` for the section anchor
  2. Add the section to the **dynamic TOC** builder (look for `dynamicSections.push(...)`) — only include if findings > 0
  3. Call `renderMyTool(data)` in the main `generateReportHtml()` function alongside the other render calls
- [ ] **Report LLM condensing** (`webapp/src/app/api/projects/[id]/reports/route.ts`):
  1. Add the tool's summarized data to the `condenseForAgent()` payload — include totals, breakdowns, and a capped subset of findings (15-20 items max) so the LLM can generate narrative text about the tool's results
- [ ] If tool needs API keys: add field to `UserSettings` model in Prisma, fetch at runtime via `_fetch_user_api_key()`, show key status banner in frontend section
- [ ] If tool is active (sends traffic to target): add overrides in `apply_stealth_overrides()` in `recon/project_settings.py`
- [ ] If tool is involved in subdomain enumeration: results may include out-of-scope subdomains (e.g., related but not under the target root domain). These must be split into in-scope `subdomains` vs `external_domains` — follow the existing pattern in `recon/domain_recon.py` where discovered subdomains are checked against the target domain and out-of-scope entries are collected separately as external domains
- [ ] **Logging format**: All `print()` log lines MUST follow the standard `[symbol][ToolName] message` format used throughout the recon pipeline. The symbol prefix indicates the log level/type:
   - `[*][ToolName]` — informational / progress (e.g., `[*][Naabu] Starting scan...`)
   - `[+][ToolName]` — success / positive result (e.g., `[+][Subfinder] Found 42 subdomains`)
   - `[-][ToolName]` — negative result or skipped (e.g., `[-][crt.sh] Disabled — skipping`)
   - `[!][ToolName]` — error / warning (e.g., `[!][Amass] Error: timeout`)
   - `[✓][ToolName]` — completed / verified (e.g., `[✓][Naabu] Image already available`)
   - `[⚡]` — special mode indicator (e.g., `[⚡] BRUTEFORCE MODE`)

   See `recon/domain_recon.py`, `recon/port_scan.py`, `recon/whois_recon.py` for reference. Never use bare `print()` without the `[symbol][ToolName]` prefix.
- [ ] **Recon Presets** (`webapp/src/lib/recon-presets/presets/*.ts`):
  Hardcoded parameter presets exist in `webapp/src/lib/recon-presets/presets/`. Each preset is a partial dictionary of camelCase project settings that override defaults when a user selects it. When adding a new tool:
  1. Review EVERY preset file in the `presets/` folder
  2. For each preset, decide: should this new tool be **enabled or disabled** given the preset's stated goal? Read the preset's `fullDescription` to understand its intent (e.g., "JS Secret Miner" is JS-focused and disables irrelevant tools)
  3. If the tool should be disabled in a preset, add `toolEnabled: false` to that preset's `parameters` object
  4. If the tool should be enabled with non-default settings (e.g., higher limits, specific mode), add those parameters to the preset
  5. If the tool uses default settings and the preset doesn't need to change it, do NOT add it -- missing keys automatically inherit from defaults (safe merge)
  6. The preset registry is at `webapp/src/lib/recon-presets/index.ts` -- no changes needed there unless adding a new preset
- [ ] Error handling: try/except with timeout, Docker/binary not found, API errors — follow existing patterns
- [ ] Build and test: `docker compose build recon` then run a scan

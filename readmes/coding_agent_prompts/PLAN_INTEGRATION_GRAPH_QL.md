# Integration Plan — GraphQL Security Scanner

Closes the gap between PR #93 (`feat: add GraphQL security testing module`) and **full conformance** to both:

- [`PROMPT.ADD_RECON_TOOL.md`](./PROMPT.ADD_RECON_TOOL.md) — full-pipeline recon tool integration
- [`PROMPT.ADD_PARTIAL_RECON.md`](./PROMPT.ADD_PARTIAL_RECON.md) — on-demand partial recon support

PR #93 delivers the Python backend + graph mixin but stops at the Python boundary. ~70% of the required webapp / DB / graph-schema / report / preset / partial-recon surface is missing. This plan enumerates every remaining change with exact file paths, existing anchors to mirror, and the order of operations.

---

## 0. Tool Specification (from the partial-recon prompt's required table)

| Field | Value |
|-------|-------|
| **Tool name / id** | `GraphqlScan` (CamelCase id everywhere — `nodeMapping.ts`, `WORKFLOW_TOOLS.id`, `WorkflowNodeModal` switch, `partial_recon.py` dispatch, `PARTIAL_RECON_SUPPORTED_TOOLS`) |
| **Display label** | `GraphQL Scan` |
| **Input nodes** | `['BaseURL', 'Endpoint']` *(decision locked — Parameter dropped to keep the node green when parameter tools are off; code still reads `resource_enum.parameters` as a bonus signal, no graph dependency)* |
| **Output nodes** | `['Vulnerability', 'Endpoint']` *(Endpoint because the mixin enriches existing Endpoint nodes — keep it in `SECTION_NODE_MAP` to draw the edge)* |
| **Enriches** | `['Endpoint']` *(new flags `is_graphql`, `graphql_introspection_enabled`, `graphql_schema_hash`, etc. on existing Endpoint nodes — goes in `SECTION_ENRICH_MAP`)* |
| **Pipeline group** | **Group 6** (Vuln Scanning) — badge `'active'`. It sends live introspection traffic to the target; co-lives with Nuclei. **Do NOT keep the PR's invented "6b"** — folding into Group 6 matches the prompt's documented phase table. |
| **Partial-recon user inputs** | **None** — inputs are BaseURL + Endpoint (both graph-only types per `PROMPT.ADD_PARTIAL_RECON.md` section "How input nodes determine the modal UI"). User can still provide `GRAPHQL_ENDPOINTS` via the settings form; partial recon uses the graph + settings, no extra textareas. |
| **New data node types** | **None** — reuses existing `Endpoint`, `Vulnerability`, `BaseURL`. No changes to `TRANSITIONAL_DATA_NODES` / `DATA_NODE_CATEGORIES` / `getDataPlacement()`. |
| **New relationships** | **None** beyond existing `BaseURL -[:HAS_ENDPOINT]-> Endpoint` and `Endpoint -[:HAS_VULNERABILITY]-> Vulnerability` (or whatever the mixin already emits — verify in step 5.1). |
| **API keys** | None (auth is per-project bearer/cookie/custom header from settings, stored inline, not in `UserSettings`). So **`apiKeysTemplate.ts` is N/A**. |
| **Docker image** | None — pure Python using `requests`. **No `entrypoint.sh IMAGES` change, no `*_DOCKER_IMAGE` setting.** |
| **Active / passive** | **Active** (sends queries to target). Already handled by `apply_stealth_overrides()` in the PR. |

---

## 1. Snapshot — What PR #93 already did (DO NOT REDO)

Leave these alone, only amend if the step below calls it out.

| Area | File | Status |
|---|---|---|
| Enrichment module | [recon/graphql_scan/__init__.py](recon/graphql_scan/__init__.py), `scanner.py`, `discovery.py`, `introspection.py`, `auth.py`, `normalizers.py` | ✅ Exports `run_graphql_scan` + `run_graphql_scan_isolated` |
| `DEFAULT_SETTINGS` | [recon/project_settings.py:508-528](recon/project_settings.py#L508) | ✅ 17 `GRAPHQL_*` keys |
| `fetch_project_settings()` mapping | [recon/project_settings.py:1099-1123](recon/project_settings.py#L1099) | ✅ camelCase → UPPER_SNAKE_CASE |
| `apply_stealth_overrides()` | [recon/project_settings.py:1353-1362](recon/project_settings.py#L1353) | ✅ Mutations/proxy off, rate=2, concurrency=1 |
| `RATE_LIMIT_KEYS` cap | [recon/project_settings.py:1131](recon/project_settings.py#L1131) | ✅ `GRAPHQL_RATE_LIMIT` |
| Pipeline wiring | [recon/main.py:1370-1385](recon/main.py#L1370) | ⚠️ Works but **relabel "GROUP 6b" → fold into GROUP 6** (see step 2) |
| Graph mixin | [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) | ✅ `update_graph_from_graphql_scan()` enriches Endpoint + creates Vulnerability |
| Neo4jClient MRO | [graph_db/neo4j_client.py](graph_db/neo4j_client.py) | ✅ `GraphQLMixin` appended |
| Unit tests | [recon/tests/test_graphql_scan.py](recon/tests/test_graphql_scan.py) | ✅ 599 lines, 25 tests |
| Logging format | all module files | ⚠️ Mostly OK — **one line uses `[RoE][GraphQL]`** ([recon/graphql_scan/discovery.py:746](recon/graphql_scan/discovery.py#L746)) which doesn't match the prompt's symbol table. Fix to `[-][GraphQL]` or `[*][GraphQL]` — see §11. |
| New Python deps | — | ✅ None (stdlib + `requests` already in `recon/requirements.txt`) |
| Temp files | — | ✅ None — scanner is fully in-memory (no `/tmp/redamon/` writes, no `finally`-block cleanup needed). Prompt checklist item N/A. |
| Graph completeness | [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) | ❌ **Data loss: subscriptions discarded**. Scanner collects `operations['subscriptions']` + `subscriptions_count` ([recon/graphql_scan/introspection.py:1012](recon/graphql_scan/introspection.py) and [scanner.py:1545](recon/graphql_scan/scanner.py)) but the mixin only writes `graphql_queries` and `graphql_mutations`. Fix in §6.4. |

---

## 2. Pipeline placement fix (small but do it first)

**Problem**: PR labels the stage `GROUP 6b` — not in the prompt's phase table.

**Fix**: In [recon/main.py:1370-1385](recon/main.py#L1370):
- Rename the banner `"[*][Pipeline] GROUP 6b: GraphQL Security Testing"` → `"[*][Pipeline] GROUP 6: GraphQL Security Testing"` (part of Group 6 alongside Nuclei).
- Fold into the Group 6 fan-out described in **§2.5** — do NOT keep GraphQL as a sequential sub-stage after Nuclei.
- The stats-printing block at [recon/main.py:1458-1470](recon/main.py#L1458) can stay where it is (final summary section).

**Why**: The prompt's Group 6 is labelled "Vuln Scanning" — GraphQL introspection/mutation/proxy testing *is* vuln scanning. And the prompt explicitly forbids phase invention.

**Restart**: `docker compose --profile tools build recon`.

---

## 2.5 Parallelize GraphQL with Nuclei inside Group 6 (perf win, do with §2)

**Problem**: Sequentially running Nuclei → GraphQL wastes wall-clock. Nuclei dominates Group 6 (typically 10-60+ min with DAST/fuzzing); GraphQL adds another 1-5 min **on top** when run sequentially. They have **zero data dependency on each other** — both read BaseURL/Endpoint/Technology and both write Vulnerability.

**Fix**: Restructure Group 6 into two phases — **Phase A** fans out independent active scanners, **Phase B** runs the CVE-dependent MITRE enrichment.

### Dependency matrix for Group 6

| Stage | Traffic | Reads from combined_result | Writes to |
|---|---|---|---|
| Nuclei | Active (target) | `http_probe`, `resource_enum`, Technology nodes | `vuln_scan`, Vulnerability, CVE |
| GraphQL | Active (target) | `http_probe.by_url`, `resource_enum.endpoints`, `resource_enum.parameters`, `js_recon.findings` | `graphql_scan`, Vulnerability, Endpoint enrichment |
| MITRE | Passive (MITRE API) | CVE nodes produced by Nuclei | MitreData, Capec |

→ **Nuclei ‖ GraphQL** is safe. **MITRE** must run after Nuclei.

### Implementation sketch ([recon/main.py](recon/main.py))

Replace the current sequential Group 6 block (around [recon/main.py:1350-1385](recon/main.py#L1350)) with:

```python
from concurrent.futures import ThreadPoolExecutor, as_completed
from recon.graphql_scan import run_graphql_scan_isolated
# assumes run_nuclei has an _isolated wrapper — if not, add one following the
# pattern in recon/censys_enrich.py (deepcopy combined_result, run, return only the tool's key)

# ---------- GROUP 6 Phase A: parallel active vuln scanners ----------
print(f"\n[*][Pipeline] GROUP 6 Phase A: Active Vulnerability Scanning (fan-out)")
print("-" * 40)

active_scanners = {}
if _settings.get('NUCLEI_ENABLED', False):
    active_scanners['vuln_scan'] = run_nuclei_isolated       # produces combined_result['vuln_scan']
if _settings.get('GRAPHQL_SECURITY_ENABLED', False):
    active_scanners['graphql_scan'] = run_graphql_scan_isolated  # produces combined_result['graphql_scan']

if active_scanners:
    with ThreadPoolExecutor(max_workers=len(active_scanners)) as pool:
        futures = {pool.submit(fn, combined_result, _settings): key
                   for key, fn in active_scanners.items()}
        for fut in as_completed(futures):
            key = futures[fut]
            try:
                combined_result[key] = fut.result()
                combined_result["metadata"]["modules_executed"].append(key)
                save_recon_file(combined_result, output_file)
                _graph_update_bg(f"update_graph_from_{key}", combined_result, USER_ID, PROJECT_ID)
            except Exception as e:
                print(f"[!][Pipeline] {key} failed: {e}")
                combined_result["metadata"].setdefault("phase_errors", {})[key] = str(e)
                save_recon_file(combined_result, output_file)

# ---------- GROUP 6 Phase B: sequential CVE enrichment ----------
if _settings.get('MITRE_ENRICHMENT_ENABLED', False) and 'vuln_scan' in combined_result:
    print(f"\n[*][Pipeline] GROUP 6 Phase B: MITRE CVE Enrichment")
    print("-" * 40)
    try:
        add_mitre(combined_result, _settings)
        combined_result["metadata"]["modules_executed"].append("mitre")
        save_recon_file(combined_result, output_file)
        _graph_update_bg("update_graph_from_mitre", combined_result, USER_ID, PROJECT_ID)
    except Exception as e:
        print(f"[!][Pipeline] MITRE failed: {e}")
        combined_result["metadata"].setdefault("phase_errors", {})["mitre"] = str(e)
```

### Requirements / prerequisites for this fan-out

1. **`run_nuclei_isolated()` must exist.** If the current Nuclei runner mutates `combined_result` in place without an `_isolated` wrapper, add one following [recon/censys_enrich.py](recon/censys_enrich.py) — deep-copy input, run, return only `combined_result["vuln_scan"]`. Without isolation, the two threads race on shared dict writes.
2. **`run_graphql_scan_isolated()` already exists** in the PR at [recon/graphql_scan/__init__.py](recon/graphql_scan/__init__.py).
3. **`_graph_update_bg()` must be thread-safe** — it is (it schedules graph updates in a background thread from Neo4jClient, which has connection pooling).
4. **`save_recon_file()` called from multiple threads** — protect with a lock if it's not already. Check [recon/main.py](recon/main.py) for the existing helper; if unlocked, wrap the write in `with _save_lock:` (mirror the pattern used in Group 3b).

### Traffic / RoE considerations

Running two active scanners at once **doubles target-facing RPS** during Group 6. Mitigations (pick one):

| Strategy | How | Trade-off |
|---|---|---|
| **Trust RoE cap** (recommended default) | `ROE_GLOBAL_MAX_RPS` already caps `NUCLEI_RATE_LIMIT` + `GRAPHQL_RATE_LIMIT` independently via [project_settings.py:1131](recon/project_settings.py#L1131). If RoE is enforced (`ROE_ENABLED=True`), each tool is individually capped — combined traffic is 2× the cap but still respects per-request rate limiting and stealth profile. | May exceed RoE RPS on paper; acceptable if cap is set conservatively |
| **Halve per-tool rates when fan-out active** | In a new helper `apply_fanout_overrides(settings)` called before Phase A: if both Nuclei + GraphQL are enabled, `settings['NUCLEI_RATE_LIMIT'] //= 2` and `settings['GRAPHQL_RATE_LIMIT'] //= 2`. | Strict RoE compliance; slight slowdown per tool but still net faster than sequential |
| **Shared semaphore** | Introduce a global `TARGET_RPS_SEMAPHORE` in a new `recon/helpers/rate_limit.py`, acquire it in both tools' HTTP calls. | Strongest guarantee; requires patching both tool runners |

**Default recommendation**: keep existing independent rate caps (option 1). Add a note in `apply_stealth_overrides()` to halve both when `STEALTH_MODE=True` — combined effective rate stays low.

### Save-file race protection

Files being written in parallel from both futures go to the same `output_file`. Add a module-level lock:

```python
import threading
_save_lock = threading.Lock()

def save_recon_file(data, path):
    with _save_lock:
        # existing write logic
```

If there's already a lock, reuse it. If Group 3b doesn't use one, Group 3b has the same latent bug — fix in a separate PR, not this one.

### Expected wall-clock impact

On a typical medium scan:
- **Before** (sequential Group 6): Nuclei 20 min + MITRE 1 min + GraphQL 3 min = **24 min**
- **After** (fan-out): max(Nuclei 20 min, GraphQL 3 min) + MITRE 1 min = **21 min**

GraphQL is fully absorbed into Nuclei's wall-clock. On long Nuclei scans (DAST fuzzing) the savings are proportionally smaller in percent but same absolute ~3 min. On projects where GraphQL discovers many endpoints (large APIs), the savings scale up.

### Testing

Add to [recon/tests/test_partial_recon.py](recon/tests/test_partial_recon.py) **or** a new `recon/tests/test_pipeline_fanout.py`:

1. `test_group6_fanout_nuclei_and_graphql_both_enabled` — assert both tools' output keys present in `combined_result` after Group 6, MITRE ran after both.
2. `test_group6_fanout_graphql_disabled` — only Nuclei runs, no errors from missing GraphQL.
3. `test_group6_fanout_nuclei_exception_does_not_kill_graphql` — simulate Nuclei exception, assert GraphQL still completes and its results are saved, `metadata.phase_errors.vuln_scan` is populated.
4. `test_group6_save_file_no_race` — mock `save_recon_file` to count calls and assert no truncation / interleaved writes.

### Additional fan-out opportunities (out-of-scope for this plan, document for follow-up)

The prompt's phase table claims Group 3b is already "Parallel, independent of GROUP 3/3.5" but in `main.py` it's sequenced *after* Nmap. Real parallel execution with Group 3/3.5 would save another 1-5 min. Not part of this plan — file as separate issue.

**Why this lives in this plan**: because adding GraphQL is the first tool to *force* the Group 6 fan-out decision, it's cleanest to do both changes in one PR. The integration agent implementing §4-§9 will already be touching `main.py` — restructuring Group 6 costs ~50 lines and yields a permanent speedup.

---

## 3. Settings multi-layer flow — add the missing layers

The PR set the Python layer; the DB + orchestrator + frontend layers are missing. **Until these are done, `graphqlSecurityEnabled` always resolves to `False` and the feature is dead.** Do this section before anything else UI-related.

### 3.1 Prisma schema — add 17 fields

File: [webapp/prisma/schema.prisma](webapp/prisma/schema.prisma) — add alongside the `jsRecon*` block (around line 347) following the **exact same** `camelCase @default(...) @map("snake_case")` convention:

```prisma
graphqlSecurityEnabled   Boolean @default(false) @map("graphql_security_enabled")
graphqlIntrospectionTest Boolean @default(true)  @map("graphql_introspection_test")
graphqlMutationTesting   Boolean @default(true)  @map("graphql_mutation_testing")
graphqlProxyTesting      Boolean @default(true)  @map("graphql_proxy_testing")
graphqlSafeMode          Boolean @default(true)  @map("graphql_safe_mode")
graphqlMaxMutationsTest  Int     @default(50)    @map("graphql_max_mutations_test")
graphqlTimeout           Int     @default(30)    @map("graphql_timeout")
graphqlRateLimit         Int     @default(10)    @map("graphql_rate_limit")
graphqlConcurrency       Int     @default(5)     @map("graphql_concurrency")
graphqlAuthType          String  @default("")    @map("graphql_auth_type")
graphqlAuthValue         String  @default("")    @map("graphql_auth_value")
graphqlAuthHeader        String  @default("")    @map("graphql_auth_header")
graphqlEndpoints         String  @default("")    @map("graphql_endpoints")
graphqlDepthLimit        Int     @default(10)    @map("graphql_depth_limit")
graphqlRetryCount        Int     @default(3)     @map("graphql_retry_count")
graphqlRetryBackoff      Float   @default(2.0)   @map("graphql_retry_backoff")
graphqlVerifySsl         Boolean @default(true)  @map("graphql_verify_ssl")
```

**Defaults must match exactly** `DEFAULT_SETTINGS` at [recon/project_settings.py:511-527](recon/project_settings.py#L511) so the Prisma/Python/frontend layers all agree.

Then apply:
```bash
docker compose exec webapp npx prisma db push
```

### 3.2 `recon_orchestrator/api.py` `/defaults` endpoint

File: [recon_orchestrator/api.py:175-199](recon_orchestrator/api.py#L175) (the `RUNTIME_ONLY_KEYS` set).

No new `RUNTIME_ONLY_KEYS` additions (no API keys). The camelCase conversion at lines 206-210 auto-serves everything in `DEFAULT_SETTINGS` — **so no change needed if the file iterates DEFAULT_SETTINGS dynamically**.

✅ Verify by reading the handler: if it dynamically mirrors `DEFAULT_SETTINGS`, nothing to do. If it has a hardcoded list, append all 17 `graphql*` keys. **Read the file to confirm which pattern it uses before editing.**

Restart: `docker compose restart recon-orchestrator`.

---

## 4. Frontend — section + form + tab

### 4.1 New section component

File to create: `webapp/src/components/projects/ProjectForm/sections/GraphqlScanSection.tsx`

**Mirror the structure of** [webapp/src/components/projects/ProjectForm/sections/JsReconSection.tsx](webapp/src/components/projects/ProjectForm/sections/JsReconSection.tsx) (closest analog — active tool, lots of booleans + numeric params, auth config, no API keys in UserSettings). Specifically reuse:

1. **Imports** (lines 3-8 of JsReconSection): `useState`, `useCallback`, icons (swap `Search` → `ServerCog` or `Braces`), `Toggle`, `NodeInfoTooltip`, `Play` from `lucide-react`.
2. **Props interface** (lines 254-260):
   ```tsx
   interface GraphqlScanSectionProps {
     data: Partial<ProjectFormData>
     updateField: <K extends keyof ProjectFormData>(field: K, value: ProjectFormData[K]) => void
     projectId?: string
     mode?: 'create' | 'edit'
     onRun?: () => void
   }
   ```
3. **Header** (lines 389-426) — badge = `Active`:
   ```tsx
   <h2 className={styles.sectionTitle}>
     <ServerCog size={16} />
     GraphQL Scan
     <NodeInfoTooltip section="GraphqlScan" />
     <span className={styles.badgeActive}>Active</span>
   </h2>
   ```
4. **"Run partial recon" button** (lines 399-413) — identical structure, swap `jsReconEnabled` → `graphqlSecurityEnabled` and title → `"Run GraphQL Scan"`.
5. **Body fields** — one input per setting (17 total). Group them:
   - **Master toggle**: `graphqlSecurityEnabled`
   - **Test modules** (4 booleans): `graphqlIntrospectionTest`, `graphqlMutationTesting`, `graphqlProxyTesting`, `graphqlSafeMode`
   - **Execution** (5 numerics): `graphqlMaxMutationsTest`, `graphqlTimeout`, `graphqlRateLimit`, `graphqlConcurrency`, `graphqlDepthLimit`
   - **Retry** (2 numerics): `graphqlRetryCount`, `graphqlRetryBackoff`
   - **TLS** (1 boolean): `graphqlVerifySsl`
   - **Endpoints override** (1 textarea, comma-separated): `graphqlEndpoints` + helper text "Comma-separated custom GraphQL endpoint URLs. Leave empty for auto-discovery."
   - **Authentication** (3 fields): `graphqlAuthType` (select: empty / `bearer` / `basic` / `cookie` / `custom`), `graphqlAuthValue` (text, password-masked), `graphqlAuthHeader` (text, only shown if `graphqlAuthType === 'custom'`)
6. **Export**: `export function GraphqlScanSection(...)` (line 850 pattern).

### 4.2 Section index

File: [webapp/src/components/projects/ProjectForm/sections/index.ts](webapp/src/components/projects/ProjectForm/sections/index.ts) (line 26 sits next to `JsReconSection` export):

```ts
export { GraphqlScanSection } from './GraphqlScanSection'
```

### 4.3 `ProjectForm.tsx` — import, tab, render

File: [webapp/src/components/projects/ProjectForm/ProjectForm.tsx](webapp/src/components/projects/ProjectForm/ProjectForm.tsx)

- **Line 54 area** — add import:
  ```tsx
  import { GraphqlScanSection } from './sections/GraphqlScanSection'
  ```
- **Line 80-96 (`TAB_GROUPS`)** — add new tab under `'Recon Pipeline'` group, next to `{ id: 'jsrecon', label: 'JS Recon' }`:
  ```ts
  { id: 'graphql', label: 'GraphQL' }
  ```
- **Line 131 (`RECON_TAB_IDS`)** — append `'graphql'`.
- **Line 744-746 area** — add render block modelled on the JsRecon one:
  ```tsx
  {activeTab === 'graphql' && viewMode === 'tabs' && (
    <GraphqlScanSection
      data={formData}
      updateField={updateField}
      projectId={projectId}
      mode={mode}
      onRun={mode === 'edit' && projectId ? () => setPartialReconToolId('GraphqlScan') : undefined}
    />
  )}
  ```

### 4.4 `ProjectFormData` type

If [webapp/src/lib/...](webapp/src/lib/) defines a `ProjectFormData` interface (it does — Prisma-generated types feed it), **running `npx prisma generate` after step 3.1 regenerates it automatically**. Verify the 17 `graphql*` fields appear in the inferred type before wiring the section.

### 4.5 Frontend fallback in `onChange`

Per the prompt's "Settings multi-layer flow" bullet: every `onChange` that writes to `updateField` must pass the Prisma default if the value is cleared (don't pass `undefined`). Copy the pattern from `JsReconSection.tsx` — numeric inputs use `Number(e.target.value) || <default>`, booleans use the Toggle component directly.

---

## 5. Workflow View

### 5.1 `nodeMapping.ts`

File: [webapp/src/components/projects/ProjectForm/nodeMapping.ts](webapp/src/components/projects/ProjectForm/nodeMapping.ts)

- **Line 24 area** (after `JsRecon:` in `SECTION_INPUT_MAP`):
  ```ts
  GraphqlScan: ['BaseURL', 'Endpoint'],
  ```
- **Line 51 area** (after `JsRecon:` in `SECTION_NODE_MAP`):
  ```ts
  GraphqlScan: ['Vulnerability', 'Endpoint'],
  ```
- **After line 65** (`SECTION_ENRICH_MAP`):
  ```ts
  GraphqlScan: ['Endpoint'],
  ```

### 5.2 `workflowDefinition.ts`

File: [webapp/src/components/projects/ProjectForm/WorkflowView/workflowDefinition.ts](webapp/src/components/projects/ProjectForm/WorkflowView/workflowDefinition.ts)

- **Lines 14-54 (`WORKFLOW_TOOLS` array)** — append after `Nuclei` entry (line 46):
  ```ts
  { id: 'GraphqlScan', label: 'GraphQL Scan', enabledField: 'graphqlSecurityEnabled', group: 6, badge: 'active' },
  ```
- **Lines 110-121 (`WORKFLOW_GROUPS`)** — no change (Group 6 already exists).
- **No new data node types** — `BaseURL`, `Endpoint`, `Vulnerability` all exist. Do **not** touch `TRANSITIONAL_DATA_NODES` / `DATA_NODE_CATEGORIES` / `getDataPlacement()` / `workflowLayout.ts`.

### 5.3 `WorkflowNodeModal.tsx`

Add a case to the `switch(toolId)`:

```tsx
import { GraphqlScanSection } from '../sections/GraphqlScanSection'
...
case 'GraphqlScan':
  return <GraphqlScanSection {...extendedProps} />
```

Use `extendedProps` (same as JsRecon) because the section needs `projectId` + `mode` for the partial-recon button.

---

## 6. Graph schema sync (MANDATORY whenever Neo4j is written)

The mixin adds new properties to `Endpoint` and new `Vulnerability` subtypes. **All** of the following must be updated.

### 6.1 `readmes/GRAPH.SCHEMA.md`

File: [readmes/GRAPH.SCHEMA.md](readmes/GRAPH.SCHEMA.md)

- **Lines 483-511 (Endpoint property table)** — append rows:
  | `is_graphql` | Boolean | True if this endpoint is a GraphQL endpoint |
  | `graphql_introspection_enabled` | Boolean | Introspection query succeeded |
  | `graphql_schema_extracted` | Boolean | Full schema was retrieved |
  | `graphql_schema_hash` | String | SHA-256 of normalized schema JSON |
  | `graphql_queries` | String[] | Up to 50 query operation names |
  | `graphql_mutations` | String[] | Up to 50 mutation operation names |
- **Lines 583-655 (Vulnerability node)** — add a bullet documenting the two new `source: 'graphql_scan'` subtypes and their vulnerability_type values: `graphql_introspection_enabled`, `graphql_sensitive_data_exposure`. Note the severity mapping (introspection=info/low, sensitive_data=medium/high).

### 6.2 `agentic/prompts/base.py` (LLM-facing Cypher schema)

File: [agentic/prompts/base.py](agentic/prompts/base.py) — find `TEXT_TO_CYPHER_SYSTEM` and:

- Mirror the new Endpoint properties in the Endpoint section.
- List the two new Vulnerability types under the Vulnerability section.
- Add a short line: "GraphQL scan: source='graphql_scan' on both Endpoint (enrichment) and Vulnerability nodes."

**Why it matters**: without this the agent won't generate correct Cypher for queries like "show me GraphQL endpoints with introspection enabled".

### 6.3 Graph page — colors, sizes, filters, legend

No new node types → no `NODE_COLORS` / `NODE_SIZES` entry needed. But:

- [webapp/src/app/graph/components/DataTable/DataTableToolbar.tsx](webapp/src/app/graph/components/DataTable/DataTableToolbar.tsx) — add a filter **only if** Endpoint is already filterable (it is). A sub-filter on `is_graphql = true` is a nice-to-have, not mandatory per the prompt. **Skip.**
- [webapp/src/app/graph/components/PageBottomBar/PageBottomBar.tsx](webapp/src/app/graph/components/PageBottomBar/PageBottomBar.tsx) — legend entries unchanged (no new node labels).

**Result**: steps 6.3 & related frontend graph-page changes = **no-op for this tool**, confirmed by "no new data node types" in step 0.

### 6.4 Close the subscriptions data-loss gap (graph completeness)

**Violation found**: the scanner collects GraphQL **subscriptions** but the mixin silently drops them. Per the prompt's "Graph completeness" bullet — *"Silently dropping a field (collecting it in the enrichment module but never reading it in the graph method) is a data loss bug"* — this must be fixed.

Evidence in PR:
- [recon/graphql_scan/introspection.py](recon/graphql_scan/introspection.py) `extract_operations()` builds `operations['subscriptions']`.
- [recon/graphql_scan/scanner.py](recon/graphql_scan/scanner.py) `test_single_endpoint()` writes `subscriptions_count` into `endpoint_data`.
- [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) writes only `graphql_queries` and `graphql_mutations` — no `graphql_subscriptions` assignment.

**Fix**: extend the `graphql_props` dict in `update_graph_from_graphql_scan()` (mirror the existing `mutations`/`queries` branches around lines 76-86 of the mixin):

```python
subscriptions = operations.get("subscriptions", [])
if subscriptions:
    graphql_props["graphql_subscriptions"] = subscriptions[:50]   # match 50-cap used for queries/mutations
graphql_props["graphql_subscriptions_count"]  = endpoint_info.get("subscriptions_count", 0)
# Also store explicit counts for queries/mutations (currently only arrays are stored)
graphql_props["graphql_queries_count"]        = endpoint_info.get("queries_count", 0)
graphql_props["graphql_mutations_count"]      = endpoint_info.get("mutations_count", 0)
```

Optionally add a `graphql_schema_extracted_at` ISO timestamp when `schema_extracted=True` (distinguishes stale from fresh schemas across re-scans).

**Propagate** the new property names into:
- §6.1 `readmes/GRAPH.SCHEMA.md` Endpoint property table (add 4 new rows: `graphql_subscriptions`, `graphql_subscriptions_count`, `graphql_queries_count`, `graphql_mutations_count`)
- §6.2 `agentic/prompts/base.py` `TEXT_TO_CYPHER_SYSTEM`
- §7.1 `GraphqlFindingRecord` interface (add `subscriptionsCount` if surfaced in reports)

---

## 7. Report pipeline

### 7.1 `reportData.ts`

File: [webapp/src/lib/report/reportData.ts](webapp/src/lib/report/reportData.ts)

1. **Around line 111** (after `JsReconFindingRecord`) — add interface:
   ```ts
   export interface GraphqlFindingRecord {
     endpoint: string
     vulnerabilityType: 'graphql_introspection_enabled' | 'graphql_sensitive_data_exposure'
     severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
     title: string
     description: string | null
     schemaExtracted: boolean
     queriesCount: number
     mutationsCount: number
     sensitiveFields: string[]
   }
   ```
2. **Inside `ReportData` interface** — add:
   ```ts
   graphqlScan: {
     totalFindings: number
     endpointsTested: number
     introspectionEnabled: number
     bySeverity: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>
     findings: GraphqlFindingRecord[]    // capped at 50
   }
   ```
3. **New `queryGraphql(session, pid)` function** — model on `queryJsRecon` at [reportData.ts:1072](webapp/src/lib/report/reportData.ts#L1072). Query `Endpoint` nodes `WHERE e.is_graphql = true` and `Vulnerability` nodes `WHERE v.source = 'graphql_scan'`, filtered by `{project_id: $pid}`. Cap findings at 50.
4. **`gatherReportData()` at line 303-333** — add `withSession(s => queryGraphql(s, projectId)),` next to the `queryJsRecon` call.
5. **`rawRisk` calculation (line 416)** — add a contribution. Suggested weights (consistent with existing — JsRecon high/critical=40pts, Trufflehog verified=80pts):
   ```ts
   const graphqlScore =
     data.graphqlScan.bySeverity.critical * 60 +
     data.graphqlScan.bySeverity.high * 30 +
     data.graphqlScan.bySeverity.medium * 10 +
     data.graphqlScan.bySeverity.low * 3
   // ...
   const rawRisk = vulnScore + cveScore + gvmExploitScore + kevScore + graphqlScore
   ```
6. **`metrics.secretsExposed`** — N/A (GraphQL doesn't produce Secret nodes).

### 7.2 `reportTemplate.ts`

File: [webapp/src/lib/report/reportTemplate.ts](webapp/src/lib/report/reportTemplate.ts)

1. Add `renderGraphqlScan(data: ReportData): string` — mirror `renderJsRecon` or the next closest analog. **Conditional**: `if (data.graphqlScan.totalFindings === 0) return ''`. Include a `page-break` div and unique anchor id `graphql-scan`.
2. In the **dynamic TOC builder** (`dynamicSections.push(...)`), add a conditional entry for GraphQL.
3. In `generateReportHtml()`, call `renderGraphqlScan(data)` alongside the other render calls.

### 7.3 `reports/route.ts`

File: [webapp/src/app/api/projects/[id]/reports/route.ts](webapp/src/app/api/projects/[id]/reports/route.ts) — `condenseForAgent()` around line 126-150:

Add to the payload:
```ts
graphqlScan: {
  endpointsTested: data.graphqlScan.endpointsTested,
  introspectionEnabled: data.graphqlScan.introspectionEnabled,
  bySeverity: data.graphqlScan.bySeverity,
  topFindings: data.graphqlScan.findings.slice(0, 15),  // 15-item cap per prompt
}
```

---

## 8. Presets

### 8.1 Zod schema — **blocks AI-generated presets until done**

File: [webapp/src/lib/recon-preset-schema.ts](webapp/src/lib/recon-preset-schema.ts) — around line 167 (after the `jsRecon*` block):

```ts
graphqlSecurityEnabled: bool,
graphqlIntrospectionTest: bool,
graphqlMutationTesting: bool,
graphqlProxyTesting: bool,
graphqlSafeMode: bool,
graphqlMaxMutationsTest: int,
graphqlTimeout: int,
graphqlRateLimit: int,
graphqlConcurrency: int,
graphqlAuthType: str,
graphqlAuthValue: str,
graphqlAuthHeader: str,
graphqlEndpoints: str,
graphqlDepthLimit: int,
graphqlRetryCount: int,
graphqlRetryBackoff: num,  // use whatever the existing float helper is (check top of file)
graphqlVerifySsl: bool,
```

Also update [webapp/src/lib/recon-preset-schema.test.ts](webapp/src/lib/recon-preset-schema.test.ts) — bump any "expected key count" constants.

### 8.2 AI preset generator catalog

File: [webapp/src/app/api/presets/generate/route.ts](webapp/src/app/api/presets/generate/route.ts) — `RECON_PARAMETER_CATALOG` (imported from `recon-preset-schema`). If the catalog lives in the schema file, add entries there; otherwise edit the route. Include `name`, `type`, `default`, `description` for each of the 17 keys.

**Without this, the LLM won't know GraphQL settings exist and AI-generated presets will silently omit them.**

### 8.3 Per-preset review

Files: [webapp/src/lib/recon-presets/presets/*.ts](webapp/src/lib/recon-presets/presets/) (21 preset files).

**Decision table** (review every preset — do not skip):

| Preset | `graphqlSecurityEnabled` | Reason |
|---|---|---|
| `api-security.ts` | **true** + `graphqlMutationTesting: true`, `graphqlProxyTesting: true` | Description already advertises GraphQL coverage |
| `web-app-pentester.ts` | **true** (default settings) | GraphQL is part of modern webapp surface |
| `bug-bounty-quick.ts` | true, `graphqlMutationTesting: false` | Introspection-only to keep noise down |
| `bug-bounty-deep.ts` | true (all modules) | Full coverage |
| `full-active-scan.ts` | true (all modules) | Matches preset intent |
| `full-maximum-scan.ts` | true (all modules) | Matches preset intent |
| `red-team-operator.ts` | true, safe mode on | Low-noise active ops |
| `full-passive-scan.ts` | **false** | Active tool, violates preset intent |
| `stealth-recon.ts` | true, `graphqlMutationTesting: false`, `graphqlProxyTesting: false`, `graphqlSafeMode: true`, rate=2, concurrency=1 | Stealth-compatible subset |
| `osint-investigator.ts` | **false** | Purely OSINT/passive |
| `dns-email-security.ts` | **false** | Out of scope |
| `secret-miner.ts`, `secret-hunter.ts` | **false** | JS/GitHub-focused |
| `subdomain-takeover.ts` | **false** | Out of scope |
| `infrastructure-mapper.ts` | **false** | Network-level recon |
| `cve-hunter.ts` | true (default) | GraphQL findings can surface CVE-mapped issues |
| `directory-discovery.ts` | **false** | Directory fuzzing only |
| `cloud-exposure.ts` | **false** | Cloud metadata focused |
| `compliance-audit.ts` | true, `graphqlMutationTesting: false` | Read-only assessment |
| `parameter-injection.ts` | true (default) | Parameters/queries testing related |
| `large-network.ts` | **false** | Host-level scale |

Leave keys **unset** if the preset should inherit defaults — missing keys auto-merge safely.

### 8.4 `PRESET_EXCLUDED_FIELDS`

File: [webapp/src/lib/project-preset-utils.ts:5-19](webapp/src/lib/project-preset-utils.ts#L5)

**Do not add any GraphQL field** — per the prompt: "Standard toggle/number/string settings do NOT need to be excluded." `graphqlAuthValue` is a secret but the current set doesn't exclude other auth-like strings (the pattern is "file uploads and target identity only"), so keep it consistent. If the team decides auth values are sensitive, add `graphqlAuthValue` to the set — but that's a policy call outside this prompt.

### 8.5 Preset tests

File: [webapp/src/lib/recon-presets/recon-presets.test.ts](webapp/src/lib/recon-presets/recon-presets.test.ts) — any snapshot or "preset-N has M keys" assertion may need updating.

---

## 9. Partial recon integration (PROMPT.ADD_PARTIAL_RECON.md)

PR #93 does **zero** of this. Since GraphQL inputs are graph-only (BaseURL, Endpoint), the UI is simplest possible: no textareas, no "Associate to" dropdown, no Subdomain auto-attach. But every backend/routing layer must still be wired.

### 9.1 Partial recon backend — create a new module under `partial_recon_modules/`

**⚠️ Architecture correction**: `recon/partial_recon.py` is a **thin dispatcher only** — the actual per-tool functions live in topic-grouped files under `recon/partial_recon_modules/` (e.g. `web_crawling.py` hosts `run_katana`, `vulnerability_scanning.py` hosts `run_nuclei`, `js_analysis.py` hosts `run_jsrecon`). The plan must follow the same structure.

**Pattern to mirror**: [recon/partial_recon_modules/vulnerability_scanning.py](recon/partial_recon_modules/vulnerability_scanning.py) `run_nuclei()` (closest analog — URL-input vuln scanner, settings-override support, graph-only inputs).

#### 9.1.a Create `recon/partial_recon_modules/graphql_scanning.py`

New file. Top structure (mirror `vulnerability_scanning.py` lines 1-20):

```python
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules.graph_builders import _build_graphql_data_from_graph  # see §9.1.c


def run_graphqlscan(config: dict) -> None:
    """
    Run partial GraphQL security scanning.
    Discovers GraphQL endpoints from graph data (BaseURLs, Endpoints, JS findings)
    and optional user-provided endpoint URLs in settings, then tests introspection
    and writes enrichment + vulnerabilities to Neo4j.
    """
    from recon.graphql_scan import run_graphql_scan
    from recon.project_settings import get_settings
    from graph_db import Neo4jClient

    domain = config["domain"]
    user_id = os.environ.get("USER_ID", "")
    project_id = os.environ.get("PROJECT_ID", "")

    print(f"[*][Partial Recon] Loading project settings...")
    settings = get_settings()

    # Force-enable so toggle state in DB doesn't block an explicit user request
    settings['GRAPHQL_SECURITY_ENABLED'] = True

    # Apply settings_overrides from modal checkboxes (bypass DB settings)
    settings_overrides = config.get("settings_overrides") or {}
    for key, value in settings_overrides.items():
        settings[key] = value

    print(f"\n{'=' * 50}")
    print(f"[*][Partial Recon] GraphQL Security Scanning")
    print(f"[*][Partial Recon] Domain: {domain}")
    print(f"{'=' * 50}\n")

    # No user_targets for GraphQL — inputs are graph-only (BaseURL + Endpoint)
    # Graph-data builder
    include_graph = config.get("include_graph_targets", True)
    if include_graph:
        print(f"[*][Partial Recon] Querying graph for targets (BaseURLs, Endpoints, JS findings)...")
        recon_data = _build_graphql_data_from_graph(domain, user_id, project_id)
    else:
        print(f"[*][Partial Recon] Skipping graph targets (user opted out) — relying on GRAPHQL_ENDPOINTS setting")
        recon_data = {
            'domain': domain,
            'http_probe': {'by_url': {}},
            'resource_enum': {'endpoints': {}, 'parameters': {}},
            'js_recon': {'findings': []},
            'metadata': {'roe': {}},
        }

    # Run the scanner (mutates recon_data in place — adds recon_data['graphql_scan'])
    run_graphql_scan(recon_data, settings)

    # Push results to Neo4j
    with Neo4jClient() as graph_client:
        graph_client.update_graph_from_graphql_scan(recon_data, user_id, project_id)
```

#### 9.1.b Wire the dispatcher — [recon/partial_recon.py](recon/partial_recon.py)

Edit only the dispatcher (lines 37-60 area for imports, `main()` for dispatch):

1. Add import next to existing module imports:
   ```python
   from recon.partial_recon_modules.graphql_scanning import run_graphqlscan
   ```
2. Add to the module docstring (lines 10-23) — a new bullet:
   ```
     - GraphqlScan: runs run_graphql_scan() from recon/graphql_scan
   ```
3. Register in `main()` alongside other `elif tool_id == "X":` branches:
   ```python
   elif tool_id == "GraphqlScan":
       run_graphqlscan(config)
   ```

#### 9.1.c Add `_build_graphql_data_from_graph()` to `graph_builders.py`

File: [recon/partial_recon_modules/graph_builders.py](recon/partial_recon_modules/graph_builders.py) — mirror the existing builders (`_build_recon_data_from_graph`, `_build_port_scan_data_from_graph`, `_build_http_probe_data_from_graph`, `_build_vuln_scan_data_from_graph`).

**Why a new builder is needed**: the GraphQL scanner's `discovery.py` reads three nested sections of `recon_data`:
- `http_probe.by_url` (url → {headers, status_code}) — from Httpx
- `resource_enum.endpoints` (base_url → [{path, method}]) — from crawlers
- `resource_enum.parameters` (base_url → [{name}]) — from parameter discovery tools
- `js_recon.findings` (list of {type, path, method}) — from JS Recon

No existing builder produces this composite shape. Signature:

```python
def _build_graphql_data_from_graph(domain: str, user_id: str, project_id: str) -> dict:
    """
    Build recon_data expected by recon.graphql_scan.discovery.discover_graphql_endpoints():
      recon_data['http_probe']['by_url']      : BaseURL-derived (status_code, headers)
      recon_data['resource_enum']['endpoints'][base_url] : Endpoint nodes, with path + method
      recon_data['resource_enum']['parameters'][base_url] : Parameter nodes
      recon_data['js_recon']['findings']      : JsReconFinding nodes of type='graphql'|'graphql_introspection'|'rest'
    """
```

Cypher queries (adapt per existing patterns — sessions via `Neo4jClient().driver.session()`):

```cypher
-- BaseURLs → http_probe.by_url
MATCH (b:BaseURL {user_id: $uid, project_id: $pid})
RETURN b.url AS url, b.status_code AS status_code, b.headers AS headers

-- Endpoints grouped by BaseURL → resource_enum.endpoints
MATCH (b:BaseURL {user_id: $uid, project_id: $pid})-[:HAS_ENDPOINT]->(e:Endpoint)
RETURN b.url AS base, collect({path: e.path, method: e.method}) AS endpoints

-- Parameters grouped by BaseURL → resource_enum.parameters
MATCH (b:BaseURL {user_id: $uid, project_id: $pid})-[:HAS_ENDPOINT]->(e:Endpoint)-[:HAS_PARAMETER]->(p:Parameter)
RETURN b.url AS base, collect(DISTINCT {name: p.name}) AS parameters

-- JsReconFindings with graphql hints
MATCH (jr:JsReconFinding {user_id: $uid, project_id: $pid})
WHERE jr.finding_type IN ['graphql', 'graphql_introspection']
   OR (jr.finding_type = 'rest' AND toLower(coalesce(jr.path, '')) CONTAINS 'graphql')
RETURN jr.finding_type AS type, jr.path AS path, jr.method AS method
```

Return the assembled dict. Also populate `recon_data['metadata']['roe']` from project settings so `filter_by_roe()` still works inside the scanner (read the canonical `ROE_*` keys via `get_settings()` or a thin helper).

**Verify relationship names** (`HAS_ENDPOINT`, `HAS_PARAMETER`) against [graph_db/schema.py](graph_db/schema.py) before writing the queries — existing builders import from it. If the schema differs, adjust the `MATCH` patterns accordingly.

### 9.2 "Include Graph Targets" guard

Per the prompt's "Include Graph Targets checkbox" section — check if the unchecked state creates an impossible scan. For GraphQL:

- Unchecked + empty `graphqlEndpoints` setting → **nothing to scan**. Add a guard.

File: [webapp/src/components/projects/ProjectForm/WorkflowView/PartialReconModal.tsx](webapp/src/components/projects/ProjectForm/WorkflowView/PartialReconModal.tsx)

```tsx
const graphqlNoTargets =
  isGraphql && !includeGraphTargets && !(data?.graphqlEndpoints || '').trim()
// Added to: disabled={... || graphqlNoTargets}
// Warning: "GraphQL Scan requires targets. Provide custom endpoints in the GraphQL tab or enable graph targets."
```

### 9.3 Graph mixin — `get_graph_inputs_for_tool()`

**⚠️ Path correction**: the method lives in the **split** recon mixin, not the thin combinator. [graph_db/mixins/recon_mixin.py](graph_db/mixins/recon_mixin.py) only aggregates sub-mixins from `graph_db/mixins/recon/`. The actual `get_graph_inputs_for_tool()` definition is at:

**[graph_db/mixins/recon/user_input_mixin.py:309](graph_db/mixins/recon/user_input_mixin.py#L309)**

It's a long `if/elif` chain keyed on `tool_id`. Find the `Katana` or `JsRecon` case (BaseURL-consuming) and add a parallel `'GraphqlScan'` case.

Return Cypher that counts/lists both `BaseURL` and `Endpoint` for the project:
```cypher
OPTIONAL MATCH (d:Domain {user_id: $uid, project_id: $pid})
OPTIONAL MATCH (b:BaseURL {user_id: $uid, project_id: $pid})
OPTIONAL MATCH (e:Endpoint {user_id: $uid, project_id: $pid})
RETURN d.name AS domain,
       count(DISTINCT b) AS baseurls_count,
       collect(DISTINCT b.url)[..50] AS baseurls,
       count(DISTINCT e) AS endpoints_count,
       collect(DISTINCT e.full_url)[..50] AS endpoints
```

Return shape (matches the `GraphInputs` interface in `recon-types.ts`):
```python
return {
    "domain": record["domain"] or None,
    "existing_baseurls_count": record["baseurls_count"] or 0,
    "existing_baseurls": record["baseurls"] or [],
    "existing_endpoints_count": record["endpoints_count"] or 0,
    "existing_endpoints": record["endpoints"] or [],
    "source": "graph" if record["domain"] else "settings",
}
```

### 9.4 Graph-inputs API route

File: [webapp/src/app/api/recon/[projectId]/graph-inputs/[toolId]/route.ts](webapp/src/app/api/recon/%5BprojectId%5D/graph-inputs/%5BtoolId%5D/route.ts)

After the `JsRecon` branch at [line 230](webapp/src/app/api/recon/[projectId]/graph-inputs/[toolId]/route.ts#L230), add an `else if (toolId === 'GraphqlScan')` branch modelled on `Katana` (line 128):
- Neo4j query for BaseURL + Endpoint counts + name lists.
- Falls back to settings on query failure (mirror the console.warn pattern).
- Returns a `GraphInputs` payload.

### 9.5 `recon-types.ts`

File: [webapp/src/lib/recon-types.ts](webapp/src/lib/recon-types.ts)

1. **Line 176** — add `'GraphqlScan'` to `PARTIAL_RECON_SUPPORTED_TOOLS`.
2. **Lines 178-199** — add to `PARTIAL_RECON_PHASE_MAP`:
   ```ts
   GraphqlScan: ['Endpoint Discovery', 'Introspection Testing', 'Schema Analysis', 'Vulnerability Detection'],
   ```
3. **GraphInputs interface (lines 146-157)** — already has `existing_baseurls` and `existing_endpoints`; no extension needed.
4. **UserTargets interface (lines 158-165)** — **no extension** (GraphQL has no user-entered targets through textareas).

### 9.6 `PartialReconModal.tsx`

File: [webapp/src/components/projects/ProjectForm/WorkflowView/PartialReconModal.tsx](webapp/src/components/projects/ProjectForm/WorkflowView/PartialReconModal.tsx)

1. **`TOOL_DESCRIPTIONS` (line 131-137 area)** — add:
   ```ts
   GraphqlScan:
     'Active GraphQL security scanner. Discovers GraphQL endpoints from crawled BaseURLs and ' +
     'Endpoints, tests for exposed introspection, extracts schema, and flags sensitive fields + ' +
     'mutation-based business logic issues. No user targets — uses the graph plus any endpoints ' +
     'configured in the GraphQL tab. Enriches Endpoint nodes with is_graphql flags and creates ' +
     'Vulnerability nodes.',
   ```
2. **Condition flags** — because GraphQL has **no user-entered targets**, do NOT add it to `isPortScanner` / `hasSubdomainInput` / `hasUserInputs` / `isUrlCrawler`. Declare:
   ```tsx
   const isGraphql = toolId === 'GraphqlScan'
   ```
3. **Add the `graphqlNoTargets` guard from 9.2.**
4. **No custom textareas** needed.

### 9.7 `ToolNode.tsx` + related

Per the prompt, [ToolNode.tsx](webapp/src/components/projects/ProjectForm/WorkflowView/ToolNode.tsx) reads from `PARTIAL_RECON_SUPPORTED_TOOLS` automatically — **no edit needed**. Same for `GraphToolbar`, `ReconLogsDrawer`, `usePartialRecon*` hooks.

### 9.8 Tests

1. **Python**: [recon/tests/test_partial_recon.py](recon/tests/test_partial_recon.py) — add `TestRunGraphqlScan` class. Cover: `include_graph_targets=True` with graph data, `include_graph_targets=False` with settings-only endpoints, no-targets error path, graph mixin call args.
2. **TypeScript**: [webapp/src/lib/partial-recon-types.test.ts](webapp/src/lib/partial-recon-types.test.ts) — add `'GraphqlScan'` to the supported-tools assertion, add phase-map test, verify `UserTargets` shape unchanged.

---

## 10. RoE (Rules of Engagement) — verify & document

The PR claims RoE filtering exists (`filter_by_roe` in `discovery.py`). Verify against [recon/main.py](recon/main.py) RoE patterns and [project_settings.py](recon/project_settings.py) RoE keys. Specifically:

- `ROE_EXCLUDED_HOSTS` — handled (wildcard matching in `filter_by_roe`).
- `ROE_ALLOWED_HOSTS` — **not handled in the PR**. If the project uses an allow-list model, discovery will leak out-of-scope. Add a companion filter in `discovery.py:filter_by_roe`.
- `ROE_TIME_WINDOW_*` — not checked by the scanner. Compliance: may be acceptable if the whole pipeline is gated, but **verify** in `main.py` that Group 6 respects the time window.
- `ROE_GLOBAL_MAX_RPS` — already capped via `RATE_LIMIT_KEYS` (done in PR).

---

## 11. Logging & output format (verification + one fix)

Per prompt symbol table: `[*]` info, `[+]` success, `[-]` negative/skipped, `[!]` error/warning, `[✓]` completed, `[⚡]` special mode.

**Fix**: [recon/graphql_scan/discovery.py:746](recon/graphql_scan/discovery.py#L746) currently logs:
```python
print(f"[RoE][GraphQL] Excluded {excluded_count} endpoint(s) per Rules of Engagement")
```
This `[RoE]` prefix is **not** in the prompt's symbol table. Change to:
```python
print(f"[-][GraphQL] RoE: excluded {excluded_count} out-of-scope endpoint(s)")
```

All other log lines (`scanner.py`, `introspection.py`, `auth.py`, `graphql_mixin.py`) already conform to `[symbol][GraphQL]`.

---

## 12. Build & deploy sequence

Run in this order — each step has a prerequisite on the previous one:

```bash
# 1. Database schema (after 3.1)
docker compose exec webapp npx prisma db push
docker compose exec webapp npx prisma generate

# 2. Recon image — bakes partial_recon.py + scanner changes (after 2, 9.1)
docker compose --profile tools build recon

# 3. Agent image — bakes graph_db mixins (after 6.1, 6.2) - IF agentic/prompts/base.py changed
docker compose build agent && docker compose up -d agent

# 4. Orchestrator — IF api.py changed (after 3.2)
docker compose restart recon-orchestrator

# 5. Webapp — in dev mode, hot-reload picks up section + modal + workflow + report changes
# In prod:
docker compose build webapp && docker compose up -d webapp
```

Per project memory: never use `prisma migrate` — push-based workflow only.

---

## 13. Verification checklist (walk through before declaring done)

End-to-end smoke tests:

- [ ] **Settings round-trip**: toggle `graphqlSecurityEnabled` in the UI → save → DB has `graphql_security_enabled = true` → `GET /defaults` returns all 17 keys → `fetch_project_settings()` reads them.
- [ ] **Full pipeline**: kick off a full scan on a target with a known GraphQL endpoint (e.g. `countries.trevorblades.com/graphql`) → GROUP 6 logs show GraphQL stage → Neo4j has Endpoint with `is_graphql=true` and a Vulnerability `source='graphql_scan'`.
- [ ] **Workflow view**: new GraphQL Scan node appears in Group 6, green when BaseURL/Endpoint producers are enabled, red otherwise. Clicking Play opens the modal.
- [ ] **Partial recon**: Click Play on the GraphQL node → modal shows description + Include-Graph-Targets checkbox only (no textareas) → Run → recon container spawns → SSE logs stream → Neo4j updated without re-running the full pipeline.
- [ ] **Partial recon guard**: Uncheck graph targets + empty `graphqlEndpoints` → Run button disabled with warning.
- [ ] **Report**: Generate a report → GraphQL section appears in TOC + body when findings > 0 → omitted when 0 → risk score increases by expected weight.
- [ ] **Presets**: Select `api-security` preset → creates project with `graphqlSecurityEnabled=true` → `full-passive-scan` → `false`. AI-generated preset that mentions "test GraphQL" includes `graphql*` keys (validates the catalog + Zod schema work).
- [ ] **Graph schema docs**: `readmes/GRAPH.SCHEMA.md` and `agentic/prompts/base.py` both list the new fields — run an agent query like "find GraphQL endpoints with introspection" → returns correct Cypher.
- [ ] **RoE**: Add target domain's host to `ROE_EXCLUDED_HOSTS` → GraphQL stage skips it with the `[RoE][GraphQL]` log.
- [ ] **Stealth**: Toggle `stealthMode` → `apply_stealth_overrides()` keeps introspection on, kills mutations/proxy tests. Verify via recon container logs.
- [ ] **Tests**: `pytest recon/tests/test_graphql_scan.py recon/tests/test_partial_recon.py::TestRunGraphqlScan` + `npm test -- recon-preset-schema partial-recon-types` all green.
- [ ] **Reference-implementation comparison** (per `PROMPT.ADD_PARTIAL_RECON.md` step 11): run `JsRecon` or `Nuclei` partial recon back-to-back with `GraphqlScan` partial recon on the same project. Verify symmetric behaviour — SSE logs format, drawer title, status line `"Scanning: <phase>"`, mutual-exclusion 409, graph update stats line, no phase progress bar. Any divergence = bug.
- [ ] **Graph-completeness audit**: after a scan, query Neo4j for an Endpoint with `is_graphql=true`. Assert all of the following properties are set: `graphql_introspection_enabled`, `graphql_schema_extracted`, `graphql_schema_hash`, `graphql_queries`, `graphql_queries_count`, `graphql_mutations`, `graphql_mutations_count`, `graphql_subscriptions`, `graphql_subscriptions_count`. Missing any = §6.4 regression.

---

## 14. File-by-file summary (what changes vs what's already done)

| File | Status | Section |
|---|---|---|
| [recon/graphql_scan/*](recon/graphql_scan/) | ✅ Done | — |
| [recon/project_settings.py](recon/project_settings.py) | ✅ Done | — |
| [recon/main.py](recon/main.py) | ⚠️ Relabel "GROUP 6b" + fan-out Nuclei ‖ GraphQL | §2, §2.5 |
| [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) | ✅ Done | — |
| [graph_db/neo4j_client.py](graph_db/neo4j_client.py) | ✅ Done | — |
| [webapp/prisma/schema.prisma](webapp/prisma/schema.prisma) | ❌ Add 17 fields | §3.1 |
| [recon_orchestrator/api.py](recon_orchestrator/api.py) | ❌ Verify `/defaults` dynamic, patch if static | §3.2 |
| `webapp/src/.../sections/GraphqlScanSection.tsx` | ❌ Create | §4.1 |
| [webapp/src/.../sections/index.ts](webapp/src/components/projects/ProjectForm/sections/index.ts) | ❌ Export | §4.2 |
| [webapp/src/.../ProjectForm.tsx](webapp/src/components/projects/ProjectForm/ProjectForm.tsx) | ❌ Import + tab + render | §4.3 |
| [webapp/src/.../nodeMapping.ts](webapp/src/components/projects/ProjectForm/nodeMapping.ts) | ❌ 3 map entries | §5.1 |
| [webapp/src/.../WorkflowView/workflowDefinition.ts](webapp/src/components/projects/ProjectForm/WorkflowView/workflowDefinition.ts) | ❌ `WORKFLOW_TOOLS` entry | §5.2 |
| [webapp/src/.../WorkflowView/WorkflowNodeModal.tsx](webapp/src/components/projects/ProjectForm/WorkflowView/WorkflowNodeModal.tsx) | ❌ Switch case | §5.3 |
| [readmes/GRAPH.SCHEMA.md](readmes/GRAPH.SCHEMA.md) | ❌ Endpoint + Vulnerability sections | §6.1 |
| [agentic/prompts/base.py](agentic/prompts/base.py) | ❌ TEXT_TO_CYPHER_SYSTEM | §6.2 |
| [webapp/src/app/graph/config/colors.ts](webapp/src/app/graph/config/colors.ts) | ✅ No-op (no new labels) | §6.3 |
| [webapp/src/lib/report/reportData.ts](webapp/src/lib/report/reportData.ts) | ❌ Interface + query + risk score | §7.1 |
| [webapp/src/lib/report/reportTemplate.ts](webapp/src/lib/report/reportTemplate.ts) | ❌ renderGraphqlScan + TOC | §7.2 |
| [webapp/src/app/api/projects/[id]/reports/route.ts](webapp/src/app/api/projects/[id]/reports/route.ts) | ❌ condenseForAgent payload | §7.3 |
| [webapp/src/lib/recon-preset-schema.ts](webapp/src/lib/recon-preset-schema.ts) | ❌ 17 Zod fields | §8.1 |
| [webapp/src/app/api/presets/generate/route.ts](webapp/src/app/api/presets/generate/route.ts) | ❌ Catalog entries | §8.2 |
| [webapp/src/lib/recon-presets/presets/*.ts](webapp/src/lib/recon-presets/presets/) | ❌ 21 files to review | §8.3 |
| [webapp/src/lib/project-preset-utils.ts](webapp/src/lib/project-preset-utils.ts) | ✅ No-op (policy call) | §8.4 |
| `recon/partial_recon_modules/graphql_scanning.py` | ❌ **Create** new module with `run_graphqlscan(config)` | §9.1.a |
| [recon/partial_recon.py](recon/partial_recon.py) | ❌ Dispatcher: import + `elif tool_id == "GraphqlScan"` only | §9.1.b |
| [recon/partial_recon_modules/graph_builders.py](recon/partial_recon_modules/graph_builders.py) | ❌ Add `_build_graphql_data_from_graph()` helper | §9.1.c |
| [graph_db/mixins/recon/user_input_mixin.py](graph_db/mixins/recon/user_input_mixin.py) | ❌ `get_graph_inputs_for_tool` GraphqlScan case (line ~309) | §9.3 |
| [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) | ❌ Add subscriptions + explicit counts | §6.4 |
| [recon/graphql_scan/discovery.py](recon/graphql_scan/discovery.py) | ❌ Fix `[RoE][GraphQL]` log prefix | §11 |
| [webapp/src/app/api/recon/[projectId]/graph-inputs/[toolId]/route.ts](webapp/src/app/api/recon/%5BprojectId%5D/graph-inputs/%5BtoolId%5D/route.ts) | ❌ else-if branch | §9.4 |
| [webapp/src/lib/recon-types.ts](webapp/src/lib/recon-types.ts) | ❌ Supported tools + phase map | §9.5 |
| [webapp/src/.../WorkflowView/PartialReconModal.tsx](webapp/src/components/projects/ProjectForm/WorkflowView/PartialReconModal.tsx) | ❌ Description + `isGraphql` + guard | §9.2, §9.6 |
| [recon/tests/test_partial_recon.py](recon/tests/test_partial_recon.py) | ❌ TestRunGraphqlScan | §9.8 |
| [webapp/src/lib/partial-recon-types.test.ts](webapp/src/lib/partial-recon-types.test.ts) | ❌ Supported-tools test | §9.8 |
| [webapp/src/lib/recon-presets/recon-presets.test.ts](webapp/src/lib/recon-presets/recon-presets.test.ts) | ❌ Update snapshots/counts | §8.5 |
| [webapp/src/lib/recon-preset-schema.test.ts](webapp/src/lib/recon-preset-schema.test.ts) | ❌ Update counts | §8.1 |
| [recon/Dockerfile](recon/Dockerfile), [recon/entrypoint.sh](recon/entrypoint.sh), [recon/requirements.txt](recon/requirements.txt) | ✅ No-op (pure Python) | — |
| [webapp/src/lib/apiKeysTemplate.ts](webapp/src/lib/apiKeysTemplate.ts) | ✅ No-op (no UserSettings keys) | — |

---

## 15. Risks & gotchas

1. **Prisma regeneration order**. §3.1 must complete BEFORE the frontend section (§4.1) is written — the `ProjectFormData` type needs the new fields, or TypeScript will fail.
2. **`recon_data` shape for partial recon**. The new `_build_graphql_data_from_graph()` (§9.1.c) must emit the exact shape `discovery.py` reads. Gate with an integration test: call the builder on a seeded project, assert `recon_data['http_probe']['by_url']`, `resource_enum.endpoints[base_url]`, `resource_enum.parameters[base_url]`, `js_recon.findings` are all populated and non-empty when the graph has data.
3. **Endpoint enrichment MERGE keys**. Confirm the mixin's `MATCH` clause on `Endpoint` uses the same `(path, baseurl, user_id, project_id)` or `(full_url, user_id, project_id)` keys as the producers (Katana, Jsluice, ResourceMixin writers). See [graph_db/schema.py](graph_db/schema.py) — if the mixin's MATCH is looser than the producer's MERGE, you'll enrich zero nodes or create duplicates. Run a smoke scan and `MATCH (e:Endpoint) WHERE e.is_graphql=true RETURN count(e)` — should be >0.
4. **`get_graph_inputs_for_tool` path**. Easy to mis-target — the method is on `UserInputMixin` in `graph_db/mixins/recon/user_input_mixin.py`, NOT on the thin `graph_db/mixins/recon_mixin.py` combinator. Editing the combinator silently does nothing because `ReconMixin` just inherits `UserInputMixin`.
5. **Partial-recon module placement**. `recon/partial_recon.py` is a dispatcher — the actual `run_graphqlscan()` function MUST live in `recon/partial_recon_modules/graphql_scanning.py` (new file). Tests that import from the wrong path will fail.
6. **Group 6 fan-out requires Nuclei `_isolated` wrapper**. [recon/vuln_scan.py:70](recon/vuln_scan.py#L70) exports `run_vuln_scan(recon_data, output_file, settings)` but **no `run_vuln_scan_isolated`** exists. Adding the fan-out without first creating that wrapper causes thread races on `combined_result`. Follow the `censys_enrich.py` pattern (deepcopy → run → return tool key only).
7. **Save-file race**. If `save_recon_file()` isn't already lock-protected, Group 6 Phase A's two threads will race on writes. Check [recon/main.py](recon/main.py) for an existing lock. If absent, add one before enabling fan-out.
8. **Subscriptions gap (§6.4)**. Without the mixin fix, every scan silently loses subscription operation data — the bug persists across re-scans because the schema hash doesn't include subscriptions in its equality check either.
9. **RoE log format (§11)**. Minor but repeated in every scan, so it pollutes logs. Single-line fix, do not defer.
10. **AI presets silently stripped**. Until §8.1 (Zod) and §8.2 (catalog) are done, any AI-generated preset that the LLM produces including `graphql*` keys gets those keys **stripped on validation** — no error surfaced to the user. Tests in `recon-preset-schema.test.ts` must assert the new keys round-trip through `.parse()`.
11. **Relative-date memories**. Today is 2026-04-20 — any project memory written from this plan should store absolute dates, not "next week".
12. **Minor**: the PR's `introspection.py` ends without a trailing newline and uses `return None` instead of an empty dict in one branch — cosmetic, doesn't affect conformance.

---

## 16. Out-of-scope for Phase 1 (PR #93 conformance)

These are deferred to **Phase 2 (§17 — graphql-cop)** or later:

- Subscription (`__schema.subscriptionType`) security checks
- Batching / alias / directive DoS — **covered in §17 by graphql-cop**
- Field-level authorization matrix testing
- DoS protection checks (depth/complexity limits) beyond config `GRAPHQL_DEPTH_LIMIT`
- Automatic CWE/CVE tagging of GraphQL findings for MITRE enrichment (would require a new mapping layer)
- Schema recovery when introspection is disabled — deferred to later PR (`clairvoyance`)

---

# ========== PHASE 2 ==========

# §17. Follow-up integration: `graphql-cop`

> **Execution order**: apply §17 **only after §1-§16 have landed and been smoke-tested**. graphql-cop builds on the scaffolding from Phase 1 — Prisma schema, section component, workflow node, report pipeline, graph mixin, partial-recon module are all reused, not duplicated. Phase 2 essentially adds a second scanner driver inside the same `GraphqlScan` tool identity.

## 17.1 Tool research (what graphql-cop is, pinned facts)

**Repo**: `dolevf/graphql-cop` · 641★ · MIT · Python · actively maintained (last commit 2025-11-20).
**Docker Hub**: `dolevf/graphql-cop:1.14` (49.3 MB, last pushed ~11 months ago).
**Current git version**: `1.15` (DockerHub is one minor behind; pin to `1.14`).

### Why we cannot just `pip install` it
`graphql-cop/requirements.txt` pins **`requests==2.25.1`**. RedAmon's [recon/requirements.txt](recon/requirements.txt) pins `requests>=2.31.0`. Installing the graphql-cop package would downgrade `requests` and break existing tools (Subfinder, Arjun, ParamSpider all call `requests`). **→ Docker-in-Docker is mandatory**, matching the Naabu/httpx/Katana/Nuclei pattern per `PROMPT.ADD_RECON_TOOL.md` section "Choose integration pattern".

### CLI contract (graphql-cop 1.14)

```
python3 graphql-cop.py -t <URL> [options]

Options:
  -t, --target URL           Target URL (full URL with path; if path is / or missing,
                             the tool iterates ['/', '/graphiql', '/playground', '/console', '/graphql'])
  -H, --header '{"k":"v"}'   Extra header as JSON object (repeatable)
  -o, --output json          Output format (only 'json' supported; without -o it prints colored text)
  -e, --excluded-tests LIST  Comma-separated test names to skip (see §17.2 table)
  -l, --list-tests           List tests and exit
  -f, --force                Force scan even when endpoint doesn't look like GraphQL
  -d, --debug                Add 'X-GraphQL-Cop-Test' header per request for debugging
  -x, --proxy URL            HTTP(S) proxy (http://user:pass@host:port)
  -w, --wordlist PATH        Custom GraphQL endpoints wordlist (one path per line)
  -T, --tor                  Route via Tor (127.0.0.1:9050 SOCKS5)
  -v, --version
```

**Exit codes**: 0 on normal completion (regardless of findings); 1 only on missing URL / malformed input. **There is no "vulnerable" exit code** — must parse JSON to know results.

**Auto-discovery behavior**: if `-t https://host` (no path or `/`) → iterates 5 paths internally. If `-t https://host/graphql` → tests only that path. **RedAmon will always pass explicit URLs** (the PR's discovery already gives us confirmed endpoints), so graphql-cop's internal iteration is bypassed.

### Per-endpoint request volume

graphql-cop runs **12 tests** per endpoint. Each test sends ~1-3 requests. DoS probes are intentionally heavy:
- `alias_overloading`: 1 query with **101 aliases**
- `batch_query`: array of **10** identical queries in one request
- `directive_overloading`: 1 query with **10 repeated directives**
- `circular_query_introspection`: 1 deeply-nested introspection (~5 levels)

Total per endpoint: **~20-30 requests**. Bursty but short — completes in <10s per endpoint against a responsive server.

### JSON output schema

```json
[
  {
    "result": true,                   // true = finding triggered (vulnerability detected)
    "title": "Alias Overloading",
    "description": "Alias Overloading with 100+ aliases is allowed",
    "impact": "Denial of Service - /graphql",   // last path segment appended
    "severity": "HIGH",               // one of: "HIGH" | "MEDIUM" | "LOW" | "INFO"
    "color": "red",                   // "red" | "yellow" | "blue" | "green"
    "curl_verify": "curl -X POST -H ... -d '...' 'http://...'"  // reproducer
  },
  ... (12 objects total, one per test; sorted by title)
]
```

Every test **always** emits an object — `result: false` means the test ran and the server passed. This matters for our parser: we enrich the Endpoint node with capability flags regardless of `result`, and only create `Vulnerability` nodes when `result: true`.

### Full test catalog (graphql-cop 1.14 — field_duplication is disabled per issue #43)

| Internal key | **Exact `title` string (copy-paste verbatim)** | Severity | Impact class | Heavy traffic? |
|---|---|---|---|---|
| `field_suggestions` | `Field Suggestions` | LOW | Info Leak | No |
| `introspection` | `Introspection` | HIGH | Info Leak | No |
| `detect_graphiql` | `GraphQL IDE` | LOW | Info Leak | No |
| `get_method_support` | `GET Method Query Support` | **MEDIUM** (CSRF) | CSRF | No |
| `alias_overloading` | `Alias Overloading` | HIGH | DoS | **YES** (101 aliases per query) |
| `batch_query` | `Array-based Query Batching` | HIGH | DoS | **YES** (10+ queries per array) |
| `trace_mode` | `Trace Mode` | INFO | Info Leak | No |
| `directive_overloading` | `Directive Overloading` | HIGH | DoS | **YES** (10+ directives) |
| `circular_query_introspection` | `Introspection-based Circular Query` | HIGH | DoS | **YES** (deep nested introspection) |
| `get_based_mutation` | `Mutation is allowed over GET (possible CSRF)` | **MEDIUM** | CSRF | No |
| `post_based_csrf` | `POST based url-encoded query (possible CSRF)` | MEDIUM | CSRF | No |
| `unhandled_error_detection` | `Unhandled Errors Detection` | **INFO** | Info Leak | No |

**⚠️ All `title` strings above are verified verbatim from graphql-cop 1.14 source** (`lib/tests/*.py`). They are the discriminator used to map JSON output back to our internal `vulnerability_type`. Any character mismatch breaks the parser silently (finding gets logged as "Unknown test title" and dropped).

---

## 17.2 Integration pattern — Docker-in-Docker

Mirror [recon/port_scan.py](recon/port_scan.py) (Naabu) or [recon/vuln_scan.py](recon/vuln_scan.py) (Nuclei).

**New Python module**: `recon/graphql_scan/misconfig.py` — wraps the docker invocation, parses JSON, normalizes findings.

### 17.2.a Add to [recon/entrypoint.sh](recon/entrypoint.sh) IMAGES array

Append to the existing list (around line 133-144):
```bash
IMAGES=(
  "projectdiscovery/naabu:latest"
  ...
  "dolevf/graphql-cop:1.14"     # ← added
)
```
This ensures the image is pre-pulled on recon container startup (saves cold-start time on first scan).

### 17.2.b Wrapper function signature

File: `recon/graphql_scan/misconfig.py`

```python
from typing import Dict, List, Optional
import json
import subprocess
from datetime import datetime, timezone

DEFAULT_IMAGE = 'dolevf/graphql-cop:1.14'

GRAPHQL_COP_TEST_TO_VULN_TYPE = {
    'field_suggestions':           'graphql_field_suggestions_enabled',
    'introspection':               'graphql_introspection_enabled',      # dedupes with PR's native check
    'detect_graphiql':             'graphql_ide_exposed',
    'get_method_support':          'graphql_get_method_allowed',
    'alias_overloading':           'graphql_alias_overloading',
    'batch_query':                 'graphql_batch_query_allowed',
    'trace_mode':                  'graphql_tracing_enabled',
    'directive_overloading':       'graphql_directive_overloading',
    'circular_query_introspection':'graphql_circular_introspection',
    'get_based_mutation':          'graphql_get_based_mutation',
    'post_based_csrf':             'graphql_post_csrf',
    'unhandled_error_detection':   'graphql_unhandled_error',
}

# Tests that are always active DoS probes — never run unless explicitly enabled AND not in safe/stealth mode
HEAVY_TRAFFIC_TESTS = {
    'alias_overloading',
    'batch_query',
    'directive_overloading',
    'circular_query_introspection',
}

# Title → internal key (graphql-cop's JSON discriminates by `title`, not by key)
# Every string here is copy-pasted VERBATIM from graphql-cop 1.14 source at
# github.com/dolevf/graphql-cop/blob/main/lib/tests/*.py — re-verify on version bumps.
TITLE_TO_KEY = {
    'Field Suggestions':                              'field_suggestions',
    'Introspection':                                  'introspection',
    'GraphQL IDE':                                    'detect_graphiql',
    'GET Method Query Support':                       'get_method_support',
    'Alias Overloading':                              'alias_overloading',
    'Array-based Query Batching':                     'batch_query',
    'Trace Mode':                                     'trace_mode',
    'Directive Overloading':                          'directive_overloading',
    'Introspection-based Circular Query':             'circular_query_introspection',
    'Mutation is allowed over GET (possible CSRF)':   'get_based_mutation',
    'POST based url-encoded query (possible CSRF)':   'post_based_csrf',
    'Unhandled Errors Detection':                     'unhandled_error_detection',
}


def run_graphql_cop(
    endpoint: str,
    auth_headers: Dict[str, str],
    settings: dict,
    timeout: int = 120,
) -> Optional[List[dict]]:
    """
    Invoke graphql-cop in a Docker container against one endpoint.

    Returns a list of normalized findings (RedAmon Vulnerability dict shape), or None
    on execution error (logged + swallowed — does not kill the parent scan).
    """
    if not settings.get('GRAPHQL_COP_ENABLED', False):
        print(f"[-][GraphQL-Cop] Disabled — skipping {endpoint}")
        return None

    # Assemble the excluded-tests list from per-test toggles
    excluded = _build_excluded_tests(settings)

    image = settings.get('GRAPHQL_COP_DOCKER_IMAGE', DEFAULT_IMAGE)

    # NETWORK MODE: match the existing Nuclei spawn pattern in recon/vuln_scan.py
    # — do NOT hardcode '--network host' here. Docker-in-Docker with host networking
    # uses the DOCKER HOST's network namespace, not the recon container's, which can
    # break reachability to internal targets visible only to the compose network.
    # Copy the exact --network flag Nuclei uses.
    network_flags = _nuclei_compatible_network_flags()   # helper that reads what vuln_scan.py uses

    cmd = ['docker', 'run', '--rm', *network_flags, image,
           '-t', endpoint, '-o', 'json']

    if excluded:
        cmd += ['-e', ','.join(excluded)]

    if settings.get('GRAPHQL_COP_FORCE_SCAN', False):
        cmd.append('-f')

    if settings.get('GRAPHQL_COP_DEBUG', False):
        cmd.append('-d')

    # Auth headers — one -H per header, as JSON-encoded dict
    for k, v in auth_headers.items():
        cmd += ['-H', json.dumps({k: v})]

    # Tor routing (reuse project-level toggle)
    if settings.get('USE_TOR_FOR_RECON', False):
        cmd.append('-T')

    # Proxy (reuse project-level HTTP_PROXY if set)
    proxy = settings.get('HTTP_PROXY')
    if proxy:
        cmd += ['-x', proxy]

    print(f"[*][GraphQL-Cop] Running against {endpoint} (image={image}, exclude={excluded or 'none'})")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        print(f"[!][GraphQL-Cop] Timeout after {timeout}s against {endpoint}")
        return None
    except FileNotFoundError:
        print(f"[!][GraphQL-Cop] 'docker' binary not found — is Docker socket mounted?")
        return None

    if result.returncode != 0:
        print(f"[!][GraphQL-Cop] Non-zero exit ({result.returncode}): {result.stderr[:500]}")

    # graphql-cop may print human messages to stdout BEFORE the JSON array,
    # e.g. "https://x/graphql does not seem to be running GraphQL. (Consider using -f...)"
    # then "[]" on the next line when is_graphql() fails and force=False.
    # Extract the last JSON array from stdout rather than assuming it starts at char 0.
    findings_raw = _extract_json_array(result.stdout)
    if findings_raw is None:
        print(f"[!][GraphQL-Cop] No parseable JSON in output. First 300 chars: {result.stdout[:300]}")
        return None

    if not findings_raw:
        # Valid JSON but empty — typically means graphql-cop decided the endpoint
        # isn't GraphQL and force_scan was off. Log and return empty findings.
        print(f"[-][GraphQL-Cop] {endpoint}: graphql-cop saw no GraphQL. Use GRAPHQL_COP_FORCE_SCAN=true to override.")
        return []

    return _normalize_findings(endpoint, findings_raw, settings)


def _extract_json_array(stdout: str) -> Optional[list]:
    """
    Robustly extract the final JSON array from graphql-cop stdout, tolerating
    leading informational messages (e.g. '<url> does not seem to be running GraphQL').
    Returns None if no JSON array can be parsed.
    """
    stdout = stdout.strip()
    if not stdout:
        return None

    # Fast path: stdout starts with '['
    if stdout.startswith('['):
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            pass

    # Slow path: find the last '[' that begins a parseable JSON array.
    # graphql-cop always emits a single top-level array via print(dumps(json_output)).
    last_bracket = stdout.rfind('\n[')
    if last_bracket != -1:
        candidate = stdout[last_bracket + 1:]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # Final fallback: attempt from the first '[' to end.
    first_bracket = stdout.find('[')
    if first_bracket != -1:
        try:
            return json.loads(stdout[first_bracket:])
        except json.JSONDecodeError:
            pass

    return None


def _build_excluded_tests(settings: dict) -> List[str]:
    """Convert per-test toggles to graphql-cop's -e list (tests to SKIP)."""
    excluded = []
    # Each toggle defaults to True (test runs). If disabled → add to excluded.
    toggle_map = {
        'field_suggestions':           'GRAPHQL_COP_TEST_FIELD_SUGGESTIONS',
        'introspection':               'GRAPHQL_COP_TEST_INTROSPECTION',
        'detect_graphiql':             'GRAPHQL_COP_TEST_GRAPHIQL',
        'get_method_support':          'GRAPHQL_COP_TEST_GET_METHOD',
        'alias_overloading':           'GRAPHQL_COP_TEST_ALIAS_OVERLOADING',
        'batch_query':                 'GRAPHQL_COP_TEST_BATCH_QUERY',
        'trace_mode':                  'GRAPHQL_COP_TEST_TRACE_MODE',
        'directive_overloading':       'GRAPHQL_COP_TEST_DIRECTIVE_OVERLOADING',
        'circular_query_introspection':'GRAPHQL_COP_TEST_CIRCULAR_INTROSPECTION',
        'get_based_mutation':          'GRAPHQL_COP_TEST_GET_MUTATION',
        'post_based_csrf':             'GRAPHQL_COP_TEST_POST_CSRF',
        'unhandled_error_detection':   'GRAPHQL_COP_TEST_UNHANDLED_ERROR',
    }
    for key, setting_name in toggle_map.items():
        if not settings.get(setting_name, True):
            excluded.append(key)
    return excluded


def _normalize_findings(endpoint: str, raw_findings: List[dict], settings: dict) -> List[dict]:
    """
    Convert graphql-cop JSON into RedAmon's Vulnerability dict shape
    (matches normalizers.py from the PR).
    """
    normalized = []
    for f in raw_findings:
        title = f.get('title', '')
        key = TITLE_TO_KEY.get(title)
        if not key:
            # Unknown title — graphql-cop added a new test. Log and skip.
            print(f"[!][GraphQL-Cop] Unknown test title: {title}")
            continue

        vuln_type = GRAPHQL_COP_TEST_TO_VULN_TYPE[key]

        # Record capability flags on the endpoint regardless of result
        # (consumed later by the mixin; see §17.6)
        # — stored in a sidecar dict returned alongside
        # Only create Vulnerability nodes for result=True
        if not f.get('result'):
            continue

        severity = _map_severity(f.get('severity', 'INFO'))

        normalized.append({
            'vulnerability_type': vuln_type,
            'severity': severity,
            'endpoint': endpoint,
            'title': title,
            'description': f.get('description', ''),
            'impact': f.get('impact', ''),
            'source': 'graphql_cop',
            'evidence': {
                'curl_verify': f.get('curl_verify', ''),
                'raw_severity': f.get('severity', ''),
                'color': f.get('color', ''),
                'graphql_cop_key': key,
            },
            'timestamp': datetime.now(timezone.utc).isoformat(),
        })

    return normalized


def _map_severity(graphql_cop_sev: str) -> str:
    """Map graphql-cop severity to RedAmon's canonical lowercase scale."""
    return {
        'HIGH':   'high',
        'MEDIUM': 'medium',
        'LOW':    'low',
        'INFO':   'info',
    }.get(graphql_cop_sev.upper(), 'low')
```

### 17.2.c Call site — `recon/graphql_scan/scanner.py`

Inside `test_single_endpoint()`, **after** the existing introspection block, **before** the return, add:

```python
# graphql-cop pass (if enabled)
if settings.get('GRAPHQL_COP_ENABLED', False):
    from recon.graphql_scan.misconfig import run_graphql_cop
    cop_findings = run_graphql_cop(
        endpoint,
        auth_headers,
        settings,
        timeout=settings.get('GRAPHQL_COP_TIMEOUT', 120),
    )
    if cop_findings:
        result['vulnerabilities'].extend(cop_findings)
        # Also stash raw list so the mixin can compute endpoint capability flags (§17.6)
        result['endpoint_data']['graphql_cop_raw'] = cop_findings
```

The existing `ThreadPoolExecutor(max_workers=GRAPHQL_CONCURRENCY)` handles per-endpoint fan-out. graphql-cop's 12 tests run sequentially inside its container — don't try to parallelize them separately.

### 17.2.d Docker socket access

Recon container needs `/var/run/docker.sock` mounted to spawn graphql-cop. Verify in [docker-compose.yml](docker-compose.yml) that the `recon` service already has this mount (it does — Naabu/Nuclei/Katana all require it). **No compose change needed.**

---

## 17.3 Settings (new keys — extends §3.1 Prisma + [recon/project_settings.py](recon/project_settings.py))

### 17.3.a Add to `DEFAULT_SETTINGS` in [recon/project_settings.py](recon/project_settings.py)

```python
# GraphQL Cop (external misconfig scanner)
'GRAPHQL_COP_ENABLED': False,             # master toggle (default off — opt-in)
'GRAPHQL_COP_DOCKER_IMAGE': 'dolevf/graphql-cop:1.14',
'GRAPHQL_COP_TIMEOUT': 120,               # seconds per endpoint
'GRAPHQL_COP_FORCE_SCAN': False,          # -f flag — scan even if endpoint doesn't look GraphQL
'GRAPHQL_COP_DEBUG': False,               # -d flag — adds X-GraphQL-Cop-Test header per request

# Per-test toggles (True = run, False = exclude via -e)
'GRAPHQL_COP_TEST_FIELD_SUGGESTIONS': True,
'GRAPHQL_COP_TEST_INTROSPECTION': False,  # off by default — PR's native test already covers this
'GRAPHQL_COP_TEST_GRAPHIQL': True,
'GRAPHQL_COP_TEST_GET_METHOD': True,
'GRAPHQL_COP_TEST_ALIAS_OVERLOADING': True,   # DoS — but high-signal for pros
'GRAPHQL_COP_TEST_BATCH_QUERY': True,         # DoS
'GRAPHQL_COP_TEST_TRACE_MODE': True,
'GRAPHQL_COP_TEST_DIRECTIVE_OVERLOADING': True,  # DoS
'GRAPHQL_COP_TEST_CIRCULAR_INTROSPECTION': True, # DoS
'GRAPHQL_COP_TEST_GET_MUTATION': True,
'GRAPHQL_COP_TEST_POST_CSRF': True,
'GRAPHQL_COP_TEST_UNHANDLED_ERROR': True,
```

→ **18 new keys total.**

### 17.3.b Mirror in `fetch_project_settings()`

One `settings['X'] = project.get('xField', DEFAULT_SETTINGS['X'])` line per key. Same pattern as §3 Phase 1.

### 17.3.c Extend `apply_stealth_overrides()` (existing function)

In stealth mode, disable all DoS probes:
```python
# --- GraphQL Cop: disable DoS probes in stealth mode ---
settings['GRAPHQL_COP_TEST_ALIAS_OVERLOADING']    = False
settings['GRAPHQL_COP_TEST_BATCH_QUERY']          = False
settings['GRAPHQL_COP_TEST_DIRECTIVE_OVERLOADING']= False
settings['GRAPHQL_COP_TEST_CIRCULAR_INTROSPECTION']= False
# leave info-leak + CSRF tests enabled — they're low-traffic
```

### 17.3.d Prisma schema (extend §3.1 block)

Add to [webapp/prisma/schema.prisma](webapp/prisma/schema.prisma):

```prisma
graphqlCopEnabled                   Boolean @default(false) @map("graphql_cop_enabled")
graphqlCopDockerImage               String  @default("dolevf/graphql-cop:1.14") @map("graphql_cop_docker_image")
graphqlCopTimeout                   Int     @default(120)   @map("graphql_cop_timeout")
graphqlCopForceScan                 Boolean @default(false) @map("graphql_cop_force_scan")
graphqlCopDebug                     Boolean @default(false) @map("graphql_cop_debug")
graphqlCopTestFieldSuggestions      Boolean @default(true)  @map("graphql_cop_test_field_suggestions")
graphqlCopTestIntrospection         Boolean @default(false) @map("graphql_cop_test_introspection")
graphqlCopTestGraphiql              Boolean @default(true)  @map("graphql_cop_test_graphiql")
graphqlCopTestGetMethod             Boolean @default(true)  @map("graphql_cop_test_get_method")
graphqlCopTestAliasOverloading      Boolean @default(true)  @map("graphql_cop_test_alias_overloading")
graphqlCopTestBatchQuery            Boolean @default(true)  @map("graphql_cop_test_batch_query")
graphqlCopTestTraceMode             Boolean @default(true)  @map("graphql_cop_test_trace_mode")
graphqlCopTestDirectiveOverloading  Boolean @default(true)  @map("graphql_cop_test_directive_overloading")
graphqlCopTestCircularIntrospection Boolean @default(true)  @map("graphql_cop_test_circular_introspection")
graphqlCopTestGetMutation           Boolean @default(true)  @map("graphql_cop_test_get_mutation")
graphqlCopTestPostCsrf              Boolean @default(true)  @map("graphql_cop_test_post_csrf")
graphqlCopTestUnhandledError        Boolean @default(true)  @map("graphql_cop_test_unhandled_error")
```

Then `docker compose exec webapp npx prisma db push && npx prisma generate`.

---

## 17.4 Graph DB — extend the existing mixin (no new node labels)

File: [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) — extend `update_graph_from_graphql_scan()` already written by PR + §6.4.

### 17.4.a New Endpoint capability flags (boolean properties)

Set these on the Endpoint node based on the raw graphql-cop results (not just `result=True`):

```python
cop_raw = endpoint_info.get('graphql_cop_raw', [])
if cop_raw:
    flag_by_key = {
        'detect_graphiql':      'graphql_graphiql_exposed',
        'trace_mode':           'graphql_tracing_enabled',
        'get_method_support':   'graphql_get_allowed',
        'field_suggestions':    'graphql_field_suggestions_enabled',
        'batch_query':          'graphql_batching_enabled',
    }
    for finding in cop_raw:
        key = finding.get('evidence', {}).get('graphql_cop_key')
        flag = flag_by_key.get(key)
        if flag is not None:
            graphql_props[flag] = bool(finding.get('result', False))
```

Add these 5 properties to the Endpoint `SET` clause.

### 17.4.b Vulnerability nodes — reuse existing pattern

Each graphql-cop finding where `result=True` becomes a `Vulnerability` node with the shape already handled in PR's existing loop. The deterministic ID pattern `graphql_{type}_{baseurl}_{path}` dedupes cleanly: if PR's native introspection check AND graphql-cop's introspection test both fire on the same endpoint, the same ID is generated → `MERGE` updates one node instead of creating two.

**Source differentiation**: set `v.source = 'graphql_cop'` (vs `'graphql_scan'` for the PR's native checks). Reports and queries can filter with `WHERE v.source IN ['graphql_scan', 'graphql_cop']`.

### 17.4.c MERGE-key caveat

For the introspection dedup to work, the deterministic ID must use **only** the tool-agnostic `(vulnerability_type, baseurl, path)` — NOT including `source` in the ID. Verify PR's existing ID construction at [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) line 136 does this. If `source` is in the ID → fix before merging §17.

---

## 17.5 Frontend section — extend `GraphqlScanSection.tsx`

Add a **collapsible sub-section** inside [webapp/src/components/projects/ProjectForm/sections/GraphqlScanSection.tsx](webapp/src/components/projects/ProjectForm/sections/GraphqlScanSection.tsx) (created in §4.1) titled "graphql-cop misconfig scanner (external)". Mirror the collapsible pattern from [webapp/src/components/projects/ProjectForm/sections/JsReconSection.tsx](webapp/src/components/projects/ProjectForm/sections/JsReconSection.tsx) "Detection modules" block (lines 539-603).

Layout:
```tsx
<div className={styles.subSection}>
  <h3 onClick={() => setCopExpanded(!copExpanded)}>
    graphql-cop External Scanner
    <span className={styles.badgeActive}>Active</span>
    <span className={styles.infoBadge}>12 checks</span>
  </h3>
  {copExpanded && (
    <>
      <Toggle label="Enable graphql-cop"
              checked={data.graphqlCopEnabled}
              onChange={v => updateField('graphqlCopEnabled', v)} />

      {data.graphqlCopEnabled && (
        <>
          <div>Docker image: <input ... value={data.graphqlCopDockerImage} /></div>
          <div>Timeout (s): <input type="number" ... /></div>
          <Toggle label="Force scan even if endpoint isn't GraphQL-like" ... />
          <Toggle label="Debug mode (adds X-GraphQL-Cop-Test header)" ... />

          <h4>Checks to run (uncheck to skip)</h4>
          <div className={styles.testGrid}>
            <Toggle label="Field Suggestions (info leak, LOW)"         field="graphqlCopTestFieldSuggestions" />
            <Toggle label="Introspection (dedupe with native, off by default)"
                                                                       field="graphqlCopTestIntrospection" />
            <Toggle label="GraphiQL / Playground IDE (info leak, LOW)" field="graphqlCopTestGraphiql" />
            <Toggle label="GET method queries (CSRF, INFO)"            field="graphqlCopTestGetMethod" />
            <Toggle label="GET-based mutations (CSRF, HIGH)"           field="graphqlCopTestGetMutation" />
            <Toggle label="POST url-encoded CSRF (MEDIUM)"             field="graphqlCopTestPostCsrf" />
            <Toggle label="Trace mode (info leak, INFO)"               field="graphqlCopTestTraceMode" />
            <Toggle label="Unhandled errors (info leak, LOW)"          field="graphqlCopTestUnhandledError" />
            <hr /> <em>DoS probes — noisy, disabled in stealth mode automatically:</em>
            <Toggle label="Alias overloading (101 aliases, HIGH)"      field="graphqlCopTestAliasOverloading" />
            <Toggle label="Batch query (array of 10, HIGH)"            field="graphqlCopTestBatchQuery" />
            <Toggle label="Directive overloading (HIGH)"               field="graphqlCopTestDirectiveOverloading" />
            <Toggle label="Circular introspection (HIGH)"              field="graphqlCopTestCircularIntrospection" />
          </div>
        </>
      )}
    </>
  )}
</div>
```

**UX notes**:
- Default-off master toggle forces opt-in (graphql-cop adds traffic).
- DoS probes are visually grouped below a divider with a clear "noisy" label.
- Info banner at the top: `"graphql-cop is an external Docker-based scanner. Enables 12 misconfiguration checks including alias/batch DoS probes, CSRF vectors, and GraphiQL detection. Traffic is active — respect RoE."`

---

## 17.6 Report pipeline — extend §7 additions

### 17.6.a `reportData.ts` — broaden the source filter

File: [webapp/src/lib/report/reportData.ts](webapp/src/lib/report/reportData.ts)

In `queryGraphql()` (created in §7.1), the Cypher `WHERE` clause must accept both sources:
```cypher
MATCH (v:Vulnerability) WHERE v.source IN ['graphql_scan', 'graphql_cop']
                          AND v.project_id = $pid
```

Extend `GraphqlFindingRecord` interface with one new field:
```ts
interface GraphqlFindingRecord {
  ...existing fields...
  source: 'graphql_scan' | 'graphql_cop'
  curlVerify?: string          // graphql-cop reproducer cURL
}
```

### 17.6.b Risk score tuning

Adjust `rawRisk` weights (§7.1 point 5) to recognize graphql-cop's DoS-class findings:
```ts
const graphqlScore =
  data.graphqlScan.bySeverity.critical * 60 +
  data.graphqlScan.bySeverity.high * 30 +        // alias/batch/directive/circular all land here
  data.graphqlScan.bySeverity.medium * 10 +
  data.graphqlScan.bySeverity.low * 3 +
  data.graphqlScan.bySeverity.info * 1            // add info tier — graphql-cop emits several INFO findings
```

### 17.6.c Template — surface the cURL reproducer

File: [webapp/src/lib/report/reportTemplate.ts](webapp/src/lib/report/reportTemplate.ts) — in `renderGraphqlScan()` (§7.2), when a finding has `source='graphql_cop'`, also render a `<pre>` block with its `curlVerify` command. This is the pentester's single biggest value-add — they can paste the cURL straight into Burp Repeater.

```html
<details>
  <summary>Reproduce (cURL)</summary>
  <pre class="curl">${esc(finding.curlVerify)}</pre>
</details>
```

### 17.6.d `condenseForAgent` — no new shape needed

The existing §7.3 payload already passes `bySeverity` + top 15 findings. graphql-cop findings flow through the same interface — no new fields required.

---

## 17.7 Presets — add per-test toggles where relevant

File: [webapp/src/lib/recon-presets/presets/*.ts](webapp/src/lib/recon-presets/presets/) — extends §8 decision table.

| Preset | `graphqlCopEnabled` | DoS probes |
|---|---|---|
| `api-security.ts` | **true** | All enabled (API pentests need DoS signals) |
| `web-app-pentester.ts` | **true** | All enabled |
| `bug-bounty-quick.ts` | true | Info-leak + CSRF only (DoS off) |
| `bug-bounty-deep.ts` | true | All enabled |
| `full-active-scan.ts`, `full-maximum-scan.ts` | true | All enabled |
| `red-team-operator.ts` | true | **DoS off** (low-noise ops) |
| `stealth-recon.ts` | true | DoS off (mirrors stealth_overrides) |
| `compliance-audit.ts` | true | DoS off (read-only audit) |
| `parameter-injection.ts`, `cve-hunter.ts` | true (defaults) | — |
| `full-passive-scan.ts`, `osint-investigator.ts`, `dns-email-security.ts`, `secret-miner.ts`, `secret-hunter.ts`, `subdomain-takeover.ts`, `infrastructure-mapper.ts`, `directory-discovery.ts`, `cloud-exposure.ts`, `large-network.ts` | **false** | N/A |

Also update:
- `webapp/src/lib/recon-preset-schema.ts` — 18 new Zod field definitions matching the Prisma block.
- `webapp/src/app/api/presets/generate/route.ts` — 18 new entries in `RECON_PARAMETER_CATALOG` with descriptions, so the AI preset generator knows about them.
- Tests in `recon-preset-schema.test.ts` and `recon-presets.test.ts` — bump expected key counts.

---

## 17.8 No change to — Workflow view, colors, graph page, partial recon, section index

graphql-cop runs **inside** the existing `GraphqlScan` tool (same id, same toggle, same partial-recon handler). It is **not** a separate workflow node.

Verify by the following are unchanged from §5:
- `WORKFLOW_TOOLS` entry (same `GraphqlScan` id) — ✅ no change
- `nodeMapping.ts` (same inputs/outputs — graphql-cop still reads BaseURL/Endpoint, writes Vulnerability/Endpoint) — ✅ no change
- `WorkflowNodeModal.tsx` switch — ✅ no change (still routes to `GraphqlScanSection`)
- `graph_builders.py` `_build_graphql_data_from_graph()` (§9.1.c) — ✅ no change (graphql-cop needs no extra graph data; it gets endpoints + auth headers, same as the native scanner)
- `PartialReconModal.tsx` — ✅ no change (graphql-cop inherits the partial-recon plumbing already set up in §9.6; if the user enables `GraphqlScan` via partial recon and `graphqlCopEnabled=true`, graphql-cop runs as part of the same partial execution)
- Colors, node sizes, DataTableToolbar, PageBottomBar — ✅ no change (no new labels)

---

## 17.9 Logging format

All log lines use `[*|+|-|!][GraphQL-Cop]` prefix — follows the same `[symbol][ToolName]` convention as the rest of the pipeline (§11). Example:

```
[*][GraphQL-Cop] Running against https://api.target.com/graphql (image=dolevf/graphql-cop:1.14, exclude=none)
[+][GraphQL-Cop] 5 findings (3 HIGH, 2 LOW)
[!][GraphQL-Cop] Timeout after 120s against https://stage.target.com/graphql
```

---

## 17.10 Testing

### 17.10.a Unit tests (Python)

File: `recon/tests/test_graphql_cop.py` (new).

1. `test_build_excluded_tests` — per-test toggles correctly produce the `-e` comma list.
2. `test_normalize_findings_all_false` — 12 results with `result=False` → empty vuln list, but endpoint capability flags set.
3. `test_normalize_findings_partial_true` — mixed results → correct Vulnerability dicts with correct `vulnerability_type`, `severity`, `source='graphql_cop'`.
4. `test_unknown_title_skipped` — if a future graphql-cop version adds a test, unknown titles are logged and skipped (no crash).
5. `test_subprocess_timeout` — mocked `subprocess.run` raises `TimeoutExpired` → function returns `None`, no exception propagates.
6. `test_invalid_json_output` — malformed stdout → function returns `None`.
7. `test_severity_mapping` — HIGH/MEDIUM/LOW/INFO correctly map to lowercase canonical values.

Mock `subprocess.run` via `unittest.mock.patch` to avoid needing real Docker in CI.

### 17.10.b Integration smoke test

Spin up [DVGA](https://github.com/dolevf/Damn-Vulnerable-GraphQL-Application) (also by `dolevf`) in CI or locally:
```bash
docker run --rm -p 5013:5013 dolevf/dvga
```
Then run the scanner against `http://localhost:5013/graphql` — all 12 findings should fire `result=True` (DVGA is intentionally vulnerable to every check). Assert the RedAmon scan produces ≥10 Vulnerability nodes tagged `source='graphql_cop'`.

### 17.10.c TypeScript tests

Update [webapp/src/lib/recon-preset-schema.test.ts](webapp/src/lib/recon-preset-schema.test.ts) — expected key count bumps by 18.

---

## 17.11 Schema sync (per `PROMPT.ADD_RECON_TOOL.md`)

### 17.11.a [readmes/GRAPH.SCHEMA.md](readmes/GRAPH.SCHEMA.md)

Under the Endpoint properties table, append the 5 new capability flags:
| `graphql_graphiql_exposed` | Boolean | GraphiQL/Playground IDE detected at this endpoint |
| `graphql_tracing_enabled` | Boolean | Apollo tracing extension enabled |
| `graphql_get_allowed` | Boolean | GraphQL queries accepted via GET (CSRF vector) |
| `graphql_field_suggestions_enabled` | Boolean | "Did you mean" field suggestions exposed |
| `graphql_batching_enabled` | Boolean | Array-batched queries accepted |

Under the Vulnerability node section, add a `source='graphql_cop'` bullet listing the 12 new `vulnerability_type` values.

### 17.11.b [agentic/prompts/base.py](agentic/prompts/base.py) — `TEXT_TO_CYPHER_SYSTEM`

Append the 5 new Endpoint properties and the 12 new vulnerability_type values. The agent needs these to answer queries like "which endpoints have GraphiQL exposed?" or "list all alias-overloading findings".

### 17.11.c Colors / filters / legend — no changes

Existing Vulnerability coloring covers all new findings. No `NODE_COLORS` / `NODE_SIZES` / `DataTableToolbar` / `PageBottomBar` edits.

---

## 17.12 Build & deploy sequence (after §1-§16 are live)

```bash
# 1. Prisma schema (17.3.d)
docker compose exec webapp npx prisma db push
docker compose exec webapp npx prisma generate

# 2. Pre-pull image so first scan isn't cold
docker pull dolevf/graphql-cop:1.14

# 3. Rebuild recon container (picks up entrypoint.sh IMAGES change + new misconfig.py)
docker compose --profile tools build recon

# 4. Rebuild agent (picks up agentic/prompts/base.py update)
docker compose build agent && docker compose up -d agent

# 5. Webapp: dev hot-reload picks up section + report template changes.
#    In prod:
docker compose build webapp && docker compose up -d webapp
```

**No orchestrator restart needed** — `/defaults` dynamically iterates `DEFAULT_SETTINGS` so the 18 new keys are served automatically.

---

## 17.12.b Deep-review audit log (items verified against actual graphql-cop 1.14 source)

Every claim below was re-checked against `github.com/dolevf/graphql-cop@main` source tree before this plan section was finalized. Re-run these checks on any image bump.

| Claim | How verified | Status |
|---|---|---|
| CLI flag set (`-t`, `-H`, `-o`, `-e`, `-l`, `-f`, `-d`, `-x`, `-w`, `-T`, `-v`) | Read `graphql-cop.py` entrypoint | ✅ exact |
| `-o` only supports `json` | Read parser + output branch (`if options.format == 'json': print(dumps(json_output))`) | ✅ exact |
| `-H` is repeatable, each is its own JSON dict merged into HEADERS | Read `optparse` `action='append'` + the header-parsing loop | ✅ exact |
| `-e` takes comma-separated internal keys from the `tests` dict | Read `options.excluded_tests.split(',')` + the `del tests[k]` loop | ✅ exact |
| Registered tests (12 — `field_duplication` disabled per issue #43) | Read `lib/tests/__init__.py` registry | ✅ exact |
| 12 test `title` strings | Read each `lib/tests/*.py` — TITLE_TO_KEY in §17.2.b is verbatim | ✅ exact |
| Per-test `severity` (HIGH/MEDIUM/LOW/INFO) | Read each test file's `res` dict | ✅ corrected in §17.1 catalog |
| Output is pure JSON via `json.dumps`, no `pprint` | Main script imports `from json import loads, dumps` + calls `dumps(json_output)` | ✅ exact |
| But: leading "does not seem to be running" text message can precede the JSON when `-f` is off | Read the `for path in paths: if not is_graphql(...): print(...); continue` branch | ✅ handled via `_extract_json_array()` |
| Default endpoint wordlist (`/`, `/graphiql`, `/playground`, `/console`, `/graphql`) | Read `endpoints = [...]` in entrypoint | ✅ exact (we bypass it — we pass explicit URLs) |
| Dockerfile entrypoint is `python graphql-cop.py` (accepts script args directly) | Read `Dockerfile` `ENTRYPOINT ["python", "graphql-cop.py"]` | ✅ matches our `docker run ... image -t ... -o json` |
| `requests==2.25.1` is pinned | Read `requirements.txt` | ✅ confirms Docker-in-Docker is mandatory |
| DockerHub image exists at `dolevf/graphql-cop:1.14` | WebFetch of `hub.docker.com/r/dolevf/graphql-cop` | ✅ confirmed |
| No `:latest` moving tag promise (only `1.14` as of 2026-04-20) | Same | ✅ — pin to `1.14` |
| `--network host` would use the DOCKER HOST net, not the recon container net | Docker behavior; not graphql-cop specific | ⚠️ — §17.2.b now defers to Nuclei's flag pattern instead of hardcoding |
| Exit code 0 on normal completion regardless of findings | Read entrypoint: no `sys.exit(nonzero)` based on findings | ✅ exact — must parse JSON to know results |

---

## 17.13 Verification checklist

- [ ] `docker run --rm dolevf/graphql-cop:1.14 -l` lists all 12 test keys matching `TITLE_TO_KEY` mapping.
- [ ] Unit tests (§17.10.a) pass.
- [ ] DVGA smoke test (§17.10.b): scan produces ≥10 new Vulnerability nodes with `source='graphql_cop'`.
- [ ] Introspection dedup: scan an endpoint with both `graphqlSecurityEnabled=true` AND `graphqlCopTestIntrospection=true` → Neo4j has exactly **one** `graphql_introspection_enabled` Vulnerability node per (baseurl, path), not two.
- [ ] Endpoint enrichment: after scan against DVGA, `MATCH (e:Endpoint {is_graphql: true}) RETURN e.graphql_graphiql_exposed, e.graphql_tracing_enabled, e.graphql_get_allowed, e.graphql_field_suggestions_enabled, e.graphql_batching_enabled` — all 5 flags populated.
- [ ] Per-test toggles: disable `GRAPHQL_COP_TEST_ALIAS_OVERLOADING` → re-scan DVGA → no `graphql_alias_overloading` Vulnerability node created.
- [ ] Stealth mode: `stealthMode=true` → re-scan → 4 DoS `vulnerability_type`s NOT present (alias/batch/directive/circular).
- [ ] Report: HTML report renders the cURL reproducer for each graphql-cop finding. Collapsible `<details>` blocks expand correctly.
- [ ] AI preset: generate an "API security audit" preset → includes `graphqlCopEnabled: true` and sensible per-test toggles.
- [ ] RoE: `ROE_EXCLUDED_HOSTS` still filters graphql-cop targets (filtering happens in `discover_graphql_endpoints` upstream of the call to `run_graphql_cop`, so no additional work needed — verify with a test).
- [ ] Log format: all graphql-cop lines match `[symbol][GraphQL-Cop] ...`.
- [ ] Partial recon: click Play on GraphQL node → include graph targets + `graphqlCopEnabled=true` → graphql-cop runs as part of partial recon without code changes to partial_recon_modules/graphql_scanning.py (it's invoked from the scanner, not from partial_recon).

---

## 17.14 Updated file-by-file matrix (additions on top of §14)

| File | Status | Section |
|---|---|---|
| **`recon/graphql_scan/misconfig.py`** | ❌ **Create** (~250 lines: wrapper + normalizer + mappings) | §17.2.b |
| [recon/graphql_scan/scanner.py](recon/graphql_scan/scanner.py) | ⚠️ Extend `test_single_endpoint()` with ~8-line graphql-cop call block | §17.2.c |
| [recon/entrypoint.sh](recon/entrypoint.sh) | ⚠️ Append `dolevf/graphql-cop:1.14` to IMAGES | §17.2.a |
| [recon/project_settings.py](recon/project_settings.py) | ⚠️ +18 DEFAULT_SETTINGS keys + fetch_project_settings() mapping + stealth overrides | §17.3 |
| [webapp/prisma/schema.prisma](webapp/prisma/schema.prisma) | ⚠️ +18 Prisma fields | §17.3.d |
| [graph_db/mixins/graphql_mixin.py](graph_db/mixins/graphql_mixin.py) | ⚠️ +5 Endpoint capability flags + `source='graphql_cop'` path | §17.4 |
| [webapp/src/components/projects/ProjectForm/sections/GraphqlScanSection.tsx](webapp/src/components/projects/ProjectForm/sections/GraphqlScanSection.tsx) | ⚠️ Add collapsible graphql-cop sub-section with 12 per-test toggles | §17.5 |
| [webapp/src/lib/report/reportData.ts](webapp/src/lib/report/reportData.ts) | ⚠️ Broaden `queryGraphql` source filter, add `curlVerify` to record | §17.6.a |
| [webapp/src/lib/report/reportTemplate.ts](webapp/src/lib/report/reportTemplate.ts) | ⚠️ Add `<details><pre>curl</pre></details>` block per graphql-cop finding | §17.6.c |
| [webapp/src/lib/recon-preset-schema.ts](webapp/src/lib/recon-preset-schema.ts) | ⚠️ +18 Zod field definitions | §17.7 |
| [webapp/src/app/api/presets/generate/route.ts](webapp/src/app/api/presets/generate/route.ts) | ⚠️ +18 `RECON_PARAMETER_CATALOG` entries | §17.7 |
| [webapp/src/lib/recon-presets/presets/*.ts](webapp/src/lib/recon-presets/presets/) | ⚠️ Per-preset toggle decisions (§17.7 table) | §17.7 |
| [readmes/GRAPH.SCHEMA.md](readmes/GRAPH.SCHEMA.md) | ⚠️ +5 Endpoint props + 12 vulnerability_type subtypes | §17.11.a |
| [agentic/prompts/base.py](agentic/prompts/base.py) | ⚠️ TEXT_TO_CYPHER_SYSTEM update | §17.11.b |
| `recon/tests/test_graphql_cop.py` | ❌ **Create** | §17.10.a |
| `webapp/src/lib/recon-preset-schema.test.ts` | ⚠️ Update expected key count | §17.10.c |

**Files unchanged from Phase 1** — nodeMapping.ts, workflowDefinition.ts, WorkflowNodeModal.tsx, colors.ts, DataTableToolbar.tsx, PageBottomBar.tsx, partial_recon.py, partial_recon_modules/graphql_scanning.py, partial_recon_modules/graph_builders.py, user_input_mixin.py, recon-types.ts, PartialReconModal.tsx, graph-inputs route.

---

## 17.15 Risks & gotchas specific to graphql-cop

1. **`requests` version conflict is a hard constraint.** Don't attempt `pip install graphql-cop` — it will downgrade RedAmon's `requests` and break Subfinder/Arjun/ParamSpider. Docker-in-Docker is mandatory.
2. **TITLE_TO_KEY mapping is hand-maintained.** graphql-cop's JSON output uses `title` (human-readable) as the discriminator — our code maps title→key. If graphql-cop 1.15 renames a title, our parser will log "Unknown test title" and silently drop that finding. **Mitigation**: the first unit test (§17.10.a) pins this mapping. Re-verify on every image bump.
3. **Image tag pinning**: DockerHub lags the git repo. `dolevf/graphql-cop:1.14` is what's available as of 2026-04-20. `dolevf/graphql-cop:latest` tag exists but is the same 1.14 snapshot. Don't use `:latest` — pin explicitly to catch tag drift. Allow user override via `GRAPHQL_COP_DOCKER_IMAGE` setting for security-sensitive environments that maintain their own pinned fork.
4. **DoS probes can DoS fragile targets.** Even at defaults, alias/batch/directive/circular probes send bursty traffic. On poorly-provisioned dev/staging targets, they can cause real outages. Default master toggle is `false` (opt-in); stealth mode disables all 4 automatically. Document this clearly in the section's info banner and in `readmes/ROE_POLICY.md` (if that exists — otherwise in `GRAPH.SCHEMA.md`).
5. **Introspection test is disabled by default** to dedupe with PR's native introspection check. Users enabling both will create ONE Vulnerability node per endpoint (via deterministic MERGE ID) but TWO evidence trails. Verify `graph_db/mixins/graphql_mixin.py` preserves the first-writer evidence (`ON CREATE SET`) AND the `curl_verify` from the second writer (`ON MATCH SET` for evidence.curl_verify only). If overwritten blindly, reviewers lose the PR's raw introspection response. Low-priority but document.
5b. **Severity-overwrite on dedup**: the PR's mixin uses unconditional `SET v.severity = $props.severity`, not `ON CREATE SET`. So if graphql-cop runs after the native scanner on the same endpoint, graphql-cop's HIGH overwrites the native scanner's arbitrary severity. This is **actually desirable** (graphql-cop's ratings are industry-standard) but should be noted so reviewers don't flag it as a bug. Optionally: switch to `ON CREATE SET v.severity = ... ON MATCH SET v.severity = CASE WHEN $props.severity > v.severity THEN $props.severity ELSE v.severity END` to always keep the higher severity.
6. **Docker socket exposure.** Recon container already mounts `/var/run/docker.sock`. graphql-cop runs as `USER appuser` inside its image (per its Dockerfile), so no root escalation inside that container. But socket mounting has host-escape risk in general — this is not a new exposure, just noting it.
7. **Network mode `--network host`** in the spawn command: lets graphql-cop hit internal targets the recon container can reach, but also bypasses per-container network policies. Alternative: use the recon container's network. Copy whatever pattern Nuclei uses in `recon/vuln_scan.py` for consistency — don't invent a new one.
8. **No per-request rate limit in graphql-cop.** Within a single endpoint, its tests back-to-back may exceed `ROE_GLOBAL_MAX_RPS`. The existing `GRAPHQL_RATE_LIMIT` only throttles the scanner's own introspection probes, not graphql-cop's traffic. **Mitigation**: sequential per-endpoint execution (don't fan out graphql-cop invocations), document the traffic estimate (~20-30 req/endpoint in <10s), and recommend an explicit RoE allowance for Group 6 active scanning.

---

## 17.16 Expected coverage gain (reference — repeated from prior conversation for plan completeness)

| Capability | PR #93 only | + §17 graphql-cop |
|---|---|---|
| Introspection detection | ✅ | ✅ (dedupe) |
| Schema read (when introspection on) | ✅ | ✅ |
| Sensitive field detection | ✅ | ✅ |
| Alias / batch / directive / circular DoS | ❌ | ✅ |
| Field suggestion info leak | ❌ | ✅ |
| Trace / debug mode disclosure | ❌ | ✅ |
| GraphiQL / Playground IDE exposure | ❌ | ✅ |
| GET-method queries + mutations (CSRF) | ❌ | ✅ |
| POST url-encoded CSRF | ❌ | ✅ |
| Unhandled error info leak | ❌ | ✅ |
| Schema recovery when introspection off | ❌ | ❌ (deferred — clairvoyance) |
| Pentester grade (approx) | 4/10 | 7/10 |

**Summary**: 10 new detection categories, 1 new Python module (~250 lines), zero new graph node labels, zero new relationships. All leverages the Phase 1 scaffolding.
